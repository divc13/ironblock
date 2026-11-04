import type { EconomyConfig, ItemConfig } from './types'

export interface PriceBounds {
  min: number
  max: number
  /** False when the configured floor is above the configured ceiling. */
  valid: boolean
}

/**
 * Single source of truth for the configured unit-price bounds. Both validation
 * and pricing consume this helper so they cannot drift apart.
 */
export function priceBoundsFor(
  item: Pick<ItemConfig, 'baseValue'>,
  config: EconomyConfig,
): PriceBounds {
  const min = Math.max(
    item.baseValue * config.pricing.clamps.minMultiplier,
    config.pricing.clamps.minUnitPrice,
  )
  const max = Math.min(
    item.baseValue * config.pricing.clamps.maxMultiplier,
    config.pricing.clamps.maxUnitPrice,
  )
  return { min, max, valid: min <= max }
}
