import type { EconomyService } from '../economy/service'
import type { EconomyEngine } from '../../shared/economy'
import type { ObservabilitySource } from './types'

/**
 * Adapts the live `EconomyService` (or a raw `EconomyEngine`, which exposes
 * the same read-only members) to the `ObservabilitySource` contract. Adds the
 * retained-event cursor the service does not expose; all members delegate to
 * the source, so nothing here can mutate the world.
 */
export function asObservabilitySource(service: EconomyService | EconomyEngine): ObservabilitySource {
  const engineOwner = service as (EconomyService | EconomyEngine) & {
    engine?: { firstRetainedSequence?: number }
    firstRetainedSequence?: number
  }
  return {
    config: service.config,
    snapshot: () => service.snapshot(),
    spectatorSnapshot: () => service.spectatorSnapshot(),
    eventsSince: sequence => service.eventsSince(sequence),
    get firstRetainedSequence(): number {
      return engineOwner.engine?.firstRetainedSequence ?? engineOwner.firstRetainedSequence ?? 0
    },
  }
}
