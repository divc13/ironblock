import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import type { RpgEvent } from '@rpgjs/server'
import { characters } from '../src/config/characters'
import { economy } from '../src/config/economy'
import {
  applyLiveBotActivityEvents,
  isBotPlaybackActive,
  startBotPlayback,
  stopBotPlayback,
  type BotPlaybackScheduler,
} from '../src/server/economy/bot-playback'
import {
  clearBotActors,
  registerBotActor,
} from '../src/server/economy/bot-actors'
import type { SequencedMarketEvent } from '../src/shared/economy'

interface FakeTimer {
  callback: () => void
  due: number
}

const createScheduler = () => {
  let now = 0
  let nextId = 1
  const timers = new Map<number, FakeTimer>()

  const scheduler: BotPlaybackScheduler = {
    setTimeout(callback, milliseconds) {
      const id = nextId
      nextId += 1
      timers.set(id, { callback, due: now + milliseconds })
      return id
    },
    clearTimeout(handle) {
      timers.delete(handle as number)
    },
  }

  return {
    scheduler,
    pending: () => timers.size,
    delays: () =>
      [...timers.values()]
        .map(timer => timer.due)
        .sort((left, right) => left - right),
    advance(milliseconds: number) {
      now += milliseconds
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.due <= now)
        .sort((left, right) => left[1].due - right[1].due)
      for (const [id, timer] of due) {
        timers.delete(id)
        timer.callback()
      }
    },
    runAll() {
      while (timers.size > 0) {
        const next = [...timers.entries()].sort(
          (left, right) => left[1].due - right[1].due,
        )[0]
        timers.delete(next[0])
        now = next[1].due
        next[1].callback()
      }
    },
  }
}

interface FakeBotActor {
  speed: number
  x: () => number
  y: () => number
  moveTo: (target: { x: number; y: number }) => void
  stopMoveTo: () => void
  lastMove: () => { x: number; y: number } | null
  stopCalls: () => number
}

const createFakeActor = (x: number, y: number): FakeBotActor => {
  let lastMove: { x: number; y: number } | null = null
  let stops = 0
  return {
    speed: 0,
    x: () => x,
    y: () => y,
    moveTo(target) {
      lastMove = { x: target.x, y: target.y }
    },
    stopMoveTo() {
      stops += 1
    },
    lastMove: () => lastMove,
    stopCalls: () => stops,
  }
}

const merchantNames = (): string[] =>
  Object.values(economy.merchants).map(merchant => merchant.displayName)

const makeBotEvent = (
  sequence: number,
  time: number,
  merchantName: string,
  overrides: Partial<SequencedMarketEvent> = {},
): SequencedMarketEvent => ({
  id: `bot-event-${sequence}`,
  time,
  type: 'bot.trade',
  actor: { type: 'bot', id: 'bot-01', displayName: 'Marlowe Vane' },
  item: 'iron_ore',
  quantity: 1,
  price: 12,
  before: { stock: 10, cash: 100, bid: 10, ask: 14 },
  after: { stock: 11, cash: 88, bid: 10, ask: 14 },
  reasons: [],
  cause: 'trade',
  causeId: `cause-${sequence}`,
  message: `Marlowe Vane bought 1 Iron Ore from ${merchantName} for 12.00.`,
  sequence,
  ...overrides,
})

const registerFirstBot = (): FakeBotActor => {
  const character = characters.find(candidate => candidate.id === 'bot-01')
  assert.ok(character?.map, 'bot-01 has a map home')
  const actor = createFakeActor(character.map.x, character.map.y)
  registerBotActor(character, actor as unknown as RpgEvent)
  return actor
}

afterEach(() => {
  stopBotPlayback()
  clearBotActors()
})

test('bot playback is a no-op without registered map actors', () => {
  const scheduler = createScheduler()
  const events = [makeBotEvent(1, 0, merchantNames()[0])]

  const handle = startBotPlayback(events, { scheduler: scheduler.scheduler })

  assert.equal(handle, null)
  assert.equal(scheduler.pending(), 0)
  assert.equal(isBotPlaybackActive(), false)
})

test('bot playback schedules sampled events across the playback window', () => {
  registerFirstBot()
  const scheduler = createScheduler()
  const [first, second] = merchantNames()
  const events = [
    makeBotEvent(3, 10_000, second),
    makeBotEvent(1, 0, first),
    makeBotEvent(2, 5_000, first),
  ]

  const handle = startBotPlayback(events, {
    scheduler: scheduler.scheduler,
    fromTime: 0,
    toTime: 10_000,
    durationMs: 4_000,
  })

  assert.ok(handle)
  assert.equal(handle.scheduled, 3)
  assert.deepEqual(scheduler.delays(), [0, 2_000, 4_000])
  assert.equal(handle.active, true)
  assert.equal(isBotPlaybackActive(), true)
})

test('live bot dispatch is suppressed during playback and resumes afterwards', () => {
  const actor = registerFirstBot()
  const scheduler = createScheduler()
  const [first, second] = merchantNames()
  const playbackEvents = [makeBotEvent(1, 0, first), makeBotEvent(2, 5_000, first)]
  const liveEvent = makeBotEvent(9, 6_000, second)

  startBotPlayback(playbackEvents, {
    scheduler: scheduler.scheduler,
    fromTime: 0,
    toTime: 5_000,
    durationMs: 4_000,
  })

  applyLiveBotActivityEvents([liveEvent], 10)
  assert.equal(actor.lastMove(), null, 'live movement is gated during playback')

  scheduler.runAll()
  assert.equal(isBotPlaybackActive(), false)
  assert.ok(actor.lastMove(), 'playback moved the visible actor')

  const stopsBefore = actor.stopCalls()
  applyLiveBotActivityEvents([liveEvent], 20)
  assert.equal(actor.stopCalls(), stopsBefore + 1, 'live movement resumes')
  assert.notDeepEqual(actor.lastMove(), null)
})

test('a new playback cancels the previous run and a handle can be cancelled', () => {
  registerFirstBot()
  const firstScheduler = createScheduler()
  const secondScheduler = createScheduler()
  const events = [makeBotEvent(1, 0, merchantNames()[0])]

  const first = startBotPlayback(events, { scheduler: firstScheduler.scheduler })
  assert.ok(first)
  assert.equal(firstScheduler.pending(), 1)

  const second = startBotPlayback(events, { scheduler: secondScheduler.scheduler })
  assert.ok(second)
  assert.equal(first.active, false)
  assert.equal(firstScheduler.pending(), 0)
  assert.equal(secondScheduler.pending(), 1)

  second.cancel()
  assert.equal(second.active, false)
  assert.equal(secondScheduler.pending(), 0)
  assert.equal(isBotPlaybackActive(), false)
})

test('playback ignores non-bot and unmapped events', () => {
  registerFirstBot()
  const scheduler = createScheduler()
  const playerEvent = makeBotEvent(1, 0, merchantNames()[0], {
    actor: { type: 'player', id: 'player-1', displayName: 'Ada' },
  })

  const handle = startBotPlayback([playerEvent], {
    scheduler: scheduler.scheduler,
  })

  assert.equal(handle, null)
  assert.equal(scheduler.pending(), 0)
})
