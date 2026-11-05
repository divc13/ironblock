import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { economy } from '../src/config/economy'
import { validateEconomyConfig } from '../src/shared/config-validation'
import { EconomyEngine } from '../src/shared/economy'
import { createObservabilityMiddleware } from '../src/server/observability/http'
import type { ObservabilitySource } from '../src/server/observability/types'
import { asObservabilitySource } from '../src/server/observability/source'

describe('observability HTTP middleware', () => {
  let server: Server
  let origin: string
  let engine: EconomyEngine

  before(async () => {
    const config = validateEconomyConfig(economy)
    engine = new EconomyEngine(config)
    engine.createPlayer('player-secret', 'secret-mail@nowhere.test')
    engine.tick(3600)

    const source = (): ObservabilitySource => asObservabilitySource(engine)
    const middleware = createObservabilityMiddleware({
      apiPath: '/api/market',
      getService: () => source(),
      now: () => Date.now(),
      // Deterministic limiter for the test: 2 per 60s window.
      rateLimit: { max: 2, windowMs: 60_000 },
      bodyLimit: 256,
    })
    // Express-style fallback: when the middleware calls next() the request
    // belongs to the host app, which answers it (404 here).
    server = createServer((request, response) => {
      middleware(request, response, () => {
        response.writeHead(404, { 'Content-Type': 'text/plain' })
        response.end('fell-through')
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as AddressInfo
    origin = `http://127.0.0.1:${address.port}`
  })

  after(async () => {
    // Drop every open socket (SSE keeps its stream alive, fetch keeps pools)
    // so the test process can exit once the server is closed.
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await new Promise<void>(resolve => setImmediate(resolve))
  })

  test('GET /snapshot serves sanitized public data with no-store + CORS', async () => {
    const response = await fetch(`${origin}/api/market/snapshot`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(response.headers.get('access-control-allow-origin'), '*')
    assert.match(response.headers.get('content-type') ?? '', /application\/json/)
    const body = (await response.json()) as { ok: boolean; snapshot: { players?: unknown; tape: unknown[]; merchants: unknown[] } }
    assert.equal(body.ok, true)
    assert.equal('players' in body.snapshot, false)
    assert.ok(body.snapshot.merchants.length === Object.keys(economy.merchants).length)
    const raw = JSON.stringify(body)
    assert.equal(raw.includes('player-secret'), false)
    assert.equal(raw.includes('secret-mail@nowhere.test'), false)
  })

  test('GET /events, /recap, /proof respond with cursor and deployment', async () => {
    const events = await (await fetch(`${origin}/api/market/events?since=0&limit=3`)).json()
    assert.equal(events.count, 3)
    assert.ok(events.cursor >= 3)

    const recap = await (await fetch(`${origin}/api/market/recap`)).json()
    assert.equal(recap.ok, true)
    assert.ok(recap.recap.headline.length > 0)

    const proof = await (await fetch(`${origin}/api/market/proof`)).json()
    assert.equal(proof.proof.contractId, 'v2.ironblock-items.testnet')
    assert.equal(proof.proof.tokenCount, Object.keys(economy.items).length)
  })

  test('OPTIONS preflight is handled without touching next()', async () => {
    const response = await fetch(`${origin}/api/market/snapshot`, { method: 'OPTIONS' })
    assert.equal(response.status, 204)
    assert.equal(response.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS')
  })

  test('non-API paths fall through to the host app', async () => {
    const response = await fetch(`${origin}/game`)
    assert.equal(response.status, 404)
    assert.equal(await response.text(), 'fell-through')
  })

  test('unknown API route returns 404 JSON', async () => {
    const response = await fetch(`${origin}/api/market/bogus`)
    assert.equal(response.status, 404)
    const body = (await response.json()) as { error: string }
    assert.equal(body.error, 'not_found')
  })

  test('POST fast-forward runs a clone, is rate limited, and enforces body cap', async () => {
    const liveBefore = engine.snapshot().sequence

    const first = await fetch(`${origin}/api/market/fast-forward`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ days: 1 }),
    })
    assert.equal(first.status, 200)
    const payload = (await first.json()) as {
      ok: boolean
      mode: string
      days: number
      live: { unchanged: boolean; sequenceBefore: number; sequenceAfter: number }
      timing: { days: number; steps: number }
      series: unknown[]
      finalMerchants: Array<{ id: string; cash: number; reserve: number }>
    }
    assert.equal(payload.ok, true)
    assert.equal(payload.mode, 'deterministic-clone')
    assert.equal(payload.days, 1)
    assert.equal(payload.live.unchanged, true)
    assert.equal(payload.live.sequenceAfter, liveBefore, 'live world untouched')
    assert.equal(payload.series.length, 1)
    assert.equal(payload.finalMerchants.length > 0, true)
    assert.equal(typeof payload.finalMerchants[0].cash, 'number')
    assert.equal(typeof payload.finalMerchants[0].reserve, 'number')
    assert.ok(payload.timing.steps > 0)

    // Invalid body is validated: a malformed payload is rejected with 400
    // (and consumes the second rate-limit token, like any other request).
    const bad = await fetch(`${origin}/api/market/fast-forward`, {
      method: 'POST',
      body: '{not json',
    })
    assert.equal(bad.status, 400)
    assert.equal(((await bad.json()) as { error: string }).error, 'invalid_json')

    // Rate-limit: the window (2 requests) is now exhausted, so a valid clone
    // request inside the window is rejected.
    const third = await fetch(`${origin}/api/market/fast-forward`, {
      method: 'POST',
      body: JSON.stringify({ days: 1 }),
    })
    assert.equal(third.status, 429)
    assert.match(((await third.json()) as { error: string }).error, /rate_limited/)

    // Body larger than the 256-byte cap: the size check runs before the
    // limiter, so it is still answered 413 even inside an exhausted window.
    const tooLarge = await fetch(`${origin}/api/market/fast-forward`, {
      method: 'POST',
      body: JSON.stringify({ days: 1, junk: 'x'.repeat(600) }),
    })
    assert.equal(tooLarge.status, 413)

    // Determinism: same input state + same days => identical series hash.
    const engineState = new EconomyEngine(engine.config, { state: engine.snapshot() })
    const a = engineState.fastForward(1)
    const b = new EconomyEngine(engine.config, { state: engine.snapshot() }).fastForward(1)
    assert.deepEqual(a.series, b.series)
  })

  test('SSE stream emits sanitized snapshot then stays open with pings', async () => {
    // Raw socket request: an SSE stream never ends, so a fetch+reader loop
    // would block the run; we read the first frames and then destroy().
    const frames = await new Promise<string>((resolve, reject) => {
      let buffer = ''
      const req = httpRequest(`${origin}/api/market/stream`, res => {
        assert.equal(res.statusCode, 200)
        assert.match(String(res.headers['content-type']), /text\/event-stream/)
        assert.equal(res.headers['cache-control'], 'no-store')

        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString()
          // Wait until the snapshot's data frame is complete: the retry hint
          // also carries a data line, and the big snapshot frame can span
          // several chunks, so wait for its blank-line terminator.
          const next = buffer.indexOf('event: snapshot\ndata: ')
          if (next >= 0 && buffer.indexOf('\n\n', next) >= 0) {
            res.destroy()
            resolve(buffer)
          }
        })
        res.on('error', reject)
        res.on('close', () => resolve(buffer))
      })
      req.on('error', reject)
      req.end()
      const deadline = setTimeout(() => {
        reject(new Error(`SSE frames not received within 4000ms: got ${JSON.stringify(buffer)}`))
        req.destroy()
      }, 4000)
      // Do not let the deadline keep the process alive after a clean resolve.
      req.on('close', () => clearTimeout(deadline))
    })

    const eventIndex = frames.indexOf('event: snapshot')
    assert.ok(eventIndex >= 0, 'snapshot event should be sent immediately')
    const retryIndex = frames.indexOf('event: retry')
    assert.ok(retryIndex >= 0, 'retry hint should be present')
    assert.ok(retryIndex < eventIndex)

    const dataLine = frames
      .slice(eventIndex)
      .split('\n')
      .find(line => line.startsWith('data: '))
    assert.ok(dataLine, 'snapshot event carries a data frame')
    const parsed = JSON.parse(dataLine!.slice('data: '.length)) as { snapshot: { players?: unknown } }
    assert.equal('players' in parsed.snapshot, false)
    assert.equal(frames.includes('player-secret'), false)
  })
})
