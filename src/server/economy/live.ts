import type { EconomyActionResult, TickActionData } from '../../shared/economy'
import { applyLiveBotActivityEvents } from './bot-playback'
import type { EconomyService } from './service'

/** Real-time cadence when `IRONBLOCK_LIVE_TICK_MS` is unset. */
export const DEFAULT_LIVE_TICK_MS = 1_000

/**
 * In-game seconds per real second when `IRONBLOCK_LIVE_TICK_SECONDS` is unset.
 *
 * A 1:1 ratio keeps the event feed sustainable: bots act on ~12s cadence, so
 * the retained 25k event history covers many simulated hours instead of
 * flooding at 30x. Operators can opt into faster simulation explicitly.
 */
export const DEFAULT_LIVE_TICK_SECONDS = 1

/**
 * Persistence cadence for live ticks. Each tick mutates the in-memory world;
 * the full world is only written to disk this often (plus on shutdown).
 */
export const DEFAULT_LIVE_SAVE_MS = 15_000

const MIN_LIVE_TICK_MS = 50

export interface LiveEconomyScheduler {
  setTimeout(callback: () => void, milliseconds: number): unknown
  clearTimeout(handle: unknown): void
}

export interface LiveEconomyOptions {
  /** Real-time delay between ticks. Env: `IRONBLOCK_LIVE_TICK_MS`. */
  tickMs?: number
  /**
   * In-game seconds advanced per tick. Defaults to 1 (1:1 with real time);
   * env: `IRONBLOCK_LIVE_TICK_SECONDS`.
   */
  tickSeconds?: number
  /** Debounced full-world save cadence. Env: `IRONBLOCK_LIVE_SAVE_MS`. */
  saveEveryMs?: number
  /** Test seam for timers. */
  scheduler?: LiveEconomyScheduler
  now?: () => number
  onError?: (error: unknown, phase: 'tick' | 'save') => void
  /**
   * Start even inside a test process. Hosts never set this; tests must opt in
   * explicitly so `npm test` does not leave background timers running.
   */
  force?: boolean
}

export type LiveEconomyTickResult = EconomyActionResult<TickActionData> | null

const positiveNumber = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * True when the current process is a test runner. Kept small on purpose:
 * `node --test`, `tsx --test` and Vitest all set one of these flags.
 */
export function liveEconomyAutoStartAllowed(): boolean {
  return !process.env.NODE_TEST_CONTEXT && !process.env.VITEST
}

function unrefTimer(timer: unknown): void {
  const candidate = timer as { unref?: () => void } | null
  candidate?.unref?.()
}

