import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MockEconomyClient } from '../src/client/economy/mock'
import { worldSpritesheetIds } from '../src/client/world-sprites'
import { economy } from '../src/config/economy'
import {
  merchantEventName,
  merchantStallPosition,
  merchantsInStallOrder,
  stallPositionForSlot,
  world,
} from '../src/config/world'
import { buildWorldEvents } from '../src/modules/main/world'
import { validateEconomyConfig } from '../src/shared/config-validation'
import type { MerchantStallConfig } from '../src/config/world'

const explicitStalls = world.stallSlots as Record<number, MerchantStallConfig | undefined>

test('the new merchant characters keep stable ids, slots and complete trade profiles', () => {
  const config = validateEconomyConfig(economy)
  const sable = config.merchants.sable
  const rook = config.merchants.rook

  assert.ok(sable, 'Sable Voss is configured')
  assert.ok(rook, 'Rook Kestrel is configured')
  assert.equal(sable.displayName, 'Sable Voss')
  assert.equal(rook.displayName, 'Rook Kestrel')
  assert.equal(sable.stallSlot, 7)
  assert.equal(rook.stallSlot, 8)
  assert.equal(sable.personality, 'premium')
  assert.equal(rook.personality, 'aggressive')

  assert.deepEqual(sable.buys, ['bread', 'cloth', 'cloak'])
  assert.deepEqual(sable.sells, ['bread', 'cloth', 'cloak'])
  assert.deepEqual(rook.buys, ['iron_ore', 'iron_ingot', 'timber', 'plank'])
  assert.deepEqual(rook.sells, ['iron_ore', 'iron_ingot', 'timber', 'plank'])

  for (const merchant of [sable, rook]) {
    for (const itemId of [...merchant.buys, ...merchant.sells]) {
      assert.ok(config.items[itemId], `${merchant.id} only trades known item "${itemId}"`)
      assert.ok(
        merchant.targetStock[itemId] > 0,
        `${merchant.id} has target stock for "${itemId}"`,
      )
    }
    assert.ok(merchant.cash > merchant.reserve)
    assert.ok(merchant.margins.sell > merchant.margins.buy)
    assert.ok(merchant.restockRate.intervalSeconds > 0)
    assert.ok(merchant.restockRate.unitsPerTick > 0)
    assert.ok(merchant.restockRate.targetRatio > 0)
  }
})

test('slots 7 and 8 use explicit, distinct stall positions instead of the overflow grid', () => {
  for (const [slot, expected] of [
    [7, { x: 384, y: 944, color: '#3f7f7a' }],
    [8, { x: 896, y: 944, color: '#b3653f' }],
  ] as const) {
    assert.deepEqual(explicitStalls[slot], expected, `slot ${slot} is explicitly placed`)
    assert.deepEqual(stallPositionForSlot(slot), expected)
  }

  const positions = merchantsInStallOrder().map(merchant => merchantStallPosition(merchant))
  for (let left = 0; left < positions.length; left += 1) {
    for (let right = left + 1; right < positions.length; right += 1) {
      const distance = Math.hypot(
        positions[left].x - positions[right].x,
        positions[left].y - positions[right].y,
      )
      assert.ok(distance >= 200, `stalls ${left}/${right} stay visually separated`)
    }
  }
})

test('merchant ordering, map events and generated sprites include every configured stall', async () => {
  const ordered = merchantsInStallOrder()
  assert.equal(ordered.length, Object.keys(economy.merchants).length)
  assert.deepEqual(
    ordered.slice(-2).map(merchant => merchant.id),
    ['sable', 'rook'],
  )

  const events = buildWorldEvents()
  const spriteIds = new Set(worldSpritesheetIds())
  for (const merchant of ordered) {
    assert.ok(events.some(event => event.id === merchantEventName(merchant.id)))
    assert.ok(events.some(event => event.id === `stall:${merchant.id}`))
    assert.ok(events.some(event => event.id === `sign:stall:${merchant.id}`))
    assert.ok(spriteIds.has(`ironblock:stall:${merchant.id}`))
    assert.ok(spriteIds.has(`ironblock:sign:stall:${merchant.id}`))
  }

  const mock = new MockEconomyClient({ fastForwardPaceMs: 0 })
  const snapshot = await mock.getSnapshot()
  assert.equal(snapshot.merchants.length, ordered.length)
  assert.deepEqual(
    snapshot.merchants.map(merchant => merchant.id),
    ordered.map(merchant => merchant.id),
  )

  for (const merchant of [economy.merchants.sable, economy.merchants.rook]) {
    const view = await mock.getMerchant(merchant.id)
    assert.ok(view, `${merchant.id} is available through the merchant lookup`)
    assert.deepEqual(view.buys, merchant.buys)
    assert.deepEqual(view.sells, merchant.sells)
  }
})
