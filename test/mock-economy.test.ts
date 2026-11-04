import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createEconomyClient, createEconomyRuntime, resolveEconomyMode } from '../src/client/economy'
import { MockEconomyClient } from '../src/client/economy/mock'
import { economy } from '../src/config/economy'

const client = (): MockEconomyClient =>
  new MockEconomyClient({ fastForwardPaceMs: 0 })

test('mock exposes the configured market on first paint', async () => {
  const mock = client()
  const snapshot = await mock.getSnapshot()

  assert.equal(snapshot.day, 1)
  assert.equal(snapshot.merchants.length, Object.keys(economy.merchants).length)
  assert.equal(snapshot.player.cash, economy.player.startingCash)
  assert.equal(snapshot.player.stamina, economy.player.stamina.max)
  assert.equal(snapshot.player.equippedTool, economy.player.startingTool)
  assert.equal(snapshot.orderBoardSupported, false)
  assert.equal(snapshot.townHealth, 'thriving')
  assert.deepEqual(await mock.getOrderBoard(), [])

  const ferro = await mock.getMerchant('ferro')
  assert.ok(ferro)
  assert.deepEqual(ferro.buys, ['iron_ore'])
  assert.ok(ferro.sells.includes('iron_ingot'))
  assert.equal(ferro.open, true)
})

test('buying moves cash, stock and inventory through the shared quote', async () => {
  const mock = client()
  const before = await mock.getSnapshot()
  const quote = await mock.getQuote('ferro', 'iron_ingot', 'buy', 1)
  assert.equal(quote.canTrade, true)
  assert.ok(quote.unitPrice > 0)

  const result = await mock.buy({ merchantId: 'ferro', itemId: 'iron_ingot', quantity: 1 })
  assert.equal(result.ok, true)
  assert.equal(result.fillQuantity, 1)
  assert.equal(result.total, quote.total)

  const after = await mock.getSnapshot()
  const ferro = await mock.getMerchant('ferro')
  assert.equal(after.player.cash, before.player.cash - result.total)
  assert.equal(
    after.player.inventory.find(line => line.itemId === 'iron_ingot')?.quantity,
    1,
  )
  assert.ok(ferro)
  assert.equal(ferro.stock.iron_ingot, 24 - 1)
  assert.ok((await mock.getEvents()).some(event => event.type === 'trade.buy'))
})

test('selling bread to Wheatley credits cash and adds merchant stock', async () => {
  const mock = client()
  const before = await mock.getSnapshot()
  const result = await mock.sell({ merchantId: 'wheatley', itemId: 'bread', quantity: 1 })
  assert.equal(result.ok, true)
  assert.ok(result.total > 0)

  const after = await mock.getSnapshot()
  const wheatley = await mock.getMerchant('wheatley')
  assert.equal(after.player.cash, before.player.cash + result.total)
  assert.equal(
    after.player.inventory.find(line => line.itemId === 'bread')?.quantity,
    1,
  )
  assert.ok(wheatley)
  assert.equal(wheatley.stock.bread, 31)
})

test('a blocked trade reports a readable reason instead of throwing', async () => {
  const mock = client()
  const result = await mock.sell({ merchantId: 'ferro', itemId: 'iron_ore', quantity: 1 })
  // Ferro buys ore, but the player starts with none.
  assert.equal(result.ok, false)
  assert.match(result.message, /do not have|none/i)
})

test('gathering spends stamina, yields the configured item and wears the tool', async () => {
  const mock = client()
  const before = await mock.getSnapshot()
  const result = await mock.gather('iron_vein')

  assert.equal(result.ok, true)
  assert.equal(result.itemId, 'iron_ore')
  assert.ok(result.quantity >= economy.resources.nodes.iron_vein.yieldRange.min)
  assert.equal(result.staminaSpent, economy.resources.nodes.iron_vein.staminaCost)
  assert.equal(result.durabilityLeft! < economy.items.pickaxe.tool!.maxDurability, true)

  const after = await mock.getSnapshot()
  assert.equal(after.player.stamina, before.player.stamina - result.staminaSpent)
  assert.ok((after.player.inventory.find(line => line.itemId === 'iron_ore')?.quantity ?? 0) > 0)
})

test('gathering without the required tool fails cleanly', async () => {
  const mock = client()
  const result = await mock.gather('wheat_field')
  assert.equal(result.ok, false)
  assert.match(result.message, /hoe/i)
})

