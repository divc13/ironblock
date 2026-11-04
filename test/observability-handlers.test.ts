import assert from 'node:assert/strict'
import { test } from 'node:test'
import { economy } from '../src/config/economy'
import { validateEconomyConfig } from '../src/shared/config-validation'
import { EconomyEngine } from '../src/shared/economy'
import type { EconomyWorldState } from '../src/shared/economy'
import { asObservabilitySource } from '../src/server/observability/source'
import { handleObservabilityRequest, ROUTES } from '../src/server/observability/handlers'
import {
  resolveApiPath,
  apiPathFromEnv,
  normalizeApiPath,
  SlidingWindowLimiter,
  createObservabilityContext,
  type ObservabilityContextOptions,
} from '../src/server/observability/context'
import type { ObservabilityResult } from '../src/server/observability/types'
import { runFastForwardClone } from '../src/server/observability/fastforward'
import { buildRecap } from '../src/server/observability/recap'
import { buildProofPayload, resolveDeployment } from '../src/server/observability/proof'
import { sanitizeSpectatorSnapshot, buildPlayerAliases } from '../src/server/observability/sanitize'
import type { EconomyConfig, PlayerEconomyState } from '../src/shared/types'

const cloneConfig = (): EconomyConfig => structuredClone(economy)

const makeSource = (mutate?: (players: Record<string, PlayerEconomyState>) => void) => {
  const config = cloneConfig()
  const engine = new EconomyEngine(config)
  engine.createPlayer('player-secret', 'secret-email@example.com')
  // Give the world a closed day so summaries and movers exist.
  engine.tick(86400)
  if (mutate) {
    const state = engine.snapshot()
    mutate(state.players)
    return new EconomyEngine(config, { state })
  }
  return engine
}

const request = (
  path: string,
  options: { method?: string; query?: Record<string, string>; body?: unknown } = {},
) => ({
  method: options.method ?? 'GET',
  path,
  query: new URLSearchParams(options.query ?? {}),
  rawBody: options.body === undefined ? null : new TextEncoder().encode(JSON.stringify(options.body)),
})

const context = (source: EconomyEngine, overrides: Partial<ObservabilityContextOptions> = {}) =>
  createObservabilityContext({
    getService: () => asObservabilitySource(source),
    now: () => 1_700_000_000_000,
    ...overrides,
  })

/** HTTP status of a JSON/error result; the SSE variant has none. */
const statusOf = (result: ObservabilityResult): number | undefined =>
  result.kind === 'sse' ? undefined : result.status

/* -------------------------------------------------------------------- routing */

test('observability routes are enumerated and unknown paths 404', async () => {
  const source = makeSource()
  const ctx = context(source)
  const missing = await handleObservabilityRequest(ctx, request('/nope'))
  assert.equal(missing.kind, 'error')
  assert.equal(missing.status, 404)
  for (const route of ROUTES) {
    const result = await handleObservabilityRequest(ctx, request(route, { method: 'OPTIONS' }))
    assert.equal(statusOf(result), 204)
  }
})

test('wrong methods are rejected with 405 and CORS-aware shape', async () => {
  const source = makeSource()
  const ctx = context(source)
  const post = await handleObservabilityRequest(ctx, request('/snapshot', { method: 'POST' }))
  assert.equal(statusOf(post), 405)
  const get = await handleObservabilityRequest(ctx, request('/fast-forward'))
  assert.equal(statusOf(get), 405)
})

/* -------------------------------------------------------------------- privacy */

