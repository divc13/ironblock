import { EconomyEngine } from '../shared/economy'
import type { SequencedMarketEvent } from '../shared/economy'
import { validateEconomyConfig } from '../shared/config-validation'
import { economy as economyData } from '../config/economy'
import type { EconomyConfig } from '../shared/types'
import {
  buildProofPayload,
  runFastForwardClone,
  sanitizeSpectatorSnapshot,
} from '../server/observability'
import type { FastForwardClonePayload, ProofPayload, PublicSnapshot } from '../server/observability'

/**
 * Client data layer for the spectator dashboard.
 *
 * LIVE mode talks to the observability API (`/api/market/*`: snapshot polling
 * + SSE + fast-forward POST). DEMO REPLAY mode runs the same deterministic
 * engine locally in the browser — identical rules, identical numbers, clearly
 * labeled — so the dashboard still demonstrates the full economy when the API
 * is not running (e.g. a statically hosted build). Demo mode never pretends to
 * be a live chain or service.
 */

export interface MarketStreamMessage {
  kind: 'snapshot' | 'events'
  snapshot?: PublicSnapshot
  events?: SequencedMarketEvent[]
  cursor?: number
}

export interface MarketFeed {
  readonly mode: 'live' | 'demo'
  readonly label: string
  /** One-shot initial snapshot. */
  getSnapshot(): Promise<PublicSnapshot>
  /** Live updates; demo resolves to a no-op unsubscribe. */
  subscribe(onMessage: (message: MarketStreamMessage) => void): () => void
  /** Deterministic 7-day (or N-day) clone simulation. */
  runFastForward(days?: number): Promise<FastForwardClonePayload>
  proof(): Promise<ProofPayload>
  config: EconomyConfig
}

export interface ResolveApiBase {
  /** Single config switch: window.IRONBLOCK_OBSERVABILITY_API_BASE wins, then
   * the Vite base path + /api/market, so subpath deployments resolve too. */
  (): string
}

export const resolveApiBase: ResolveApiBase = () => {
  const override =
    (globalThis as { IRONBLOCK_OBSERVABILITY_API_BASE?: string }).IRONBLOCK_OBSERVABILITY_API_BASE
  if (override) return normalizeBase(override)
  const metaBase = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/'
  return normalizeBase(joinPath(metaBase, '/api/market'))
}

function joinPath(base: string, path: string): string {
  const left = base.endsWith('/') ? base.slice(0, -1) : base
  return `${left}${path}`
}

function normalizeBase(value: string): string {
  const withSlash = value.startsWith('/') ? value : `/${value}`
  return withSlash.replace(/\/+$/, '') || '/api/market'
}

/* ------------------------------------------------------------------ live feed */

class LiveFeed implements MarketFeed {
  readonly mode = 'live' as const
  readonly label = 'LIVE'
  config: EconomyConfig

  constructor(private readonly apiBase: string) {
    this.config = validateEconomyConfig(economyData)
  }

  private url(path: string): string {
    return `${this.apiBase}${path}`
  }

  async getSnapshot(): Promise<PublicSnapshot> {
    const response = await this.fetchJson(this.url('/snapshot'))
    return response.snapshot as PublicSnapshot
  }

  async proof(): Promise<ProofPayload> {
    const response = await this.fetchJson(this.url('/proof'))
    return response.proof as ProofPayload
  }

  async runFastForward(days?: number): Promise<FastForwardClonePayload> {
    const body = days === undefined ? '{}' : JSON.stringify({ days })
    const response = await fetch(this.url('/fast-forward'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
    const payload = (await response.json()) as Record<string, unknown>
    if (!response.ok || payload.ok !== true) {
      throw new Error(String(payload.message ?? `fast-forward failed (HTTP ${response.status})`))
    }
    return payload as unknown as FastForwardClonePayload
  }

  subscribe(onMessage: (message: MarketStreamMessage) => void): () => void {
    let closed = false
    let source: EventSource | null = null
    const connect = () => {
      if (closed) return
      source = new EventSource(this.url('/stream'))
      source.addEventListener('snapshot', event => {
        try {
          const data = JSON.parse((event as MessageEvent<string>).data) as { snapshot: PublicSnapshot }
          onMessage({ kind: 'snapshot', snapshot: data.snapshot })
        } catch {
          /* ignore malformed frame */
        }
      })
      source.addEventListener('events', event => {
        try {
          const data = JSON.parse((event as MessageEvent<string>).data) as {
            events: SequencedMarketEvent[]
            cursor: number
          }
          onMessage({ kind: 'events', events: data.events, cursor: data.cursor })
        } catch {
          /* ignore malformed frame */
        }
      })
      source.onerror = () => {
        source?.close()
        if (!closed) setTimeout(connect, 3000)
      }
    }
    connect()
    return () => {
      closed = true
      source?.close()
    }
  }

  private async fetchJson(url: string): Promise<Record<string, unknown>> {
    const response = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`)
    return (await response.json()) as Record<string, unknown>
  }
}

/* ------------------------------------------------------------------ demo feed */

class DemoFeed implements MarketFeed {
  readonly mode = 'demo' as const
  readonly label = 'DEMO REPLAY'
  readonly config: EconomyConfig
  private engine: EconomyEngine

  constructor() {
    this.config = validateEconomyConfig(economyData)
    this.engine = new EconomyEngine(this.config)
  }

  async getSnapshot(): Promise<PublicSnapshot> {
    return sanitizeSpectatorSnapshot(this.engine.spectatorSnapshot(), this.config)
  }

  subscribe(_onMessage: (message: MarketStreamMessage) => void): () => void {
    // Demo replay is offline: no live stream; snapshots refresh on demand.
    return () => undefined
  }

  async runFastForward(days?: number): Promise<FastForwardClonePayload> {
    // The demo "clone" mirrors the server contract exactly: the local engine is
    // never advanced by the call below; runFastForwardClone builds a throwaway
    // engine from the current snapshot.
    const result = runFastForwardClone(this, days === undefined ? {} : { days })
    if (!result.ok) throw new Error(result.message)
    return result
  }

  async proof(): Promise<ProofPayload> {
    return buildProofPayload(this.config, {})
  }

  // ObservabilitySource-compatible, used by runFastForwardClone above.
  snapshot() {
    return this.engine.snapshot()
  }

  spectatorSnapshot() {
    return this.engine.spectatorSnapshot()
  }

  eventsSince(sequence: number): SequencedMarketEvent[] {
    return this.engine.eventsSince(sequence)
  }
}

/* ------------------------------------------------------------------ factory */

export type FeedFactory = () => Promise<{ feed: MarketFeed; fallbackReason?: string }>

/**
 * Tries the live API first; falls back to the deterministic local replay when
 * the API is unreachable (static hosting, offline judge machine, etc.).
 */
export const createFeed: FeedFactory = async () => {
  const apiBase = resolveApiBase()
  const live = new LiveFeed(apiBase)
  try {
    const snapshot = await live.getSnapshot()
    if (snapshot && typeof snapshot.sequence === 'number') {
      return { feed: live }
    }
    throw new Error('malformed snapshot')
  } catch (cause) {
    const demo = new DemoFeed()
    return {
      feed: demo,
      fallbackReason:
        `Live API not reachable at ${apiBase} (${(cause as Error).message}); showing deterministic local replay.`,
    }
  }
}
