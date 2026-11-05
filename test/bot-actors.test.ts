import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RpgEvent } from '@rpgjs/server'
import {
  applyBotActivityEvents,
  botActivityTargetForEvent,
  botActorSnapshot,
  clearBotActors,
  registerBotActor,
  registeredBotActorIds,
  tickBotActors,
} from '../src/server/economy/bot-actors'
import { characters } from '../src/config/characters'
import { economy } from '../src/config/economy'
import {
  merchantStallPosition,
  resourceArea,
  world,
} from '../src/config/world'
import type { SequencedMarketEvent } from '../src/shared/economy'

const makeEvent = (
  overrides: Partial<SequencedMarketEvent> = {},
): SequencedMarketEvent => ({
  id: 'test-event',
  time: 0,
  type: 'bot.trade',
  actor: { type: 'bot', id: 'bot-01', displayName: 'Marlowe Vane' },
  item: null,
  quantity: 1,
  price: null,
  before: { stock: null, cash: null, bid: null, ask: null },
  after: { stock: null, cash: null, bid: null, ask: null },
  reasons: [],
  cause: 'trade',
  causeId: 'test-cause',
  message: '',
  sequence: 1,
  ...overrides,
})

interface FakeBotEvent {
  speed: number
  x: () => number
  y: () => number
  moveTo: (target: { x: number; y: number }) => void
  stopMoveTo: () => void
  setPosition: (x: number, y: number) => void
  lastMove: () => { x: number; y: number } | null
  stopCalls: () => number
}

const createFakeBotEvent = (x: number, y: number): FakeBotEvent => {
  let px = x
  let py = y
  let lastMove: { x: number; y: number } | null = null
  let stopCalls = 0

  return {
    speed: 0,
    x: () => px,
    y: () => py,
    moveTo(target) {
      lastMove = { x: target.x, y: target.y }
    },
    stopMoveTo() {
      stopCalls += 1
    },
    setPosition(nextX, nextY) {
      px = nextX
      py = nextY
    },
    lastMove: () => lastMove,
    stopCalls: () => stopCalls,
  }
}

test('gather events walk a bot to the resource area for its item', () => {
  for (const [resourceId, node] of Object.entries(economy.resources.nodes)) {
    const area = resourceArea(resourceId)
    assert.ok(area, `${resourceId} has a map area`)

    const target = botActivityTargetForEvent(
      makeEvent({
        type: 'bot.gather',
        item: node.itemId,
        message: 'Marlowe Vane worked the resource node.',
      }),
      1,
    )

    assert.ok(target, `${resourceId} produces a gather target`)
    assert.equal(target.kind, 'gather')
    assert.equal(target.label, area.label)
    assert.ok(
      Math.hypot(target.x - area.x, target.y - area.y) <= area.radius,
      `${resourceId} target stays inside the visible area`,
    )
  }

  assert.equal(
    botActivityTargetForEvent(makeEvent({ type: 'bot.gather', item: 'unknown_item' }), 0),
    null,
    'unknown gathered items have no presentation target',
  )
  assert.equal(
    botActivityTargetForEvent(makeEvent({ type: 'bot.gather', item: null }), 0),
    null,
    'a gather event without an item has no target',
  )
})

test('trade messages walk a bot to the named merchant stall', () => {
  for (const [merchantId, side, index] of [
    ['ferro', 'from', 0],
    ['sable', 'to', 1],
  ] as const) {
    const merchant = economy.merchants[merchantId]
    const stall = merchantStallPosition(merchant)
    const message =
      side === 'from'
        ? `Marlowe Vane bought 2 Iron Ore from ${merchant.displayName} for 12.00 IRON.`
        : `Marlowe Vane sold 2 Iron Ore to ${merchant.displayName} for 12.00 IRON.`
    const target = botActivityTargetForEvent(
      makeEvent({ type: 'bot.trade', message }),
      index,
    )

    assert.ok(target, `${merchant.displayName} trade has a target`)
    assert.equal(target.kind, 'trade')
    assert.equal(target.label, merchant.displayName)
    assert.equal(target.x, stall.x + (index % 2 === 0 ? 52 : -52))
    assert.equal(target.y, stall.y + 86)
  }

  assert.equal(
    botActivityTargetForEvent(
      makeEvent({ type: 'bot.trade', message: 'Marlowe Vane bought 1 Iron Ore from Nobody for 2.' }),
      0,
    ),
    null,
    'an unknown merchant cannot be mapped',
  )
})

