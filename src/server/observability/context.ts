import type {
  ObservabilityContext,
  ObservabilitySource,
  RateLimitOptions,
} from './types'

export interface ObservabilityContextOptions {
  /** Returns the live economy source; may be async. Null => 503 responses. */
  getService: () => ObservabilitySource | null | Promise<ObservabilitySource | null>
  apiPath?: string
  now?: () => number
  rateLimit?: Partial<RateLimitOptions>
  bodyLimit?: number
  stream?: { pollMs?: number; snapshotEveryMs?: number }
}

export const DEFAULT_API_PATH = '/api/market'
export const DEFAULT_BODY_LIMIT = 4096
export const DEFAULT_RATE_LIMIT: RateLimitOptions = { max: 6, windowMs: 60_000 }
export const DEFAULT_STREAM = { pollMs: 1000, snapshotEveryMs: 15_000 }

/**
 * The single env switch for the API base path (verbatim, supports subpath
 * deployments). Explicit option values always win over this.
 */
export function apiPathFromEnv(): string | null {
  const value = process.env.IRONBLOCK_OBSERVABILITY_API_PATH?.trim()
  return value ? value : null
}

/**
 * Single env/config switch for the API base path. Supports subpath
 * deployments: set `IRONBLOCK_OBSERVABILITY_API_PATH=/quest/api/market` or
 * pass `apiPath` explicitly. The spectator page resolves the same path from
 * the Vite base URL, so one switch moves the whole API.
 */
export function resolveApiPath(explicit?: string): string {
  const chosen = explicit ?? apiPathFromEnv() ?? DEFAULT_API_PATH
  return normalizeApiPath(chosen)
}

/** Normalizes a mount path to a leading-slash, trailing-slash-free form. */
export function normalizeApiPath(value: string): string {
  const withSlash = value.startsWith('/') ? value : `/${value}`
  return withSlash.replace(/\/+$/, '') || DEFAULT_API_PATH
}

/** Sliding-window limiter keyed by client (remote address). */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>()

  constructor(
    private readonly options: RateLimitOptions,
    private readonly now: () => number = Date.now,
  ) {}

  takeToken(clientKey: string): { allowed: boolean; retryAfterMs: number } {
    const now = this.now()
    const windowStart = now - this.options.windowMs
    const previous = (this.hits.get(clientKey) ?? []).filter(time => time > windowStart)
    if (previous.length >= this.options.max) {
      const oldest = previous[0]
      this.hits.set(clientKey, previous)
      return { allowed: false, retryAfterMs: Math.max(1, oldest + this.options.windowMs - now) }
    }
    previous.push(now)
    this.hits.set(clientKey, previous)
    if (this.hits.size > 10_000) {
      // Bound memory on abusive clients.
      for (const [key, times] of this.hits) {
        if (times.every(time => time <= windowStart)) this.hits.delete(key)
      }
    }
    return { allowed: true, retryAfterMs: 0 }
  }
}

export function createObservabilityContext(
  options: ObservabilityContextOptions,
): ObservabilityContext {
  const rateLimit: RateLimitOptions = {
    max: options.rateLimit?.max ?? DEFAULT_RATE_LIMIT.max,
    windowMs: options.rateLimit?.windowMs ?? DEFAULT_RATE_LIMIT.windowMs,
  }
  const limiter = new SlidingWindowLimiter(rateLimit, options.now)
  return {
    apiPath: resolveApiPath(options.apiPath),
    getService: options.getService,
    now: options.now ?? Date.now,
    rateLimit,
    bodyLimit: options.bodyLimit ?? DEFAULT_BODY_LIMIT,
    stream: {
      pollMs: options.stream?.pollMs ?? DEFAULT_STREAM.pollMs,
      snapshotEveryMs: options.stream?.snapshotEveryMs ?? DEFAULT_STREAM.snapshotEveryMs,
    },
    takeToken: clientKey => limiter.takeToken(clientKey),
  }
}
