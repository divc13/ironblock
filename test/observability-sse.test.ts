import assert from 'node:assert/strict'
import { test } from 'node:test'
import { economy } from '../src/config/economy'
import { validateEconomyConfig } from '../src/shared/config-validation'
import { EconomyEngine } from '../src/shared/economy'
import { startMarketStream } from '../src/server/observability/sse'
import { asObservabilitySource } from '../src/server/observability/source'
import type {
  ObservabilityContext,
  ObservabilitySource,
  ObservabilityStreamSender,
} from '../src/server/observability/types'

interface Frame {
  name: 'comment' | 'retry' | 'snapshot' | 'events'
  data: string
  at: number
}

test('SSE refreshes snapshots while events are continuously available', async () => {
  const config = validateEconomyConfig(structuredClone(economy))
  const engine = new EconomyEngine(config)
  engine.tick(3600)

  const base = asObservabilitySource(engine)
  const template = base.eventsSince(0).at(-1) ?? base.spectatorSnapshot().recentEvents.at(-1)
  assert.ok(template, 'test engine should have produced at least one event')

  let syntheticSequence = 0
  const busySource: ObservabilitySource = {
    config: base.config,
    snapshot: () => base.snapshot(),
    spectatorSnapshot: () => base.spectatorSnapshot(),
    // Always return a fresh event so the stream never enters the idle branch.
    eventsSince: sequence => {
      syntheticSequence += 1
      return [
        {
          ...structuredClone(template),
          id: `synthetic-${syntheticSequence}`,
          sequence: sequence + syntheticSequence,
          time: template.time + syntheticSequence,
        },
      ]
    },
    firstRetainedSequence: 0,
  }

  const frames: Frame[] = []
  const started = Date.now()
  const sender: ObservabilityStreamSender = {
    event: (name, data) => frames.push({ name: name as Frame['name'], data, at: Date.now() - started }),
    comment: text => frames.push({ name: 'comment', data: text, at: Date.now() - started }),
    retry: milliseconds => frames.push({ name: 'retry', data: String(milliseconds), at: Date.now() - started }),
  }

  const context: ObservabilityContext = {
    apiPath: '/api/market',
    getService: () => busySource,
    now: () => Date.now(),
    rateLimit: { max: 0, windowMs: 0 },
    bodyLimit: 0,
    stream: { pollMs: 10, snapshotEveryMs: 100 },
    takeToken: () => ({ allowed: true, retryAfterMs: 0 }),
  }

  const dispose = startMarketStream(context, busySource, sender)
  await new Promise(resolve => setTimeout(resolve, 450))
  dispose()

  const snapshots = frames.filter(frame => frame.name === 'snapshot')
  const events = frames.filter(frame => frame.name === 'events')
  assert.ok(events.length >= 2, `expected event frames, got ${JSON.stringify(frames)}`)
  assert.ok(snapshots.length >= 2, `expected initial plus periodic snapshots, got ${JSON.stringify(frames)}`)

  const retryIndex = frames.findIndex(frame => frame.name === 'retry')
  const snapshotIndex = frames.findIndex(frame => frame.name === 'snapshot')
  assert.ok(retryIndex >= 0, 'retry field should be sent')
  assert.ok(retryIndex < snapshotIndex, 'retry field should precede the initial snapshot')
  assert.equal(frames[retryIndex].data, '3000')

  const firstEvent = frames.findIndex(frame => frame.name === 'events')
  assert.ok(firstEvent >= 0)
  assert.ok(
    snapshots.some(snapshot => frames.indexOf(snapshot) > firstEvent),
    'at least one snapshot should be sent after events have started',
  )
  for (let index = 1; index < frames.length; index += 1) {
    assert.notEqual(
      `${frames[index - 1].name}:${frames[index].name}`,
      'snapshot:snapshot',
      'consecutive polls must not send duplicate snapshots',
    )
  }
})
