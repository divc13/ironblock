import assert from 'node:assert/strict'
import { test } from 'node:test'
import { economy } from '../src/config/economy'
import type { EconomyConfig } from '../src/shared/types'
import type { EconomyStore, PersistedEconomyEnvelope } from '../src/shared/economy'
import {
  LiveEconomyLoop,
  getLiveEconomyLoop,
  liveEconomyAutoStartAllowed,
  startLiveEconomy,
  stopLiveEconomy,
} from '../src/server/economy/live'
import { EconomyService } from '../src/server/economy/service'

const cloneConfig = (): EconomyConfig => structuredClone(economy)

const memoryStore = (onSave?: () => void): EconomyStore => ({
  load: async (): Promise<PersistedEconomyEnvelope | null> => null,
  save: async (): Promise<void> => {
    onSave?.()
  },
  reset: async (): Promise<void> => undefined,
})

const createService = async (
  autoSave = false,
  store: EconomyStore = memoryStore(),
): Promise<EconomyService> =>
  EconomyService.create({
    config: cloneConfig(),
    store,
    autoSave,
  })

const fakeScheduler = () => {
  let callback: (() => void) | null = null
  let cleared = false
  const timer = {
    unrefCalled: false,
    unref() {
      this.unrefCalled = true
    },
  }

  return {
    scheduler: {
      setTimeout(next: () => void): unknown {
        callback = next
        return timer
      },
      clearTimeout(): void {
        cleared = true
        callback = null
      },
    },
    timer,
    fire(): void {
      const next = callback
      callback = null
      next?.()
    },
    get scheduled(): boolean {
      return callback !== null
    },
    get cleared(): boolean {
      return cleared
    },
  }
}

test('live auto-start is disabled inside test runners', async () => {
  const service = await createService()
  assert.equal(liveEconomyAutoStartAllowed(), false)
  assert.equal(startLiveEconomy(service, { tickMs: 1_000 }), null)
  assert.equal(getLiveEconomyLoop(), null)
})

test('process-wide live loop start is idempotent and stop clears it', async () => {
  const service = await createService()
  const first = startLiveEconomy(service, {
    force: true,
    tickMs: 60_000,
    tickSeconds: 30,
  })

  try {
    assert.ok(first)
    assert.equal(first.running, true)
    assert.equal(getLiveEconomyLoop(), first)

    const second = startLiveEconomy(service, {
      force: true,
      tickMs: 5,
      tickSeconds: 1,
    })
    assert.equal(second, first, 'a second host must share the same loop')

    await stopLiveEconomy()
    assert.equal(first.running, false)
    assert.equal(getLiveEconomyLoop(), null)

    const restarted = startLiveEconomy(service, {
      force: true,
      tickMs: 60_000,
      tickSeconds: 30,
    })
    assert.ok(restarted)
    assert.notEqual(restarted, first, 'stop releases the singleton for restart')
    assert.equal(getLiveEconomyLoop(), restarted)
  } finally {
    await stopLiveEconomy()
  }
})

test('live cadence defaults to 1:1 and honors env overrides', async () => {
  const service = await createService()
  const saved = {
    tickMs: process.env.IRONBLOCK_LIVE_TICK_MS,
    tickSeconds: process.env.IRONBLOCK_LIVE_TICK_SECONDS,
  }

  try {
    delete process.env.IRONBLOCK_LIVE_TICK_MS
    delete process.env.IRONBLOCK_LIVE_TICK_SECONDS
    const defaults = new LiveEconomyLoop(service, {
      scheduler: fakeScheduler().scheduler,
      now: () => 0,
    })
    assert.equal(defaults.tickMs, 1_000)
    assert.equal(defaults.tickSeconds, 1)

    process.env.IRONBLOCK_LIVE_TICK_MS = '250'
    process.env.IRONBLOCK_LIVE_TICK_SECONDS = '45'
    const overridden = new LiveEconomyLoop(service, {
      scheduler: fakeScheduler().scheduler,
      now: () => 0,
    })
    assert.equal(overridden.tickMs, 250)
    assert.equal(overridden.tickSeconds, 45)
  } finally {
    if (saved.tickMs === undefined) delete process.env.IRONBLOCK_LIVE_TICK_MS
    else process.env.IRONBLOCK_LIVE_TICK_MS = saved.tickMs
    if (saved.tickSeconds === undefined) delete process.env.IRONBLOCK_LIVE_TICK_SECONDS
    else process.env.IRONBLOCK_LIVE_TICK_SECONDS = saved.tickSeconds
  }
})