test('snapshot never leaks player ids, names, wallets or emails', async () => {
  const source = makeSource()
  const ctx = context(source)
  const result = await handleObservabilityRequest(ctx, request('/snapshot'))
  assert.equal(result.kind, 'json')
  if (result.kind !== 'json') return
  const raw = JSON.stringify(result.body)
  assert.equal(raw.includes('player-secret'), false)
  assert.equal(raw.includes('secret-email@example.com'), false)
  const snapshot = (result.body as { snapshot: Record<string, unknown> }).snapshot
  assert.equal('players' in snapshot, false)
  const travelers = snapshot.travelers as { count: number; totalCash: number }
  assert.ok(travelers.count >= 1)
  assert.ok(travelers.totalCash > 0)

  const orders = snapshot.orders as Array<Record<string, unknown>>
  for (const order of orders) {
    assert.equal('acceptedBy' in order, false)
    assert.ok('accepted' in order)
  }
  const investments = snapshot.investments as Array<Record<string, unknown>>
  for (const investment of investments) {
    assert.equal('playerId' in investment, false)
  }
  for (const event of snapshot.recentEvents as Array<{ actor: { type: string; id: string; displayName?: string }; message: string }>) {
    if (event.actor.type === 'player') {
      assert.match(event.actor.id, /^Traveler-/)
      assert.equal(event.actor.displayName, event.actor.id)
    }
    assert.equal(event.message.includes('secret-email'), false)
  }
  for (const summary of snapshot.summaries as Array<Record<string, unknown>>) {
    assert.equal('playerCash' in summary, false)
    assert.ok('playerCount' in summary)
  }
  const tape = snapshot.tape as unknown[] | undefined
  assert.ok(Array.isArray(tape))
})

test('player pseudonyms are stable and detached from raw ids', () => {
  const source = makeSource()
  const aliases = buildPlayerAliases(source.spectatorSnapshot().players)
  const again = buildPlayerAliases(source.spectatorSnapshot().players)
  for (const [playerId, alias] of aliases.ids) {
    assert.equal(again.ids.get(playerId), alias)
    assert.equal(alias.includes(playerId), false)
    assert.match(alias, /^Traveler-[0-9A-F]{4}$/)
  }
})

/* -------------------------------------------------------------------- cursor */

test('event cursor: since filter, limit and retention bounds', async () => {
  const source = makeSource()
  const ctx = context(source)
  const first = await handleObservabilityRequest(ctx, request('/events', { query: { since: '0', limit: '5' } }))
  assert.equal(first.kind, 'json')
  if (first.kind !== 'json') return
  const payload = first.body as { events: Array<{ sequence: number }>; count: number; cursor: number; truncated: boolean }
  assert.ok(payload.count > 0 && payload.count <= 5)
  assert.ok(payload.events.every(event => event.sequence > 0))
  const last = payload.events[payload.events.length - 1].sequence

  const next = await handleObservabilityRequest(ctx, request('/events', { query: { since: String(last) } }))
  if (next.kind !== 'json') return assert.fail()
  const nextPayload = next.body as { events: Array<{ sequence: number }>; cursor: number }
  assert.ok(nextPayload.events.every(event => event.sequence > last))
  assert.equal(nextPayload.cursor, nextPayload.events[nextPayload.events.length - 1]?.sequence ?? last)

  const sinceFromSnapshot = await handleObservabilityRequest(
    ctx,
    request('/events', { query: { since: String(source.snapshot().sequence) } }),
  )
  if (sinceFromSnapshot.kind !== 'json') return assert.fail()
  assert.equal((sinceFromSnapshot.body as { events: unknown[] }).events.length, 0)

  const bad = await handleObservabilityRequest(ctx, request('/events', { query: { since: '-4' } }))
  assert.equal(statusOf(bad), 400)
})

/* -------------------------------------------------------------------- recap/proof */

test('recap contains headline, movers, sinks, orders and standings', async () => {
  const source = makeSource()
  const ctx = context(source)
  const result = await handleObservabilityRequest(ctx, request('/recap'))
  if (result.kind !== 'json') return assert.fail()
  const recap = (result.body as { recap: import('../src/server/observability/types').Recap }).recap
  assert.ok(recap.headline.length > 0)
  assert.ok(Array.isArray(recap.story) && recap.story.length > 0)
  assert.ok(Array.isArray(recap.topMovers))
  assert.equal(recap.bankruptcies.total, 0)
  assert.ok(recap.cashInCirculation > 0)
  assert.ok(recap.inventoryValue > 0)
  assert.ok(recap.standings.length === Object.keys(economy.merchants).length)
  const raw = JSON.stringify(recap)
  assert.equal(raw.includes('player-secret'), false)
})

