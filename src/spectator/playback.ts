import type { FastForwardAnnotation, SequencedMarketEvent } from '../server/observability'

/**
 * A single paced timeline for the deterministic fast-forward payload.
 *
 * The clone payload contains an event sample plus causal annotations. Events
 * and annotations are revealed in simulated-time order over one short wall
 * clock run (7 seconds by default). The page paints its day counter, summary,
 * chart and story feed from the same `simTime`, so they all move together.
 * `skipToEnd` reveals the remaining beats and finishes immediately.
 */

export interface PlaybackItem {
  kind: 'event' | 'annotation'
  time: number
  sequence: number
  event?: SequencedMarketEvent
  annotation?: FastForwardAnnotation
}

export interface PlaybackProgress {
  phase: 'running' | 'done'
  index: number
  total: number
  simTime: number
  fromTime: number
  toTime: number
  /** 0..100, based on smooth simulated time rather than the last beat. */
  percent: number
}

export interface PlaybackCallbacks {
  onReveal(item: PlaybackItem, index: number): void
  onProgress(progress: PlaybackProgress): void
  onDone(): void
}

export interface PlaybackOptions {
  /** Wall-clock seconds for the full run. Clamped to 4–30. Default 7. */
  wallSeconds?: number
}

export class FastForwardPlayback {
  private readonly items: PlaybackItem[]
  private readonly wallSeconds: number
  private pointer = 0
  private phaseState: 'idle' | 'running' | 'done' = 'idle'
  private wallElapsed = 0
  private lastFrame: number | null = null
  private raf: number | null = null
  private destroyed = false

  constructor(
    private readonly payload: {
      fromTime: number
      toTime: number
      events: SequencedMarketEvent[]
      annotations: FastForwardAnnotation[]
    },
    private readonly callbacks: PlaybackCallbacks,
    options: PlaybackOptions = {},
  ) {
    this.wallSeconds = Math.min(30, Math.max(4, options.wallSeconds ?? 7))
    this.items = [
      ...payload.events.map(event => ({
        kind: 'event' as const,
        time: event.time,
        sequence: event.sequence,
        event,
      })),
      ...payload.annotations.map(annotation => ({
        kind: 'annotation' as const,
        time: annotation.time,
        sequence: annotation.eventId ? annotation.sequence : Number.MAX_SAFE_INTEGER,
        annotation,
      })),
    ].sort((left, right) => left.time - right.time || left.sequence - right.sequence)
  }

  get total(): number {
    return this.items.length
  }

  get phase(): 'idle' | 'running' | 'done' {
    return this.phaseState
  }

  start(): void {
    if (this.destroyed || this.phaseState !== 'idle') return
    this.phaseState = 'running'
    this.lastFrame = null
    this.emitProgress()
    this.raf = requestAnimationFrame(this.loop)
  }

  skipToEnd(): void {
    if (this.destroyed || this.phaseState === 'done') return
    while (this.pointer < this.items.length) {
      this.revealAt(this.pointer)
      this.pointer += 1
    }
    this.finish()
  }

  destroy(): void {
    this.destroyed = true
    if (this.raf !== null) {
      cancelAnimationFrame(this.raf)
      this.raf = null
    }
  }

  private revealAt(index: number): void {
    const item = this.items[index]
    if (!item) return
    this.callbacks.onReveal(item, index)
  }

  private simNow(): number {
    const from = this.payload.fromTime
    const to = this.payload.toTime
    const span = Math.max(1, to - from)
    const progress = Math.min(1, this.wallElapsed / this.wallSeconds)
    return from + progress * span
  }

  private emitProgress(): void {
    const from = this.payload.fromTime
    const to = this.payload.toTime
    const simTime = this.phaseState === 'done' ? to : this.simNow()
    const percent =
      this.phaseState === 'done'
        ? 100
        : Math.max(0, Math.min(100, ((simTime - from) / Math.max(1, to - from)) * 100))
    this.callbacks.onProgress({
      phase: this.phaseState === 'done' ? 'done' : 'running',
      index: this.pointer,
      total: this.items.length,
      simTime,
      fromTime: from,
      toTime: to,
      percent,
    })
  }

  private finish(): void {
    if (this.phaseState === 'done') return
    this.phaseState = 'done'
    if (this.raf !== null) {
      cancelAnimationFrame(this.raf)
      this.raf = null
    }
    this.lastFrame = null
    this.emitProgress()
    this.callbacks.onDone()
  }

  private loop = (frame: number): void => {
    this.raf = null
    if (this.destroyed || this.phaseState !== 'running') return
    if (this.lastFrame !== null) {
      this.wallElapsed += (frame - this.lastFrame) / 1000
    }
    this.lastFrame = frame

    const simTime = this.simNow()
    while (this.pointer < this.items.length && this.items[this.pointer].time <= simTime) {
      this.revealAt(this.pointer)
      this.pointer += 1
    }

    if (this.wallElapsed >= this.wallSeconds) {
      while (this.pointer < this.items.length) {
        this.revealAt(this.pointer)
        this.pointer += 1
      }
      this.finish()
      return
    }

    this.emitProgress()
    this.raf = requestAnimationFrame(this.loop)
  }
}
