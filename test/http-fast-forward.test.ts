import assert from 'node:assert/strict'
import { test } from 'node:test'
import { economy } from '../src/config/economy'
import {
  HttpFastForwardClient,
  type HttpEconomyClient,
} from '../src/client/economy/http'
import type { EconomyFastForwardResponse } from '../src/shared/economy/api'
import type { SequencedMarketEvent } from '../src/shared/economy'
import type { SessionRecap } from '../src/client/economy/types'

const daySeconds = 86_400

const flush = (): Promise<void> =>
  new Promise(resolve => {
    setImmediate(resolve)
  })

class FakeTimer {
  now = 0
  private nextId = 1
  private readonly timers = new Map<
    number,
    { callback: () => void; due: number; interval: number }
  >()

  readonly schedule = (callback: () => void, milliseconds: number): unknown => {
    const id = this.nextId
    this.nextId += 1
    this.timers.set(id, {
      callback,
      due: this.now + milliseconds,
      interval: Math.max(1, milliseconds),
    })
    return id
  }

  readonly cancel = (handle: unknown): void => {
    this.timers.delete(handle as number)
  }

  get pending(): number {
    return this.timers.size
  }

  advance(milliseconds: number): void {
    const target = this.now + milliseconds
    let guard = 0
    while (this.now < target && guard < 10_000) {
      guard += 1
      let nextDue = Number.POSITIVE_INFINITY
      for (const timer of this.timers.values()) {
        nextDue = Math.min(nextDue, timer.due)
      }
      if (!Number.isFinite(nextDue) || nextDue > target) break
      this.now = nextDue
      for (const [id, timer] of [...this.timers.entries()]) {
        if (!this.timers.has(id) || timer.due > this.now) continue
        timer.due += timer.interval
        timer.callback()
      }
    }
    this.now = target
  }
}

const makeEvent = (
  sequence: number,
  time: number,
  overrides: Partial<SequencedMarketEvent> = {},
): SequencedMarketEvent => ({
  id: `event-${sequence}`,
  time,
  type: 'bot.gather',
  actor: { type: 'bot', id: 'bot-01', displayName: 'Marlowe Vane' },
  item: 'iron_ore',
  quantity: 1,
  price: null,
  before: { stock: null, cash: null, bid: null, ask: null },
  after: { stock: null, cash: null, bid: null, ask: null },
  reasons: [],
  cause: 'gather',
  causeId: `cause-${sequence}`,
  message: `Marlowe Vane gathered iron ore on day ${Math.floor(time / daySeconds) + 1}.`,
  sequence,
  ...overrides,
})

const recap: SessionRecap = {
  headline: 'Ironblock holds a steady market',
  standfirst: 'Seven days of town trade.',
  generatedAtDay: 8,
  topMovers: [],
  trades: { count: 0, buyCount: 0, sellCount: 0, volume: 0, value: 0 },
  bankruptcies: [],
  investments: [],
  caravan: { arrivals: 1, note: 'One caravan.' },
  sinks: { rent: 0, tax: 0, repairs: 0, total: 0 },
  merchants: { open: 8, total: 8, health: 'thriving' },
}

const responseFor = (
  overrides: Partial<EconomyFastForwardResponse> = {},
): EconomyFastForwardResponse => {
  const days = 7
  const startDay = 3
  const fromTime = (startDay - 1) * daySeconds
  const events = Array.from({ length: days }, (_, index) =>
    makeEvent(index + 1, fromTime + (index + 1) * daySeconds),
  )
  return {
    success: true,
    days,
    fromTime,
    toTime: fromTime + days * daySeconds,
    startDay,
    endDay: startDay + days,
    steps: days,
    seed: 'test-seed',
    summaries: [],
    series: Array.from({ length: days }, (_, index) => ({
      day: startDay + index,
      endedAt: fromTime + (index + 1) * daySeconds,
      totalMerchantCash: 1_000,
      totalPlayerCash: 100,
      tradeVolume: 10,
      tradeValue: 100,
      bankruptcies: 0,
      caravanArrivals: index === 2 ? 1 : 0,
      sinkTotal: 0,
    })),
    events,
    eventCount: events.length,
    finalSequence: events.length,
    durationMs: 10,
    ...overrides,
  }
}