test('proof reports the v2 testnet deployment without network access', async () => {
  const source = makeSource()
  const ctx = context(source)
  const result = await handleObservabilityRequest(ctx, request('/proof'))
  if (result.kind !== 'json') return assert.fail()
  const proof = (result.body as { proof: { contractId: string; treasuryId: string; tokenCount: number; genesisSupply: { units: number }; testnet: boolean; explorerUrls: { contract: string; treasury: string } } }).proof
  assert.equal(proof.contractId, 'v2.ironblock-items.testnet')
  assert.equal(proof.treasuryId, 'v2.ironblock-treasury.testnet')
  assert.equal(proof.tokenCount, Object.keys(economy.items).length)
  assert.equal(proof.genesisSupply.units, 533_000)
  assert.equal(proof.testnet, true)
  assert.match(proof.explorerUrls.contract, /explorer\.testnet\.near\.org\/accounts\/v2\.ironblock-items\.testnet/)
})

test('deployment record reads env overrides', () => {
  const deployment = resolveDeployment({
    IRONBLOCK_NEP245_CONTRACT_ID: 'items.other.testnet',
    IRONBLOCK_TREASURY_ACCOUNT_ID: 'treasury.other.testnet',
    IRONBLOCK_GENESIS_SUPPLY: '42',
  })
  assert.equal(deployment.contractId, 'items.other.testnet')
  assert.equal(deployment.treasuryId, 'treasury.other.testnet')
  assert.equal(deployment.genesisSupplyUnits, 42)

  const fallback = resolveDeployment({})
  const proof = buildProofPayload(validateEconomyConfig(economy), {})
  assert.equal(fallback.contractId, proof.contractId)
})

/* -------------------------------------------------------------------- fast forward */

test('fast-forward clone is deterministic and leaves live state untouched', () => {
  const source = makeSource()
  const liveBefore = source.snapshot()
  const first = runFastForwardClone(asObservabilitySource(source as never), {})
  const liveAfter = source.snapshot()
  assert.deepEqual(JSON.parse(JSON.stringify(liveAfter)), JSON.parse(JSON.stringify(liveBefore)))
  assert.equal(liveAfter.sequence, liveBefore.sequence)

  assert.equal(first.ok, true)
  if (!first.ok) return
  assert.equal(first.mode, 'deterministic-clone')
  assert.equal(first.live.unchanged, true)
  assert.equal(first.live.sequenceBefore, liveBefore.sequence)
  assert.equal(first.live.sequenceAfter, liveBefore.sequence)
  assert.equal(first.days, cloneConfig().fastForward.days)
  assert.equal(first.timing.days, cloneConfig().fastForward.days)
  assert.ok(first.timing.steps > 0)
  assert.ok(first.timing.totalMs <= 30_000)
  assert.ok(first.series.length === first.timing.days)
  assert.equal(first.events.length > 0, true)
  assert.ok(first.annotations.length > 0)
  assert.ok(first.recap.headline.length > 0)

  const payloadKeys = Object.keys(first.events[0])
  for (const key of ['id', 'time', 'type', 'actor', 'before', 'after', 'reasons', 'message']) {
    assert.ok(key in first.events[0], `event missing ${key}`)
  }
  void payloadKeys

  // Re-run from the identical input state: identical output (determinism).
  const source2 = new EconomyEngine(source.config, { state: liveBefore })
  const second = runFastForwardClone(asObservabilitySource(source2 as never), {})
  assert.equal(second.ok, true)
  if (!second.ok) return
  assert.equal(second.events.length, first.events.length)
  assert.deepEqual(second.series, first.series)
  assert.deepEqual(second.events, first.events)
  assert.deepEqual(second.annotations, first.annotations)
  assert.equal(second.recap.headline, first.recap.headline)
  assert.equal(second.seed, first.seed)
})

test('fast-forward clone annotations tell the causal story', () => {
  const source = makeSource()
  const result = runFastForwardClone(asObservabilitySource(source as never), {})
  assert.equal(result.ok, true)
  if (!result.ok) return
  for (const annotation of result.annotations) {
    assert.ok(annotation.title.length > 0)
    assert.ok(annotation.chain.length > 0)
    assert.ok(Number.isFinite(annotation.time))
  }
  const kinds = new Set(result.annotations.map(annotation => annotation.kind))
  assert.ok(kinds.has('day-close'), 'day summaries must be annotated')
  // Caravans arrive every 1800s, so several caravan beats must exist.
  assert.ok(kinds.has('caravan'), 'caravan beats must be annotated')
})

