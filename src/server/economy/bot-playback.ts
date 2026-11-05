import type { SequencedMarketEvent } from '../../shared/economy'
import { FAST_FORWARD_PLAYBACK_MS } from '../../shared/economy/fast-forward'
import {
  applyBotActivityEvents,
  botActivityTargetForEvent,
  registeredBotActorIds,
} from './bot-actors'

/**
 * Plays sampled fast-forward bot events across a short wall-clock window.
 *
 * The economy engine commits the whole week in one pass. This module only
 * drives the presentation layer (the visible server map actors) so every
 * connected client sees the same accelerated movement. Live-loop bot events
 * are ignored while a playback is active so two drivers cannot fight over the
 * same actor.
 */

export interface BotPlaybackScheduler {
  setTimeout(callback: () => void, milliseconds: number): unknown
  clearTimeout(handle: unknown): void
}

export interface StartBotPlaybackOptions {
  /** Start of the simulated window in in-game seconds. */
  fromTime?: number
  /** End of the simulated window in in-game seconds. */
  toTime?: number
  /** Wall-clock playback length. Defaults to FAST_FORWARD_PLAYBACK_MS. */
  durationMs?: number
  scheduler?: BotPlaybackScheduler
  now?: () => number
}

export interface BotPlaybackHandle {
  readonly active: boolean
  readonly scheduled: number
  cancel(): void
}

interface BotPlaybackRun {
  generation: number
  scheduler: BotPlaybackScheduler
  timers: unknown[]
  remaining: number
}

const defaultScheduler: BotPlaybackScheduler = {
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

let playback: BotPlaybackRun | null = null
let generation = 0

const unrefTimer = (timer: unknown): void => {
  ;(timer as { unref?: () => void } | null)?.unref?.()
}

/** True while sampled fast-forward bot events are still being replayed. */
export function isBotPlaybackActive(): boolean {
  return playback !== null && playback.remaining > 0
}

/** Cancel the current playback and clear every pending timer. */
export function stopBotPlayback(): void {
  generation += 1
  const run = playback
  playback = null
  if (!run) return
  run.remaining = 0
  for (const timer of run.timers) {
    try {
      run.scheduler.clearTimeout(timer)
    } catch {
      // The host may already be tearing down its timer implementation.
    }
  }
  run.timers = []
}

/**
 * Schedule `applyBotActivityEvents` for each sampled bot event.
 *
 * Returns `null` when there are no registered map actors or no relevant bot
 * events, which keeps headless tests and spectator-only processes silent.
 */
export function startBotPlayback(
  events: readonly SequencedMarketEvent[],
  options: StartBotPlaybackOptions = {},
): BotPlaybackHandle | null {
  stopBotPlayback()

  if (registeredBotActorIds().length === 0) return null

  const relevant = events
    .filter(
      event =>
        event.actor.type === 'bot' &&
        botActivityTargetForEvent(event, 0) !== null,
    )
    .sort((left, right) => left.time - right.time || left.sequence - right.sequence)
  if (relevant.length === 0) return null

  const seen = new Set<number>()
  const unique = relevant.filter(event => {
    if (seen.has(event.sequence)) return false
    seen.add(event.sequence)
    return true
  })

  const scheduler = options.scheduler ?? defaultScheduler
  const now = options.now ?? Date.now
  const durationMs = Math.max(
    1,
    Math.floor(options.durationMs ?? FAST_FORWARD_PLAYBACK_MS),
  )
  const fromTime = options.fromTime ?? unique[0].time
  const toTime = options.toTime ?? unique[unique.length - 1].time
  const span = Math.max(1e-9, toTime - fromTime)
  const run: BotPlaybackRun = {
    generation: ++generation,
    scheduler,
    timers: [],
    remaining: unique.length,
  }
  playback = run

  for (const event of unique) {
    const progress = Math.min(1, Math.max(0, (event.time - fromTime) / span))
    const delay = Math.round(progress * durationMs)
    const timer = scheduler.setTimeout(() => {
      if (run.generation !== generation || playback !== run) return
      try {
        applyBotActivityEvents([event], now())
      } catch {
        // A map actor can disappear during teardown; the next event continues.
      }
      run.remaining = Math.max(0, run.remaining - 1)
      if (run.remaining === 0 && playback === run) playback = null
    }, delay)
    unrefTimer(timer)
    run.timers.push(timer)
  }

  return {
    get active() {
      return playback === run && run.remaining > 0
    },
    scheduled: unique.length,
    cancel() {
      if (playback === run) {
        stopBotPlayback()
        return
      }
      for (const timer of run.timers) {
        try {
          scheduler.clearTimeout(timer)
        } catch {
          // Already cleared by a newer playback generation.
        }
      }
      run.timers = []
      run.remaining = 0
    },
  }
}

/**
 * Live-loop entry point. It is a no-op while fast-forward playback owns the
 * actors, and otherwise forwards the authoritative live events as before.
 */
export function applyLiveBotActivityEvents(
  events: readonly SequencedMarketEvent[],
  now = Date.now(),
): void {
  if (isBotPlaybackActive()) return
  applyBotActivityEvents(events, now)
}
