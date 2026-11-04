import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { economy } from '../src/config/economy'
import { validateEconomyConfig } from '../src/shared/config-validation'
import { EconomyEngine } from '../src/shared/economy'
import { asObservabilitySource } from '../src/server/observability/source'
import {
  createObservabilityNodeHandler,
  resolveSpectatorFile,
  type ObservabilityNodeMountOptions,
} from '../src/server/observability/node-mount'

const SPECTATOR_HTML = '<!doctype html><html><body>built spectator page</body></html>'
const FALLBACK_HTML = '<!doctype html><html><body>legacy dist/client page</body></html>'
const CUSTOM_HTML = '<!doctype html><html><body>explicit page</body></html>'

describe('observability node mount', () => {
  const servers: Server[] = []
  const origins: string[] = []
  let builtDist = ''
  let legacyDist = ''
  let emptyRoot = ''

  const listen = (handler: ReturnType<typeof createObservabilityNodeHandler>): Promise<string> =>
    new Promise(resolve => {
      const server = createServer((request, response) => {
        handler(request, response, () => {
          // Host fallback: proves next() hands the request back unchanged.
          response.writeHead(404, { 'Content-Type': 'text/plain' })
          response.end('fell-through')
        })
      })
      server.listen(0, '127.0.0.1', () => {
        const address = server.address() as AddressInfo
        servers.push(server)
        const origin = `http://127.0.0.1:${address.port}`
        origins.push(origin)
        resolve(origin)
      })
    })

  before(async () => {
    // Fake economy source: a deterministic, freshly seeded engine. The mount
    // never starts a service itself — the caller supplies getService.
    const engine = new EconomyEngine(validateEconomyConfig(economy))
    engine.createPlayer('player-secret', 'secret-mail@nowhere.test')
    const getService = (): ReturnType<typeof asObservabilitySource> =>
      asObservabilitySource(engine)

    // Built page in dist/spectator.html plus the legacy dist/client layout.
    builtDist = await mkdtemp(join(tmpdir(), 'ironblock-mount-dist-'))
    await mkdir(join(builtDist, 'dist'), { recursive: true })
    await writeFile(join(builtDist, 'dist', 'spectator.html'), SPECTATOR_HTML, 'utf8')
    legacyDist = await mkdtemp(join(tmpdir(), 'ironblock-mount-legacy-'))
    await mkdir(join(legacyDist, 'dist', 'client'), { recursive: true })
    await writeFile(join(legacyDist, 'dist', 'client', 'spectator.html'), FALLBACK_HTML, 'utf8')
    emptyRoot = await mkdtemp(join(tmpdir(), 'ironblock-mount-empty-'))

    // 0: default options (dist/spectator.html is picked up).
    await listen(createObservabilityNodeHandler({ getService, rootDir: builtDist }))
    // 1: legacy layout fallback.
    await listen(createObservabilityNodeHandler({ getService, rootDir: legacyDist }))
    // 2: nothing built => spectator path answers 404.
    await listen(createObservabilityNodeHandler({ getService, rootDir: emptyRoot }))
    // 3: explicit spectatorFile wins over whatever dist/ contains.
    const explicitFile = join(builtDist, 'custom-spectator.html')
    await writeFile(explicitFile, CUSTOM_HTML, 'utf8')
    await listen(createObservabilityNodeHandler({ getService, spectatorFile: explicitFile }))
  })

  after(async () => {
    // Drop open sockets so the test process can exit once servers close.
    for (const server of servers) server.closeAllConnections()
    await Promise.all(
      servers.map(
        server => new Promise<void>(resolve => server.close(() => resolve())),
      ),
    )
    await new Promise<void>(resolve => setImmediate(resolve))
    await Promise.all([
      rm(builtDist, { recursive: true, force: true }),
      rm(legacyDist, { recursive: true, force: true }),
      rm(emptyRoot, { recursive: true, force: true }),
    ])
  })

  test('/spectator, /spectator/ and /spectator.html serve the built page', async () => {
    const [origin] = origins
    for (const path of ['/spectator', '/spectator/', '/spectator.html']) {
      const response = await fetch(`${origin}${path}`)
      assert.equal(response.status, 200, path)
      assert.match(response.headers.get('content-type') ?? '', /text\/html; charset=utf-8/)
      assert.equal(response.headers.get('content-length'), String(SPECTATOR_HTML.length), path)
      assert.equal(await response.text(), SPECTATOR_HTML, path)
    }
  })

  test('dist/client/spectator.html is used when dist/spectator.html is missing', async () => {
    const response = await fetch(`${origins[1]}/spectator`)
    assert.equal(response.status, 200)
    assert.equal(await response.text(), FALLBACK_HTML)
  })

  test('HEAD answers 200 with headers only', async () => {
    const response = await fetch(`${origins[0]}/spectator`, { method: 'HEAD' })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /text\/html; charset=utf-8/)
    assert.equal(response.headers.get('content-length'), String(SPECTATOR_HTML.length))
    assert.equal(await response.text(), '')
  })

  test('explicit spectatorFile wins over the dist/ candidates', async () => {
    const response = await fetch(`${origins[3]}/spectator`)
    assert.equal(response.status, 200)
    assert.equal(await response.text(), CUSTOM_HTML)
  })

  test('/api/market/snapshot reaches the existing observability middleware', async () => {
    const response = await fetch(`${origins[0]}/api/market/snapshot`)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /application\/json/)
    const body = (await response.json()) as { ok: boolean; snapshot: { tape: unknown[] } }
    assert.equal(body.ok, true)
    assert.ok(Array.isArray(body.snapshot.tape))
    // Sanitizing still applies on this mount: secrets never leak.
    const raw = JSON.stringify(body)
    assert.equal(raw.includes('player-secret'), false)
    assert.equal(raw.includes('secret-mail@nowhere.test'), false)
  })

  test('an unrelated path falls through to the host fallback', async () => {
    const response = await fetch(`${origins[0]}/game`)
    assert.equal(response.status, 404)
    assert.equal(await response.text(), 'fell-through')
  })

  test('a missing spectator page answers 404 with a short message', async () => {
    const response = await fetch(`${origins[2]}/spectator`)
    assert.equal(response.status, 404)
    assert.match(response.headers.get('content-type') ?? '', /text\/plain/)
    const text = await response.text()
    assert.match(text, /spectator/i)
    assert.match(text, /npm run build/)
  })

  test('resolveSpectatorFile walks dist/spectator.html -> dist/client/spectator.html', async () => {
    assert.equal(await resolveSpectatorFile(builtDist), join(builtDist, 'dist', 'spectator.html'))
    assert.equal(
      await resolveSpectatorFile(legacyDist),
      join(legacyDist, 'dist', 'client', 'spectator.html'),
    )
    assert.equal(await resolveSpectatorFile(emptyRoot), null)
  })
})