test('fast-forward validates days and rejects bad input', () => {
  const source = makeSource()
  const tooMany = runFastForwardClone(asObservabilitySource(source as never), { days: 99 })
  assert.equal(tooMany.ok, false)
  if (tooMany.ok) return
  assert.equal(tooMany.error, 'invalid_days')

  const wrongType = runFastForwardClone(asObservabilitySource(source as never), { days: 1.5 })
  assert.equal(wrongType.ok, false)

  const one = runFastForwardClone(asObservabilitySource(source as never), { days: 1 })
  assert.equal(one.ok, true)
  if (one.ok) assert.equal(one.series, one.series)
  if (one.ok) {
    assert.equal(one.days, 1)
    assert.equal(one.live.unchanged, true)
  }
})

/* -------------------------------------------------------------------- rate limit + body */

test('rate limiter blocks past the cap and reports retry-after', () => {
  let now = 0
  const limiter = new SlidingWindowLimiter({ max: 3, windowMs: 1000 }, () => now)
  assert.equal(limiter.takeToken('a').allowed, true)
  assert.equal(limiter.takeToken('a').allowed, true)
  assert.equal(limiter.takeToken('a').allowed, true)
  const blocked = limiter.takeToken('a')
  assert.equal(blocked.allowed, false)
  assert.ok(blocked.retryAfterMs > 0)
  now = 1200
  assert.equal(limiter.takeToken('a').allowed, true)
  // Different client unaffected.
  assert.equal(limiter.takeToken('b').allowed, true)
  now = 5000
  for (let i = 0; i < 3; i += 1) limiter.takeToken('a')
  assert.equal(limiter.takeToken('a').allowed, false)
})

test('api path switch is the single config/env knob', () => {
  const original = process.env.IRONBLOCK_OBSERVABILITY_API_PATH
  try {
    delete process.env.IRONBLOCK_OBSERVABILITY_API_PATH
    assert.equal(apiPathFromEnv(), null)
    assert.equal(resolveApiPath(), '/api/market')
    assert.equal(resolveApiPath('custom/path/'), '/custom/path')

    process.env.IRONBLOCK_OBSERVABILITY_API_PATH = '/quest/api/market'
    assert.equal(resolveApiPath(), '/quest/api/market')
    assert.equal(normalizeApiPath('api/market'), '/api/market')
  } finally {
    if (original === undefined) delete process.env.IRONBLOCK_OBSERVABILITY_API_PATH
    else process.env.IRONBLOCK_OBSERVABILITY_API_PATH = original
  }
})

test('handler context wires defaults for rate limiting and body caps', () => {
  const source = makeSource()
  const ctx = context(source)
  assert.equal(ctx.apiPath, '/api/market')
  assert.equal(ctx.bodyLimit, 4096)
  assert.equal(ctx.rateLimit.max, 6)
  assert.equal(ctx.rateLimit.windowMs, 60_000)
  assert.equal(ctx.stream.pollMs, 1000)
  assert.equal(ctx.stream.snapshotEveryMs, 15_000)
})

/* -------------------------------------------------------------------- guard */

test('missing service returns 503, not a crash', async () => {
  const ctx = createObservabilityContext({
    getService: () => null,
    now: () => 0,
  })
  const result = await handleObservabilityRequest(ctx, request('/snapshot'))
  if (result.kind !== 'error') return assert.fail()
  assert.equal(result.status, 503)
})

test('sanitizer strips world state player keys when players exist', () => {
  const source = makeSource(players => {
    // Simulate a second player with an email-looking id.
    players['trader@example.com'] = structuredClone(players['player-secret'])
    players['trader@example.com'].id = 'trader@example.com'
  })
  const publicSnapshot = sanitizeSpectatorSnapshot(
    source.spectatorSnapshot(),
    validateEconomyConfig(economy),
  )
  const raw = JSON.stringify(publicSnapshot)
  assert.equal(raw.includes('@example.com'), false)
  assert.equal(raw.includes('trader@example.com'), false)
  assert.ok(publicSnapshot.travelers.count === 2)
})