test('crafting consumes inputs and stamina and produces outputs', async () => {
  const mock = client()
  await mock.gather('iron_vein')
  await mock.gather('iron_vein')
  const before = await mock.getSnapshot()
  const oreBefore = before.player.inventory.find(line => line.itemId === 'iron_ore')?.quantity ?? 0
  // If rolls were low we might only have 2 ore, which is exactly the recipe cost.
  assert.ok(oreBefore >= 2, `expected at least 2 ore, got ${oreBefore}`)

  const result = await mock.craft('smelt_iron_ingot')
  assert.equal(result.ok, true)
  assert.deepEqual(result.outputs, { iron_ingot: 1 })

  const after = await mock.getSnapshot()
  assert.equal(
    after.player.inventory.find(line => line.itemId === 'iron_ore')?.quantity ?? 0,
    oreBefore - 2,
  )
  assert.equal(after.player.inventory.find(line => line.itemId === 'iron_ingot')?.quantity, 1)
  assert.ok(after.player.stamina < before.player.stamina)
})

test('repairing a worn tool charges cash and restores durability', async () => {
  const mock = client()
  await mock.gather('iron_vein')
  const before = await mock.getSnapshot()
  const worn = before.player.toolDurability.pickaxe
  assert.ok(worn < economy.items.pickaxe.tool!.maxDurability)

  const result = await mock.repair('pickaxe')
  assert.equal(result.ok, true)
  assert.equal(result.durability, economy.items.pickaxe.tool!.maxDurability)
  assert.ok(result.cost > 0)

  const after = await mock.getSnapshot()
  assert.equal(after.player.cash, before.player.cash - result.cost)
  assert.equal(after.player.toolDurability.pickaxe, economy.items.pickaxe.tool!.maxDurability)
})

test('eating restores stamina and consumes a bread', async () => {
  const mock = client()
  await mock.gather('iron_vein')
  await mock.gather('iron_vein')
  const before = await mock.getSnapshot()
  assert.ok(before.player.stamina < before.player.maxStamina)
  const breadBefore = before.player.inventory.find(line => line.itemId === 'bread')?.quantity ?? 0

  const result = await mock.eat('bread')
  assert.equal(result.ok, true)
  assert.ok(result.staminaRestored > 0)

  const after = await mock.getSnapshot()
  assert.ok(after.player.stamina > before.player.stamina)
  assert.equal(after.player.inventory.find(line => line.itemId === 'bread')?.quantity, breadBefore - 1)
})

test('investment reopens a bankrupt merchant with the required injection', async () => {
  const mock = client()
  const state = mock.state.merchants.ferro
  state.cash = 0
  state.reserve = 20
  state.open = false

  const before = await mock.getSnapshot()
  const required = before.merchants.find(merchant => merchant.id === 'ferro')!.requiredInvestment
  assert.equal(required, 40)

  const result = await mock.invest('ferro')
  assert.equal(result.ok, true)
  assert.equal(result.amount, required)
  assert.equal(result.reopened, true)

  const after = await mock.getSnapshot()
  assert.equal(after.player.cash, before.player.cash - required)
  assert.equal(after.merchants.find(merchant => merchant.id === 'ferro')!.open, true)
  assert.ok((await mock.getEvents()).some(event => event.type === 'merchant.investment'))
})

test('fast-forward runs deterministically and produces a recap', async () => {
  const first = client()
  const run = await first.fastForward.start(2)
  assert.equal(run.status, 'done')
  assert.equal(run.day, 2)
  assert.equal(run.days.length, 2)
  assert.equal(run.progress, 1)
  assert.ok(run.recap)
  assert.ok(run.recap.trades.count >= 0)
  assert.ok(run.events.some(entry => entry.event.type === 'caravan.arrival'))

  const recap = await first.getRecap()
  assert.ok(recap.headline.length > 0)
  assert.ok(recap.standfirst.length > 0)
  assert.ok(recap.merchants.total >= 1)

  const second = await client().fastForward.start(2)
  assert.equal(JSON.stringify(second.days), JSON.stringify(run.days))
  assert.equal(second.recap?.headline, run.recap?.headline)
  assert.equal(second.recap?.standfirst, run.recap?.standfirst)
})

test('factory defaults to mock and reports an honest server fallback', () => {
  assert.equal(resolveEconomyMode({}), 'mock')
  assert.equal(resolveEconomyMode({ VITE_ECONOMY_CLIENT: 'server' }), 'server')

  const fallback = createEconomyRuntime({ env: { VITE_ECONOMY_CLIENT: 'server' } })
  assert.equal(fallback.mode, 'mock')
  assert.equal(fallback.fellBackToMock, true)
  assert.match(fallback.note, /no server adapter/)

  const mock = client()
  const runtime = createEconomyRuntime({
    env: { VITE_ECONOMY_CLIENT: 'server' },
    serverClient: mock,
  })
  assert.equal(runtime.mode, 'server')
  assert.equal(runtime.client, mock)
  assert.equal(createEconomyClient({ env: {} }).mode, 'mock')
})
