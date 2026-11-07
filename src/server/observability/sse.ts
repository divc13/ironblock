import type { SequencedMarketEvent } from '../../shared/economy'
import type {
  ObservabilityContext,
  ObservabilitySource,
  ObservabilityStreamSender,
  PublicSnapshot,
} from './types'
import {
  buildPlayerAliases,
  publicizeEvents,
  sanitizeSpectatorSnapshot,
} from './sanitize'

export interface MarketStreamOptions {
  /** Events sent per `events` message at most. */
  batchLimit?: number
}

const DEFAULT_BATCH_LIMIT = 500

/**
 * Server-Sent Events producer for the market feed.
 *
 * Message sequence per client:
 *   1. `: comment` — stream banner
 *   2. `retry:` field — reconnect delay
 *   3. `snapshot`  — full sanitized spectator snapshot (initial state)
 *   4. `events`    — batches of new sequenced events as the world advances
 *   5. `snapshot`  — refreshed every `snapshotEveryMs` so slow tabs resync,
 *                    even while events are flowing
 *   + `: ping` comments so proxies keep the connection open
 *
 * The producer never blocks or mutates the economy: it only reads. The
 * returned disposer clears all timers; transports must call it on disconnect.
 */
export function startMarketStream(
  context: ObservabilityContext,
  service: ObservabilitySource,
  send: ObservabilityStreamSender,
  options: MarketStreamOptions = {},
): () => void {
  const batchLimit = options.batchLimit ?? DEFAULT_BATCH_LIMIT
  let disposed = false

  const publicize = (events: SequencedMarketEvent[]): SequencedMarketEvent[] => {
    if (events.length === 0) return events
    return publicizeEvents(events, buildPlayerAliases(service.snapshot().players), service.config)
  }

  let cursor = 0

  const sendSnapshot = (advanceCursor: boolean): void => {
    if (disposed) return
    const snapshot: PublicSnapshot = sanitizeSpectatorSnapshot(
      service.spectatorSnapshot(),
      service.config,
    )
    // The initial snapshot establishes the event cursor. Periodic snapshots
    // must not skip events that have not been delivered yet (for example when
    // a batch was truncated), so they only advance the cursor when every
    // pending event was sent first.
    if (advanceCursor) cursor = Math.max(cursor, snapshot.sequence)
    send.event('snapshot', JSON.stringify({ ok: true, serverTime: context.now(), snapshot }))
  }

  send.comment(`ironblock market stream; api path ${context.apiPath}`)
  send.retry(3000)
  sendSnapshot(true)

  let lastSnapshotAt = context.now()

  const poll = (): void => {
    if (disposed) return
    try {
      const now = context.now()
      const events = publicize(service.eventsSince(cursor))
      let sent = false
      if (events.length > 0) {
        const batch = events.slice(0, batchLimit)
        cursor = batch[batch.length - 1].sequence
        send.event(
          'events',
          JSON.stringify({
            ok: true,
            serverTime: now,
            cursor,
            events: batch,
            truncated: events.length > batch.length,
          }),
        )
        sent = true
      }
      if (now - lastSnapshotAt >= context.stream.snapshotEveryMs) {
        // Send the batch first so the snapshot does not hide undelivered
        // events. Only advance the cursor when the batch was not truncated.
        sendSnapshot(events.length <= batchLimit)
        lastSnapshotAt = now
        sent = true
      }
      if (!sent) send.comment(`ping ${now}`)
    } catch (cause) {
      // Never kill the stream for a read error; report once as a comment.
      send.comment(`read-error ${(cause as Error).message}`)
    }
  }

  const timer = setInterval(poll, context.stream.pollMs)
  return () => {
    if (disposed) return
    disposed = true
    clearInterval(timer)
  }
}
