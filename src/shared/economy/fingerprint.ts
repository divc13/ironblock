import { stableHash64, stableStringify } from '../stable-hash'
import type { EconomyConfig } from '../types'
import type { ConfigFingerprint } from './types'

/** Stable fingerprint used to decide whether a persisted world is still valid. */
export function fingerprintConfig(config: EconomyConfig): ConfigFingerprint {
  return {
    hash: stableHash64(stableStringify(config)),
    version: config.meta.version,
    schemaVersion: config.meta.schemaVersion,
  }
}