const defaultScheduler: LiveEconomyScheduler = {
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

const defaultOnError = (error: unknown, phase: 'tick' | 'save'): void => {
  const message = error instanceof Error ? error.message : String(error)
  console.warn(`[economy] live ${phase} failed: ${message}`)
}

/**
 * One recursive `setTimeout` loop around a live `EconomyService`.
 *
 * - The default advances one in-game second per real second, keeping the
 *   retained event feed readable; set `IRONBLOCK_LIVE_TICK_SECONDS` to opt
 *   into faster simulation.
 * - The next tick is only scheduled after the previous one settles, so slow
 *   ticks cannot pile up (unlike `setInterval`).
 * - Ticks go through `EconomyService.tickLive()`, which shares the service's
 *   existing action queue with fast-forward and player actions. No second lock.
 * - Ticks do not autosave. Persistence is debounced and flushed on stop.
 * - Timer errors are reported and the loop keeps going.
 * - The timer is unref'd so a test or short-lived process can exit.
 */
export class LiveEconomyLoop {
  readonly service: EconomyService
  readonly tickMs: number
  readonly tickSeconds: number
  readonly saveEveryMs: number

  private readonly scheduler: LiveEconomyScheduler
  private readonly now: () => number
  private readonly onError: (error: unknown, phase: 'tick' | 'save') => void
  private timer: unknown = null
  private active = false
  private inFlight: Promise<LiveEconomyTickResult> | null = null
  private lastSaveAt: number

  constructor(service: EconomyService, options: LiveEconomyOptions = {}) {
    const maxTickSeconds =
      service.config.fastForward.maxSteps * service.config.fastForward.stepSeconds
    const requestedTickSeconds =
      options.tickSeconds ??
      positiveNumber(process.env.IRONBLOCK_LIVE_TICK_SECONDS, DEFAULT_LIVE_TICK_SECONDS)
    const requestedTickMs =
      options.tickMs ??
      positiveNumber(process.env.IRONBLOCK_LIVE_TICK_MS, DEFAULT_LIVE_TICK_MS)
    const requestedSaveMs =
      options.saveEveryMs ??
      positiveNumber(process.env.IRONBLOCK_LIVE_SAVE_MS, DEFAULT_LIVE_SAVE_MS)

    this.service = service
    this.tickMs = Math.max(MIN_LIVE_TICK_MS, Math.round(requestedTickMs))
    this.tickSeconds = Math.max(0.001, Math.min(requestedTickSeconds, maxTickSeconds))
    this.saveEveryMs = Math.max(this.tickMs, Math.round(requestedSaveMs))
    this.scheduler = options.scheduler ?? defaultScheduler
    this.now = options.now ?? Date.now
    this.onError = options.onError ?? defaultOnError
    this.lastSaveAt = this.now()
  }

  get running(): boolean {
    return this.active
  }

  /** Idempotent: calling `start()` on a running loop is a no-op. */
  start(): this {
    if (this.active) return this
    this.active = true
    this.scheduleNext()
    return this
  }

  /**
   * Runs exactly one live tick through the service queue and applies the same
   * debounced-save policy as the timer. Exposed for tests and diagnostics.
   */
  async tickNow(): Promise<LiveEconomyTickResult> {
    if (this.inFlight) return this.inFlight

    const run = this.performTick()
    this.inFlight = run
    try {
      return await run
    } finally {
      if (this.inFlight === run) this.inFlight = null
    }
  }

  /** Stops scheduling, waits for the in-flight tick, then flushes once. */
  async stop(options: { persist?: boolean } = {}): Promise<void> {
    this.active = false
    if (this.timer !== null) {
      this.scheduler.clearTimeout(this.timer)
      this.timer = null
    }

    const pending = this.inFlight
    if (pending) {
      try {
        await pending
      } catch (error) {
        this.onError(error, 'tick')
      }
    }

    if ((options.persist ?? true) && this.service.autoSave) {
      try {
        await this.service.flush()
        this.lastSaveAt = this.now()
      } catch (error) {
        this.onError(error, 'save')
      }
    }
  }

  private scheduleNext(): void {
    if (!this.active) return
    this.timer = this.scheduler.setTimeout(() => {
      this.timer = null
      void this.runScheduledTick()
    }, this.tickMs)
    unrefTimer(this.timer)
  }

  private async runScheduledTick(): Promise<void> {
    try {
      const result = await this.tickNow()
      if (result && !result.success) {
        this.onError(
          new Error(result.error?.message ?? 'live tick was rejected'),
          'tick',
        )
      }
    } catch (error) {
      this.onError(error, 'tick')
    } finally {
      // Schedule only after the action settled: no overlapping ticks.
      if (this.active) this.scheduleNext()
    }
  }

  private async performTick(): Promise<LiveEconomyTickResult> {
    const result = await this.service.tickLive(this.tickSeconds)
    if (result.success) {
      // Presentation only: bridge the authoritative live events to the visible
      // map actors. While a fast-forward playback is driving the same actors,
      // the live source is suppressed so the two drivers cannot fight.
      applyLiveBotActivityEvents(result.events)
      await this.persistIfDue()
    }
    return result
  }

  private async persistIfDue(): Promise<void> {
    if (!this.service.autoSave) return
    if (this.now() - this.lastSaveAt < this.saveEveryMs) return

    try {
      await this.service.flush()
      this.lastSaveAt = this.now()
    } catch (error) {
      // A failed write must not stop simulation. The next due save retries.
      this.onError(error, 'save')
    }
  }
}

let activeLoop: LiveEconomyLoop | null = null

/**
 * Starts the single process-wide live loop. Every host (production, Vite dev,
 * Vite preview, RPGJS) calls this; the idempotent guard guarantees one loop.
 */
export function startLiveEconomy(
  service: EconomyService,
  options: LiveEconomyOptions = {},
): LiveEconomyLoop | null {
  if (activeLoop) return activeLoop
  if (!options.force && !liveEconomyAutoStartAllowed()) return null

  const loop = new LiveEconomyLoop(service, options)
  activeLoop = loop
  loop.start()
  return loop
}

export function getLiveEconomyLoop(): LiveEconomyLoop | null {
  return activeLoop
}

/** Stops and clears the process-wide loop. Safe when none is running. */
export async function stopLiveEconomy(
  options: { persist?: boolean } = {},
): Promise<void> {
  const loop = activeLoop
  activeLoop = null
  if (loop) await loop.stop(options)
}
