import type { FastForwardAnnotation, SequencedMarketEvent } from '../server/observability'

/**
 * Timeline playback for the deterministic fast-forward payload.
 *
 * The clone result contains a fixed event sample plus causal annotations, both
 * stamped with simulated world time. Playback reveals them over ~60 wall
 * seconds in world-time order, with pause/resume, single-step, speed control
 * and skip-to-end. `prefers-reduced-motion` changes nothing functionally — the
 * caller removes animated effects for it.
 */

export interface PlaybackItem {
  kind: 'event' | 'annotation'
  time: number
  sequence: number
  event?: SequencedMarketEvent
  annotation?: FastForwardAnnotation
}

export interface PlaybackProgress {
  phase: 'running' | 'paused' | 'done'
  index: number
  total: number
  simTime: number
  fromTime: number
  toTime: number
  /** 0..100, simulated day progress. */
  percent: number
  speed: number
}

export interface PlaybackCallbacks {
  onReveal(item: PlaybackItem, index: number): void
  onProgress(progress: PlaybackProgress): void
  onDone(): void
}

export interface PlaybackOptions {
  /** Wall-clock seconds for the full run. Default 60 (config durationSeconds). */
  wallSeconds?: number
}

export class FastForwardPlayback {
  private items: PlaybackItem[]
  private pointer = 0
  private _phase: 'running' | 'paused' | 'done' = 'paused'
  private speed = 1
  private wallElapsed = 0
  private lastFrame: number | null = null
  private raf: number | null = null
  private destroyed = false
  private readonly wallSeconds: number

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
    this.wallSeconds = Math.min(120, Math.max(20, options.wallSeconds ?? 60))
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
    ]
      .sort((left, right) => left.time - right.time || left.sequence - right.sequence)
  }

  /** Administrative: total beats in the timeline. */
  get total(): number {
    return this.items.length
  }

  start(): void {
    this._phase = 'running'
    this.lastFrame = null
    this.emitProgress()
    this.loop(performance.now())
  }

  play(): void {
    if (this._phase === 'running' || this.destroyed) return
    if (this._phase === 'done') return
    this._phase = 'running'
    this.lastFrame = null
    this.emitProgress()
    if (this.raf === null) this.loop(performance.now())
  }

  pause(): void {
    if (this._phase === 'running') {
      this._phase = 'paused'
      this.emitProgress()
    }
  }

  /** Reveal the next beat regardless of pause state. */
  step(): void {
    if (this._phase === 'done') return
    const item = this.items[this.pointer]
    if (!item) {
      this.finish()
      return
    }
    this.revealAt(this.pointer)
    this.pointer += 1
    if (this.pointer >= this.items.length) {
      this.finish()
      return
    }
    this.emitProgress()
  }

  setSpeed(multiplier: number): void {
    this.speed = Math.max(0.5, Math.min(8, multiplier))
    this.emitProgress()
  }

  get currentSpeed(): number {
    return this.speed
  }

  get phase(): 'running' | 'paused' | 'done' {
    return this._phase
  }

  skipToEnd(): void {
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
    const span = Math.max(1, this.payload.toTime - this.payload.fromTime)
    const progress = Math.min(1, this.wallElapsed / this.wallSeconds)
    return this.payload.fromTime + progress * span
  }

  private emitProgress(): void {
    const span = Math.max(1, this.payload.toTime - this.payload.fromTime)
    const sim = this.simNow()
    const current = this.items[Math.min(this.pointer, this.items.length - 1)]
    const simThroughCurrent = current ? current.time : this.payload.toTime
    const percent =
      Math.max(0, Math.min(100, ((simThroughCurrent - this.payload.fromTime) / span) * 100))
    this.callbacks.onProgress({
      phase: this._phase,
      index: this.pointer,
      total: this.items.length,
      simTime: sim,
      fromTime: this.payload.fromTime,
      toTime: this.payload.toTime,
      percent,
      speed: this.speed,
    })
  }

  private finish(): void {
    this._phase = 'done'
    if (this.raf !== null) {
      cancelAnimationFrame(this.raf)
      this.raf = null
    }
    this.emitProgress()
    this.callbacks.onDone()
  }

  private loop = (frame: number): void => {
    if (this.destroyed) return
    if (this._phase !== 'running') {
      this.raf = null
      return
    }
    if (this.lastFrame !== null) {
      const deltaSeconds = (frame - this.lastFrame) / 1000
      this.wallElapsed += deltaSeconds * this.speed
    }
    this.lastFrame = frame

    const sim = this.simNow()
    while (this.pointer < this.items.length && this.items[this.pointer].time <= sim) {
      this.revealAt(this.pointer)
      this.pointer += 1
    }

    if (this.wallElapsed >= this.wallSeconds || this.pointer >= this.items.length) {
      // Reveal everything that belongs to the simulated window, then finish.
      while (this.pointer < this.items.length && this.items[this.pointer].time <= this.payload.toTime + 1e-9) {
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
