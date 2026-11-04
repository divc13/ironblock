import type {
  PublicSnapshot,
  ObservabilityContext,
  ObservabilityRequest,
  ObservabilityResult,
} from './types'
import { buildRecap } from './recap'
import { buildProofPayload } from './proof'
import { runFastForwardClone } from './fastforward'
import { startMarketStream } from './sse'
import {
  buildPlayerAliases,
  publicizeEvents,
  sanitizeSpectatorSnapshot,
} from './sanitize'

const jsonOk = (body: unknown): ObservabilityResult => ({ kind: 'json', status: 200, body })
const jsonError = (status: number, error: string, message: string): ObservabilityResult => ({
  kind: 'error',
  status,
  body: { error, message },
})

export const ROUTES = [
  '/snapshot',
  '/events',
  '/stream',
  '/recap',
  '/proof',
  '/fast-forward',
] as const

const parseJsonBody = (raw: Uint8Array | null | undefined, limit: number): {
  body: Record<string, unknown> | null
  error: 'too_large' | 'invalid_json' | null
} => {
  if (!raw || raw.byteLength === 0) return { body: {}, error: null }
  if (raw.byteLength > limit) return { body: null, error: 'too_large' }
  try {
    const text = new TextDecoder().decode(raw)
    const parsed = JSON.parse(text) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { body: null, error: 'invalid_json' }
    }
    return { body: parsed as Record<string, unknown>, error: null }
  } catch {
    return { body: null, error: 'invalid_json' }
  }
}

const parseSince = (query: URLSearchParams): { since: number; error: string | null } => {
  const raw = query.get('since')
  if (raw === null || raw === '') return { since: 0, error: null }
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) {
    return { since: 0, error: 'since must be a non-negative number' }
  }
  return { since: Math.floor(value), error: null }
}

const parseLimit = (query: URLSearchParams, fallback: number, maximum: number): number => {
  const raw = query.get('limit')
  if (raw === null) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) return fallback
  return Math.min(Math.floor(value), maximum)
}

export interface RouteMatch {
  path: string
  params: URLSearchParams
}

/**
 * Core API handler. Transport independent: HTTP adapters (Vite middleware,
 * plain Node servers, tests) normalize their request into
 * `ObservabilityRequest` and serialize the returned `ObservabilityResult`.
 *
 * Every response is public, read-only observability data with no-store
 * semantics; only `POST /fast-forward` mutates anything, and it mutates a
 * deterministic clone rather than the live world.
 */
export async function handleObservabilityRequest(
  context: ObservabilityContext,
  request: ObservabilityRequest,
  meta: { clientKey?: string } = {},
): Promise<ObservabilityResult> {
  const path = request.path.replace(/\/+$/, '') || '/'
  const method = request.method.toUpperCase()

  if (method === 'OPTIONS') {
    return { kind: 'json', status: 204, body: null }
  }

  const service = await context.getService()
  if (!service) {
    return jsonError(503, 'economy_unavailable', 'The economy service is not running yet')
  }

  switch (path) {
    case '/snapshot': {
      if (method !== 'GET') return methodNotAllowed('GET')
      return jsonOk({
        ok: true,
        serverTime: context.now(),
        snapshot: sanitizeSpectatorSnapshot(service.spectatorSnapshot(), service.config),
      })
    }

    case '/events': {
      if (method !== 'GET') return methodNotAllowed('GET')
      const { since, error } = parseSince(request.query)
      if (error) return jsonError(400, 'invalid_since', error)
      const limit = parseLimit(request.query, 200, 500)
      const aliases = buildPlayerAliases(service.snapshot().players)
      const all = publicizeEvents(service.eventsSince(since), aliases, service.config)
      const events = all.slice(0, limit)
      return jsonOk({
        ok: true,
        serverTime: context.now(),
        cursor: events.length > 0 ? events[events.length - 1].sequence : Math.max(since, 0),
        events,
        count: events.length,
        totalAvailable: all.length,
        truncated: all.length > events.length,
        firstRetainedSequence: service.firstRetainedSequence ?? null,
      })
    }

    case '/stream': {
      if (method !== 'GET') return methodNotAllowed('GET')
      return {
        kind: 'sse',
        stream: {
          start: send =>
            startMarketStream(context, service, send),
        },
      }
    }

    case '/recap': {
      if (method !== 'GET') return methodNotAllowed('GET')
      const snapshot = sanitizeSpectatorSnapshot(service.spectatorSnapshot(), service.config)
      return jsonOk({
        ok: true,
        serverTime: context.now(),
        recap: buildRecap(snapshot, service.config),
      })
    }

    case '/proof': {
      if (method !== 'GET') return methodNotAllowed('GET')
      return jsonOk({
        ok: true,
        serverTime: context.now(),
        proof: buildProofPayload(service.config),
      })
    }

    case '/fast-forward': {
      if (method !== 'POST') return methodNotAllowed('POST')
      const token = context.takeToken(meta.clientKey ?? 'global')
      if (!token.allowed) {
        return {
          kind: 'error',
          status: 429,
          body: {
            error: 'rate_limited',
            message: `Fast-forward is limited to ${context.rateLimit.max} run(s) per ${Math.round(
              context.rateLimit.windowMs / 1000,
            )}s`,
          },
          headers: { 'Retry-After': String(Math.ceil(token.retryAfterMs / 1000)) },
        }
      }
      const parsed = parseJsonBody(request.rawBody, context.bodyLimit)
      if (parsed.error === 'too_large') {
        return jsonError(413, 'body_too_large', `Body exceeds ${context.bodyLimit} bytes`)
      }
      if (parsed.error === 'invalid_json') {
        return jsonError(400, 'invalid_json', 'Body must be a JSON object')
      }
      const result = runFastForwardClone(service, parsed.body ?? {}, context.now)
      if (!result.ok) {
        const status = result.error === 'invalid_days' ? 400 : 503
        return jsonError(status, result.error, result.message)
      }
      return jsonOk(result)
    }

    default:
      return jsonError(
        404,
        'not_found',
        `Unknown observability route "${path}". Routes: ${ROUTES.join(', ')}`,
      )
  }
}

function methodNotAllowed(allow: string): ObservabilityResult {
  return {
    kind: 'error',
    status: 405,
    body: { error: 'method_not_allowed', message: `Use ${allow} for this route` },
  } as ObservabilityResult
}

export type { PublicSnapshot }