test('fulfilled orders walk a bot to the Guild Orders board', () => {
  const target = botActivityTargetForEvent(
    makeEvent({
      type: 'order.fulfilled',
      item: 'iron_ingot',
      message: 'Marlowe Vane delivered 2 Iron Ingot to the guild for 20.',
    }),
    2,
  )

  assert.ok(target)
  assert.equal(target.kind, 'order')
  assert.equal(target.label, 'Guild Orders')
  assert.equal(target.x, world.orderBoard.x - 180, 'order actors stand left or right of the sign')
  assert.equal(target.y, world.orderBoard.y + 24 + 8, 'order actors stand below the sign')

  const right = botActivityTargetForEvent(
    makeEvent({ type: 'order.fulfilled', item: 'iron_ingot' }),
    3,
  )
  assert.ok(right)
  assert.equal(right.x, world.orderBoard.x + 180)
  assert.ok(
    Math.abs(target.x - world.orderBoard.x) >= 160 &&
      Math.abs(right.x - world.orderBoard.x) >= 160,
    'nameplated order actors stay clear of the sign centre',
  )
})

test('unrelated events and non-bot activity have no presentation target', () => {
  assert.equal(
    botActivityTargetForEvent(
      makeEvent({ type: 'player.gather', actor: { type: 'player', id: 'player-1' } }),
      0,
    ),
    null,
  )
  assert.equal(
    botActivityTargetForEvent(makeEvent({ type: 'system.fast-forward' }), 0),
    null,
  )
  assert.equal(
    botActivityTargetForEvent(makeEvent({ type: 'bot.trade', message: '' }), 0),
    null,
  )
})

test('registered bot actors walk to activity, work, return and patrol', () => {
  clearBotActors()
  try {
    const character = characters[0]
    const home = character.map!
    const fake = createFakeBotEvent(home.x, home.y)
    registerBotActor(character, fake as unknown as RpgEvent)

    assert.deepEqual(registeredBotActorIds(), [character.id])
    assert.equal(fake.speed, 10, 'the server sets the actor speed')

    const gatherEvent = makeEvent({
      type: 'bot.gather',
      item: 'iron_ore',
      message: 'Marlowe Vane worked Iron Vein and gathered 2 Iron Ore.',
    })
    const target = botActivityTargetForEvent(gatherEvent, 0)
    assert.ok(target)

    applyBotActivityEvents([gatherEvent], 1_000)
    let [snapshot] = botActorSnapshot()
    assert.equal(snapshot.phase, 'toActivity')
    assert.equal(snapshot.activity, 'gather')
    assert.deepEqual(fake.lastMove(), { x: target.x, y: target.y })

    fake.setPosition(target.x, target.y)
    tickBotActors(1_100)
    ;[snapshot] = botActorSnapshot()
    assert.equal(snapshot.phase, 'working')
    assert.ok(fake.stopCalls() > 0, 'arrival stops the moveTo behavior')

    tickBotActors(3_600)
    ;[snapshot] = botActorSnapshot()
    assert.equal(snapshot.phase, 'returning')
    assert.deepEqual(fake.lastMove(), { x: home.x, y: home.y })

    fake.setPosition(home.x, home.y)
    tickBotActors(3_700)
    ;[snapshot] = botActorSnapshot()
    assert.equal(snapshot.phase, 'idle')

    tickBotActors(10_000)
    ;[snapshot] = botActorSnapshot()
    assert.equal(snapshot.phase, 'patrolling')
    assert.notDeepEqual(fake.lastMove(), { x: home.x, y: home.y }, 'idle bots wander')
  } finally {
    clearBotActors()
  }

  assert.deepEqual(registeredBotActorIds(), [])
  assert.deepEqual(botActorSnapshot(), [])
})
