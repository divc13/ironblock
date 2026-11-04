import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { economy } from '../src/config/economy'
import type { EconomyConfig } from '../src/shared/types'
import { JsonEconomyStore } from '../src/server/economy/persistence'
import { EconomyService } from '../src/server/economy/service'

const cloneConfig = (): EconomyConfig => structuredClone(economy)

const withTempPath = async (
  run: (path: string, directory: string) => Promise<void>,
): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), 'ironblock-economy-'))
  try {
    await run(join(directory, 'world.json'), directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const firstBuy = (service: EconomyService, playerId: string) => {
  const state = service.snapshot()
  for (const merchant of Object.values(state.merchants)) {
    const merchantConfig = service.config.merchants[merchant.id]
    for (const itemId of merchantConfig.sells) {
      const preview = service.preview(playerId, merchant.id, itemId, 'buy', 1)
      if (preview?.canTrade) return { merchantId: merchant.id, itemId }
    }
  }
  throw new Error('no affordable buy found')
}

test('persistence round-trips the full world and skips resetting a matching config', async () => {
  await withTempPath(async path => {
    const config = cloneConfig()
    const first = await EconomyService.create({
      config,
      store: new JsonEconomyStore(path),
      autoSave: true,
    })
    assert.equal(first.loadStatus, 'new')
    const join = await first.ensurePlayer('player-1', 'Ada')
    assert.equal(join.success, true)
    const { merchantId, itemId } = firstBuy(first, 'player-1')
    const buy = await first.buy('player-1', merchantId, itemId, 1)
    assert.equal(buy.success, true, buy.error?.message)
    await first.flush()
    const expected = first.snapshot()
    assert.ok(expected.sequence > 0)
    assert.equal(expected.players['player-1'].id, 'player-1')

    const saved = JSON.parse(await readFile(path, 'utf8'))
    assert.equal(saved.fingerprint.hash, first.engine.fingerprint.hash)
    assert.equal(saved.state.configHash, first.engine.fingerprint.hash)
    assert.ok(Array.isArray(saved.state.events))

    const second = await EconomyService.create({
      config,
      store: new JsonEconomyStore(path),
      autoSave: true,
    })
    assert.equal(second.loadStatus, 'loaded')
    assert.deepEqual(second.snapshot(), expected)
    assert.deepEqual(second.eventsSince(0), first.eventsSince(0))
  })
})

test('a config hash mismatch resets the save instead of loading stale state', async () => {
  await withTempPath(async path => {
    const config = cloneConfig()
    const first = await EconomyService.create({
      config,
      store: new JsonEconomyStore(path),
      autoSave: true,
    })
    await first.ensurePlayer('player-1', 'Ada')
    await first.flush()

    const changed = cloneConfig()
    changed.meta.version = '0.1.1-changed'
    const second = await EconomyService.create({
      config: changed,
      store: new JsonEconomyStore(path),
      autoSave: true,
    })
    assert.equal(second.loadStatus, 'reset_config_mismatch')
    assert.deepEqual(second.snapshot().players, {})
    assert.equal(second.snapshot().configHash, second.engine.fingerprint.hash)
    assert.notEqual(second.snapshot().configHash, first.snapshot().configHash)

    const saved = JSON.parse(await readFile(path, 'utf8'))
    assert.equal(saved.fingerprint.hash, second.engine.fingerprint.hash)
  })
})

test('corrupt saves are quarantined by reset and a fresh world is written', async () => {
  await withTempPath(async path => {
    await writeFile(path, 'not-json', 'utf8')
    const service = await EconomyService.create({
      config: cloneConfig(),
      store: new JsonEconomyStore(path),
      autoSave: true,
    })
    assert.equal(service.loadStatus, 'reset_corrupt')
    assert.deepEqual(service.snapshot().players, {})
    const saved = JSON.parse(await readFile(path, 'utf8'))
    assert.ok(saved.state.configHash)

    const files = await readdir(join(path, '..'))
    assert.equal(files.some(file => file.endsWith('.tmp')), false)
  })
})

test('manual reset removes the persisted world and starts from day one', async () => {
  await withTempPath(async path => {
    const service = await EconomyService.create({
      config: cloneConfig(),
      store: new JsonEconomyStore(path),
      autoSave: true,
    })
    await service.ensurePlayer('player-1', 'Ada')
    assert.equal(service.snapshot().day, 1)
    const reset = await service.reset()
    assert.equal(service.loadStatus, 'reset_manual')
    assert.deepEqual(reset.players, {})
    assert.equal(reset.day, 1)
    assert.equal(reset.time, 0)
    const reloaded = await EconomyService.create({
      config: cloneConfig(),
      store: new JsonEconomyStore(path),
      autoSave: true,
    })
    assert.equal(reloaded.loadStatus, 'loaded')
    assert.deepEqual(reloaded.snapshot().players, {})
  })
})

test('the service serializes concurrent actions in call order', async () => {
  await withTempPath(async path => {
    const service = await EconomyService.create({
      config: cloneConfig(),
      store: new JsonEconomyStore(path),
      autoSave: false,
    })
    const merchant = Object.values(service.config.merchants)[0]
    const itemId = merchant.sells[0]
    const [join, buy] = await Promise.all([
      service.ensurePlayer('player-1', 'Ada'),
      service.buy('player-1', merchant.id, itemId, 1),
    ])
    assert.equal(join.success, true)
    assert.equal(buy.success, true, buy.error?.message)
    assert.ok(service.snapshot().sequence >= buy.sequence)
    assert.ok((service.snapshot().players['player-1'].inventory[itemId] ?? 0) > 0)
  })
})
