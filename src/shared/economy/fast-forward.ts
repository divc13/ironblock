/**
 * Shared fast-forward timing and event sampling.
 *
 * The economy engine commits the whole simulation in one call, then the client
 * and the server replay the same wall-clock window: the client reveals days and
 * events, while the server walks visible bots to the sampled destinations.
 */

/** Wall-clock length of the accelerated world playback/reveal. */
export const FAST_FORWARD_PLAYBACK_MS = 4_000

export interface FastForwardSampleEvent {
  sequence: number
  time: number
}

/**
 * Pick at most `limit` events spread evenly across the simulated window.
 *
 * A naive `slice(-limit)` clusters the sample at the end of the week; the
 * first-time player then sees almost every revealed event land on the final
 * day. This picks the event nearest the centre of each time bucket instead,
 * reserves one slot for the final/system event, and stays deterministic.
 */
export function sampleFastForwardEvents<T extends FastForwardSampleEvent>(
  events: readonly T[],
  limit: number,
  fromTime: number,
  toTime: number,
): T[] {
  const cappedLimit = Math.max(1, Math.floor(limit))
  if (events.length <= cappedLimit) return [...events]

  const ordered = [...events].sort(
    (left, right) => left.sequence - right.sequence,
  )
  const finalEvent = ordered[ordered.length - 1]
  const pool = ordered.filter(
    event => event.sequence !== finalEvent.sequence,
  )
  const slots = cappedLimit - 1
  if (slots <= 0) return [finalEvent]

  const span = Math.max(1e-9, toTime - fromTime)
  const used = new Set<number>([finalEvent.sequence])
  const chosen: T[] = []

  for (let slot = 0; slot < slots; slot += 1) {
    const target = fromTime + ((slot + 0.5) / slots) * span
    let best: T | null = null
    let bestDistance = Number.POSITIVE_INFINITY
    for (const event of pool) {
      if (used.has(event.sequence)) continue
      const distance = Math.abs(event.time - target)
      if (
        distance < bestDistance ||
        (distance === bestDistance &&
          best !== null &&
          event.sequence < best.sequence)
      ) {
        best = event
        bestDistance = distance
      }
    }
    if (!best) break
    used.add(best.sequence)
    chosen.push(best)
  }

  chosen.push(finalEvent)
  chosen.sort((left, right) => left.sequence - right.sequence)
  return chosen.slice(0, cappedLimit)
}