const createOwner = (
  result: EconomyFastForwardResponse | Error,
  timing: FakeTimer,
) => {
  const stats = { requests: 0, syncs: 0, recaps: 0 }
  const owner = {
    config: economy,
    async requestFastForward() {
      stats.requests += 1
      if (result instanceof Error) throw result
      return result
    },
    async sync() {
      stats.syncs += 1
    },
    async getRecap() {
      stats.recaps += 1
      return recap
    },
  }
  const client = new HttpFastForwardClient(
    owner as unknown as HttpEconomyClient,
    {
      revealDurationMs: 4_000,
      now: () => timing.now,
      scheduleInterval: timing.schedule,
      cancelInterval: timing.cancel,
    },
  )
  return { client, stats }
}

test('HTTP fast-forward posts once, reveals over four seconds and syncs once', async () => {
  const timing = new FakeTimer()
  const response = responseFor()
  const { client, stats } = createOwner(response, timing)

  const running = client.start(7)
  await flush()

  let state = client.getState()
  assert.equal(state.status, 'running')
  assert.equal(state.day, 0)
  assert.equal(state.progress, 0)
  assert.equal(state.events.length, 0)
  assert.equal(stats.requests, 1)

  timing.advance(2_000)
  state = client.getState()
  assert.equal(state.status, 'running')
  assert.ok(Math.abs(state.progress - 0.5) < 1e-9)
  assert.equal(state.day, 3)
  assert.equal(state.events.length, 3)
  assert.equal(timing.pending, 1)

  timing.advance(2_100)
  await running

  state = client.getState()
  assert.equal(state.status, 'done')
  assert.equal(state.day, 7)
  assert.equal(state.progress, 1)
  assert.equal(state.days.length, 7)
  assert.equal(state.events.length, 7)
  assert.equal(state.fromTime, response.fromTime)
  assert.equal(state.toTime, response.toTime)
  assert.equal(state.startDay, 3)
  assert.equal(state.endDay, 10)
  assert.equal(state.revealDurationMs, 4_000)
  assert.equal(state.worldPlayback, 'server')
  assert.equal(state.recap?.headline, recap.headline)
  assert.equal(stats.requests, 1)
  assert.equal(stats.syncs, 1)
  assert.equal(stats.recaps, 1)
  assert.equal(timing.pending, 0)
})

test('HTTP fast-forward ignores a second start while a run is active', async () => {
  const timing = new FakeTimer()
  const { client, stats } = createOwner(responseFor(), timing)

  const first = client.start(7)
  const second = client.start(7)
  await flush()

  assert.equal(stats.requests, 1)
  assert.equal(client.getState().status, 'running')

  timing.advance(4_100)
  await Promise.all([first, second])

  assert.equal(stats.requests, 1)
  assert.equal(stats.syncs, 1)
  assert.equal(client.getState().status, 'done')
})

test('HTTP fast-forward skip reveals the end but still syncs once', async () => {
  const timing = new FakeTimer()
  const { client, stats } = createOwner(responseFor(), timing)

  const running = client.start(7)
  await flush()
  assert.equal(timing.pending, 1)

  client.skip()
  await running

  const state = client.getState()
  assert.equal(state.status, 'done')
  assert.equal(state.day, 7)
  assert.equal(state.progress, 1)
  assert.equal(state.events.length, 7)
  assert.equal(stats.requests, 1)
  assert.equal(stats.syncs, 1)
  assert.equal(timing.pending, 0)
})

test('HTTP fast-forward deduplicates events by id or sequence', async () => {
  const timing = new FakeTimer()
  const response = responseFor()
  const duplicate = {
    ...response.events[0],
    sequence: 99,
  }
  response.events = [...response.events, duplicate]
  const { client } = createOwner(response, timing)

  const running = client.start(7)
  await flush()
  timing.advance(4_100)
  await running

  const ids = client.getState().events.map(entry => entry.event.id)
  assert.equal(ids.length, 7)
  assert.equal(new Set(ids).size, 7)
})

test('HTTP fast-forward reports an error and reconciles once', async () => {
  const timing = new FakeTimer()
  const { client, stats } = createOwner(new Error('market unavailable'), timing)

  const state = await client.start(7)

  assert.equal(state.status, 'idle')
  assert.equal(state.progress, 0)
  assert.equal(state.message, 'market unavailable')
  assert.equal(stats.requests, 1)
  assert.equal(stats.syncs, 1)
  assert.equal(stats.recaps, 0)
  assert.equal(timing.pending, 0)
})

test('HTTP fast-forward reset cancels a pending reveal', async () => {
  const timing = new FakeTimer()
  const { client, stats } = createOwner(responseFor(), timing)

  const running = client.start(7)
  await flush()
  client.reset()

  const state = await running
  assert.equal(state.status, 'idle')
  assert.equal(stats.syncs, 0)
  assert.equal(timing.pending, 0)
})
