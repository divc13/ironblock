import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { createFeed } from '../src/spectator/api'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

test('createFeed returns the validation snapshot instead of forcing a second GET', async () => {
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    return {
      ok: true,
      json: async () => ({ ok: true, serverTime: 1, snapshot: { sequence: 42 } }),
    } as unknown as Response
  }) as typeof fetch

  const created = await createFeed()
  assert.equal(created.feed.mode, 'live')
  assert.equal(created.initialSnapshot?.sequence, 42)
  assert.equal(calls, 1, 'the factory should make exactly one snapshot GET')
})

test('createFeed still falls back to the deterministic demo feed with an initial snapshot', async () => {
  globalThis.fetch = (async () => {
    throw new Error('offline')
  }) as typeof fetch

  const created = await createFeed()
  assert.equal(created.feed.mode, 'demo')
  assert.equal(typeof created.initialSnapshot?.sequence, 'number')
  assert.match(created.fallbackReason ?? '', /deterministic local replay/)
})
