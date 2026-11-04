import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { charactersWithMap } from '../src/config/characters'
import { economy } from '../src/config/economy'
import {
  isMerchantEventName,
  isResourceEventName,
  merchantEventName,
  merchantIdFromEventName,
  merchantStallPosition,
  merchantsInStallOrder,
  resourceArea,
  resourceNodeEventName,
  resourceNodePositions,
  resourceSpecFromEventName,
  world,
} from '../src/config/world'
import { buildWorldEvents } from '../src/modules/main/world'

const inBounds = (x: number, y: number, margin = 0): boolean =>
  x >= margin && y >= margin && x <= world.map.widthPx - margin && y <= world.map.heightPx - margin

test('every configured merchant gets a distinct, in-bounds stall', () => {
  const merchants = merchantsInStallOrder()
  assert.equal(merchants.length, Object.keys(economy.merchants).length)
  assert.ok(merchants.length > 0)

  const positions = merchants.map(merchant => {
    const stall = merchantStallPosition(merchant)
    assert.ok(inBounds(stall.x, stall.y, 80), `${merchant.id} stall is inside the map`)
    assert.ok(stall.y - 80 >= 0, `${merchant.id} stall graphic fits above its base`)
    return stall
  })

  for (let left = 0; left < positions.length; left += 1) {
    for (let right = left + 1; right < positions.length; right += 1) {
      const a = positions[left]
      const b = positions[right]
      const distance = Math.hypot(a.x - b.x, a.y - b.y)
      assert.ok(distance >= 200, `stalls ${left}/${right} are spaced apart (${distance}px)`)
    }
  }
})

test('resource areas cover every config node and place the configured node count', () => {
  const positions: Array<{ x: number; y: number }> = []
  for (const resourceId of Object.keys(economy.resources.nodes)) {
    const node = economy.resources.nodes[resourceId]
    const area = resourceArea(resourceId)
    assert.ok(area, `${resourceId} has a world area`)

    const nodes = resourceNodePositions(resourceId)
    assert.equal(nodes.length, node.nodeCount, `${resourceId} node count follows config`)
    for (const point of nodes) {
      assert.ok(inBounds(point.x, point.y, 20), `${resourceId} node is in bounds`)
      assert.ok(
        Math.hypot(point.x - area.x, point.y - area.y) <= area.radius + 1,
        `${resourceId} node stays inside its area`,
      )
      positions.push(point)
    }
  }

  const unique = new Set(positions.map(point => `${point.x},${point.y}`))
  assert.equal(unique.size, positions.length, 'no two resource nodes share a coordinate')
})

test('area signs fit inside the map and stay near their nodes', () => {
  for (const resourceId of Object.keys(economy.resources.nodes)) {
    const area = resourceArea(resourceId)!
    const signY = Math.max(32, area.y - area.radius + 12)
    assert.ok(inBounds(area.x, signY, 24), `${resourceId} sign is in bounds`)
  }
})

test('event names round-trip between the server placement and client bridge', () => {
  const merchant = merchantsInStallOrder()[0]
  const name = merchantEventName(merchant.id)
  assert.equal(isMerchantEventName(name), true)
  assert.equal(merchantIdFromEventName(name), merchant.id)
  assert.equal(merchantIdFromEventName('node:iron_vein:0'), null)

  const nodeName = resourceNodeEventName('iron_vein', 3)
  assert.equal(isResourceEventName(nodeName), true)
  assert.deepEqual(resourceSpecFromEventName(nodeName), { resourceId: 'iron_vein', index: 3 })
  assert.equal(resourceSpecFromEventName('merchant:ferro'), null)
})

test('server map content is derived from config with unique event ids', () => {
  const events = buildWorldEvents()
  const merchantCount = merchantsInStallOrder().length
  const resourceIds = Object.keys(economy.resources.nodes)
  const nodeCount = resourceIds.reduce(
    (sum, resourceId) => sum + economy.resources.nodes[resourceId].nodeCount,
    0,
  )
  assert.equal(
    events.length,
    merchantCount * 3 + resourceIds.length + nodeCount + charactersWithMap().length * 2,
  )

  const ids = new Set(events.map(event => event.id))
  assert.equal(ids.size, events.length, 'event ids are unique')

  for (const merchant of merchantsInStallOrder()) {
    const event = events.find(entry => entry.id === merchantEventName(merchant.id))
    assert.ok(event, `${merchant.id} has an interaction event`)
    assert.equal(event.event.name, merchantEventName(merchant.id))
    assert.equal(typeof event.event.onAction, 'function')
    const stall = merchantStallPosition(merchant)
    assert.equal(event.x, stall.x)
  }

  for (const resourceId of resourceIds) {
    const nodeEvents = events.filter(entry => entry.id.startsWith(`node:${resourceId}:`))
    assert.equal(nodeEvents.length, economy.resources.nodes[resourceId].nodeCount)
    for (const entry of nodeEvents) {
      assert.equal(entry.event.name, entry.id)
      assert.equal(typeof entry.event.onAction, 'function')
    }
    assert.ok(events.some(entry => entry.id === `sign:area:${resourceId}`))
  }
})

test('market square Tiled map matches the world config and keeps the starter map intact', () => {
  assert.equal(world.mapId, 'marketsquare')
  const tmx = readFileSync(new URL('../src/tiled/marketsquare.tmx', import.meta.url), 'utf8')
  assert.match(tmx, /<map\b/)
  assert.match(tmx, /tileset\.tsx/)
  assert.match(tmx, new RegExp(`width="${world.map.widthPx / world.map.tileSize}"`))
  assert.match(tmx, new RegExp(`height="${world.map.heightPx / world.map.tileSize}"`))
  assert.match(tmx, /name="start"/)
  assert.ok(inBounds(world.spawn.x, world.spawn.y, 32))

  // Production smoke tests still expect the starter map to exist.
  const simplemap = readFileSync(new URL('../src/tiled/simplemap.tmx', import.meta.url), 'utf8')
  assert.match(simplemap, /<map\b/)
})
