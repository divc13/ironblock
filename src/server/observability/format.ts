import type { EconomyConfig } from '../../shared/types'

/** Currency formatting shared by the recap and annotation builders. */
export function money(config: EconomyConfig, value: number): string {
  const decimals = Math.max(0, Math.floor(config.pricing.rounding.decimals))
  const safe = Number.isFinite(value) ? value : 0
  return `${config.currency.symbol} ${safe.toFixed(decimals)}`
}

/** Simulated wall clock: "day 3, 14:05" style label from engine seconds. */
export function timeLabel(time: number): string {
  const day = Math.floor(time / 86400) + 1
  const seconds = ((time % 86400) + 86400) % 86400
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return `day ${day}, ${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}
