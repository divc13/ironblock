import { stableHash64 } from '../stable-hash'

const UINT32_RANGE = 4294967296

/** Turn a stable string seed into the 32-bit state used by the PRNG. */
export function seedToState(seed: string): number {
  return Number.parseInt(stableHash64(seed).slice(0, 8), 16) >>> 0
}

/**
 * Mulberry32. It is small, fast and fully deterministic for a 32-bit state.
 * The state is persisted with the world so a reload continues the same stream.
 */
export class DeterministicRng {
  state: number

  constructor(seed: string, state?: number) {
    this.state = Number.isFinite(state) ? (state as number) >>> 0 : seedToState(seed)
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0
    let value = this.state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / UINT32_RANGE
  }

  /** Inclusive integer range. Invalid or reversed ranges collapse to `min`. */
  int(min: number, max: number): number {
    const low = Math.ceil(Math.min(min, max))
    const high = Math.floor(Math.max(min, max))
    if (!Number.isFinite(low) || !Number.isFinite(high) || high < low) return 0
    return low + Math.floor(this.next() * (high - low + 1))
  }

  chance(probability: number): boolean {
    if (!Number.isFinite(probability)) return false
    return this.next() < Math.min(1, Math.max(0, probability))
  }

  pick<T>(values: readonly T[]): T | undefined {
    if (values.length === 0) return undefined
    return values[this.int(0, values.length - 1)]
  }
}
