import assert from 'node:assert/strict'
import { test } from 'node:test'
import { economy } from '../src/config/economy'
import { EconomyEngine } from '../src/shared/economy'
import type { EconomyStore, PersistedEconomyEnvelope } from '../src/shared/economy'
import { EconomyService } from '../src/server/economy/service'
import type { EconomyConfig } from '../src/shared/types'

class MemoryEconomyStore implements EconomyStore {
  envelope: PersistedEconomyEnvelope | null = null
  saves = 0

  async load(): Promise<PersistedEconomyEnvelope | null> {
    return this.envelope
  }

  async save(envelope: PersistedEconomyEnvelope): Promise<void> {
    this.envelope = structuredClone(envelope)
    this.saves += 1
  }

  async reset(): Promise<void> {
    this.envelope = null
  }
}

const testConfig = (inventory: Record<string, number>): EconomyConfig => {
  const config = structuredClone(economy)
  config.player.startingInventory = inventory
  config.bots.count = 0
  config.caravan.intervalSeconds = 365 * 86400
  config.scenario = { ...config.scenario, shocks: [] }
  return config
}

const newEngine = (inventory: Record<string, number> = { bread: 5 }): EconomyEngine => {
  const engine = new EconomyEngine(testConfig(inventory))
  const created = engine.createPlayer('worker-1', 'Worker One')
  assert.equal(created.success, true)
  return engine
}

test('withdrawItem debits inventory and emits a real player.withdraw market event', () => {
  const engine = newEngine()
  const sequenceBefore = engine.sequence

  const result = engine.withdrawItem('worker-1', 'bread', 3)

  assert.equal(result.success, true)
  assert.equal(result.action, 'withdrawItem')
  assert.deepEqual(result.data, { itemId: 'bread', quantity: 3, remaining: 2 })
  assert.equal(result.playerId, 'worker-1')
  assert.equal(result.sequence, sequenceBefore + 1)
  assert.equal(result.events.length, 1)

  const event = result.events[0]
  assert.equal(event.type, 'player.withdraw')
  assert.equal(event.cause, 'withdrawal')
  assert.equal(event.item, 'bread')
  assert.equal(event.quantity, 3)
  assert.equal(event.before.stock, 5)
  assert.equal(event.after.stock, 2)
  assert.equal(event.actor.type, 'player')
  assert.equal(event.actor.id, 'worker-1')

  assert.equal(engine.getPlayer('worker-1')?.inventory.bread, 2)
  assert.equal(engine.eventsSince(sequenceBefore).length, 1)
  assert.equal(engine.snapshot().stats.itemsConsumed, 0)
})

test('withdrawItem refuses to overdraw and leaves state untouched', () => {
  const engine = newEngine()
  const sequenceBefore = engine.sequence

  const result = engine.withdrawItem('worker-1', 'bread', 6)

  assert.equal(result.success, false)
  assert.equal(result.error?.code, 'insufficient_inventory')
  assert.deepEqual(result.events, [])
  assert.equal(result.sequence, sequenceBefore)
  assert.equal(engine.getPlayer('worker-1')?.inventory.bread, 5)
  assert.equal(engine.sequence, sequenceBefore)
})

test('withdrawItem rejects non-positive, fractional and unsafe amounts', () => {
  const engine = newEngine()
  const sequenceBefore = engine.sequence
  const invalid = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]

  for (const amount of invalid) {
    const result = engine.withdrawItem('worker-1', 'bread', amount)
    assert.equal(result.success, false, `expected ${amount} to be rejected`)
    assert.equal(result.error?.code, 'invalid_amount')
    assert.deepEqual(result.events, [])
  }

  assert.equal(engine.getPlayer('worker-1')?.inventory.bread, 5)
  assert.equal(engine.sequence, sequenceBefore)
})

test('withdrawItem rejects unknown players and unknown items', () => {
  const engine = newEngine()
  const sequenceBefore = engine.sequence

  const ghost = engine.withdrawItem('ghost', 'bread', 1)
  assert.equal(ghost.success, false)
  assert.equal(ghost.error?.code, 'unknown_player')

  const unknownItem = engine.withdrawItem('worker-1', 'unobtainium', 1)
  assert.equal(unknownItem.success, false)
  assert.equal(unknownItem.error?.code, 'unknown_item')

  assert.equal(engine.getPlayer('worker-1')?.inventory.bread, 5)
  assert.equal(engine.sequence, sequenceBefore)
})

test('EconomyService.withdrawItem persists the debit and event through the action queue', async () => {
  const store = new MemoryEconomyStore()
  const service = await EconomyService.create({
    config: testConfig({ bread: 4 }),
    store,
  })
  await service.ensurePlayer('worker-1', 'Worker One')
  const savesBefore = store.saves

  const result = await service.withdrawItem('worker-1', 'bread', 3)

  assert.equal(result.success, true)
  assert.equal(service.snapshot().players['worker-1'].inventory.bread, 1)
  assert.equal(store.saves, savesBefore + 1)
  assert.equal(store.envelope?.state.players['worker-1'].inventory.bread, 1)
  assert.ok(
    store.envelope?.state.events.some(
      event => event.type === 'player.withdraw' && event.cause === 'withdrawal',
    ),
  )
})

test('EconomyService.withdrawItem failures do not persist or mutate', async () => {
  const store = new MemoryEconomyStore()
  const service = await EconomyService.create({
    config: testConfig({ bread: 1 }),
    store,
  })
  await service.ensurePlayer('worker-1', 'Worker One')
  const savesBefore = store.saves

  const result = await service.withdrawItem('worker-1', 'bread', 2)

  assert.equal(result.success, false)
  assert.equal(result.error?.code, 'insufficient_inventory')
  assert.equal(store.saves, savesBefore)
  assert.equal(service.snapshot().players['worker-1'].inventory.bread, 1)
})

test('EconomyService serialises concurrent withdrawals so inventory cannot overspend', async () => {
  const store = new MemoryEconomyStore()
  const service = await EconomyService.create({
    config: testConfig({ bread: 5 }),
    store,
  })
  await service.ensurePlayer('worker-1', 'Worker One')

  const [first, second] = await Promise.all([
    service.withdrawItem('worker-1', 'bread', 3),
    service.withdrawItem('worker-1', 'bread', 3),
  ])

  assert.deepEqual([first.success, second.success].sort(), [false, true])
  assert.equal(service.snapshot().players['worker-1'].inventory.bread, 2)
})