test('live loop uses unref timers and one tick advances bots and merchants', async () => {
  const service = await createService()
  const timer = fakeScheduler()
  const loop = new LiveEconomyLoop(service, {
    tickMs: 1_000,
    tickSeconds: 3_600,
    saveEveryMs: 60_000,
    scheduler: timer.scheduler,
    now: () => 0,
  })

  const before = service.snapshot()

  try {
    loop.start()
    assert.equal(loop.running, true)
    assert.equal(timer.timer.unrefCalled, true, 'live timer must not keep Node alive')
    assert.equal(timer.scheduled, true)
    assert.equal(loop.start(), loop, 'loop.start() is idempotent')

    const result = await loop.tickNow()
    assert.equal(result?.success, true, result?.error?.message)

    const after = service.snapshot()
    assert.equal(after.time, before.time + 3_600)
    assert.ok(after.sequence > before.sequence, 'live tick produced events')

    const events = service.eventsSince(before.sequence)
    const botEvents = events.filter(event => event.actor.type === 'bot')
    assert.ok(botEvents.length > 0, 'bots acted during the live tick')
    assert.ok(
      botEvents.some(event => event.type === 'bot.trade' || event.type === 'bot.gather'),
      'bots traded or gathered at resource nodes',
    )
    assert.ok(after.stats.botTrades + after.stats.botGathers > 0)
    assert.ok(
      events.some(event => event.type === 'caravan.arrival'),
      'caravan arrival is emitted by the same live tick',
    )

    const merchantChanged = Object.values(after.merchants).some(merchant => {
      const previous = before.merchants[merchant.id]
      return (
        merchant.cash !== previous.cash ||
        JSON.stringify(merchant.stock) !== JSON.stringify(previous.stock)
      )
    })
    assert.equal(merchantChanged, true, 'merchant cash or stock changed')

    // A manual tick still participates in the same queue and can run again.
    const second = await loop.tickNow()
    assert.equal(second?.success, true, second?.error?.message)
  } finally {
    await loop.stop()
  }

  assert.equal(loop.running, false)
  assert.equal(timer.cleared, true)
})

test('live ticks are debounced on disk but flushed on stop', async () => {
  let saves = 0
  const service = await createService(
    true,
    memoryStore(() => {
      saves += 1
    }),
  )
  assert.equal(saves, 1, 'service create persisted the initial world')

  let now = 0
  const loop = new LiveEconomyLoop(service, {
    tickMs: 1_000,
    tickSeconds: 30,
    saveEveryMs: 60_000,
    scheduler: fakeScheduler().scheduler,
    now: () => now,
  })

  await loop.tickNow()
  assert.equal(saves, 1, 'a live tick does not write the whole world')

  now = 60_000
  await loop.tickNow()
  assert.equal(saves, 2, 'the debounced save runs once the interval elapses')

  await loop.stop()
  assert.equal(saves, 3, 'stop persists the final live state exactly once')
})

test('live ticks share the service queue with fast-forward', async () => {
  const service = await createService()
  const loop = new LiveEconomyLoop(service, {
    tickMs: 1_000,
    tickSeconds: 30,
    saveEveryMs: 60_000,
    scheduler: fakeScheduler().scheduler,
    now: () => 0,
  })
  const before = service.snapshot()

  try {
    const [tick, fastForward] = await Promise.all([
      loop.tickNow(),
      service.fastForward(1),
    ])

    assert.equal(tick?.success, true, tick?.error?.message)
    assert.equal(fastForward.success, true)
    const after = service.snapshot()
    assert.equal(
      after.time,
      before.time + 30 + 86_400,
      'both mutations were applied exactly once, in queue order',
    )
    assert.ok(after.sequence > before.sequence)
  } finally {
    await loop.stop({ persist: false })
  }
})
