import type { MarketEvent, PriceReason, Quote } from '../shared/types'

/**
 * Pure formatting and explanation helpers for the overlay. Kept free of DOM
 * access so they can be unit-tested without a browser.
 */

const DEFAULT_SYMBOL = 'IB'
const DEFAULT_DECIMALS = 2

export const formatMoney = (
  value: number,
  symbol = DEFAULT_SYMBOL,
  decimals = DEFAULT_DECIMALS,
): string => {
  const safe = Number.isFinite(value) ? value : 0
  const sign = safe < 0 ? '−' : ''
  const absolute = Math.abs(safe).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
  return `${sign}${absolute} ${symbol}`
}

export const formatNumber = (value: number): string => {
  const safe = Number.isFinite(value) ? value : 0
  return safe.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

export const formatWeight = (weight: number, capacity: number): string =>
  `${formatNumber(weight)} / ${formatNumber(capacity)} kg`

export const formatStamina = (stamina: number, max: number): string =>
  `${Math.round(stamina)} / ${Math.round(max)}`

export const formatDayClock = (day: number, seconds: number): string => {
  const daySeconds = ((seconds % 86400) + 86400) % 86400
  const hours = Math.floor(daySeconds / 3600)
  const minutes = Math.floor((daySeconds % 3600) / 60)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `Day ${day} · ${pad(hours)}:${pad(minutes)}`
}

export const signedEffect = (effect: number, symbol = DEFAULT_SYMBOL): string => {
  if (!Number.isFinite(effect) || Math.abs(effect) < 0.005) return '±0.00'
  const sign = effect > 0 ? '+' : '−'
  return `${sign}${Math.abs(effect).toFixed(2)} ${symbol}`
}

export const signedPercent = (value: number): string => {
  if (!Number.isFinite(value) || Math.abs(value) < 0.05) return '±0.0%'
  const sign = value > 0 ? '+' : '−'
  return `${sign}${Math.abs(value).toFixed(1)}%`
}

export const reasonValueLabel = (reason: PriceReason): string => {
  if (reason.code === 'stock' || reason.code === 'demand') {
    return `${reason.value >= 0 ? '+' : ''}${(reason.value * 100).toFixed(0)}% pressure`
  }
  if (reason.code === 'cash') {
    return `${(reason.value * 100).toFixed(0)}% cash pressure`
  }
  if (reason.code === 'margin' || reason.code === 'spread') {
    return `${(reason.value * 100).toFixed(2)}% rate`
  }
  if (reason.code === 'rounding') {
    return `${reason.value} decimals`
  }
  if (reason.code === 'clamp') {
    return reason.value > 0 ? `${reason.value.toFixed(2)} limit` : 'inside limits'
  }
  if (reason.code === 'rival') {
    return `${(reason.value * 100).toFixed(0)}% gap`
  }
  if (reason.code === 'base') {
    return reason.value.toFixed(2)
  }
  return Number.isFinite(reason.value) ? String(Math.round(reason.value * 100) / 100) : '—'
}

export interface ReasonSummary {
  /** One short sentence for the quote card. */
  summary: string
  /** Rows suitable for a tooltip/table. */
  rows: Array<{
    label: string
    value: string
    effect: string
    direction: 'up' | 'down' | 'flat'
    detail?: string
  }>
  totalEffect: number
}

const dominantReason = (reasons: PriceReason[]): PriceReason | null => {
  // `base` is the starting price, not pressure applied on top of it. Keep it in
  // the breakdown rows but never call it the biggest factor.
  const priced = reasons.filter(
    reason => reason.code !== 'base' && Math.abs(reason.effect) >= 0.005,
  )
  if (priced.length === 0) return null
  return [...priced].sort((left, right) => Math.abs(right.effect) - Math.abs(left.effect))[0]
}

/**
 * Turns the pricing engine's reasons into plain language plus signed rows.
 * The mock and the real service both return `PriceReason[]`, so this stays
 * presentation-only.
 */
export function summarizeReasons(reasons: PriceReason[]): ReasonSummary {
  const rows = reasons.map(reason => {
    const direction: 'up' | 'down' | 'flat' =
      reason.effect > 0.005 ? 'up' : reason.effect < -0.005 ? 'down' : 'flat'
    return {
      label: reason.label,
      value: reasonValueLabel(reason),
      effect: signedEffect(reason.effect),
      direction,
      detail: reason.detail,
    }
  })

  const totalEffect = reasons.reduce((sum, reason) => sum + reason.effect, 0)
  const base = reasons.find(reason => reason.code === 'base')
  const leader = dominantReason(reasons)

  if (!leader) {
    return {
      summary: 'Price is at the reference value — no pressure applied.',
      rows,
      totalEffect,
    }
  }

  const directionText = leader.effect > 0 ? 'pushing the price up' : 'pulling the price down'
  const baseText = base ? ` from a ${base.value.toFixed(2)} base` : ''
  return {
    summary: `${leader.label} is the biggest factor, ${directionText}${baseText}.`,
    rows,
    totalEffect,
  }
}

const BLOCKED_REASON_LABELS: Record<string, string> = {
  merchant_closed: 'This stall is closed.',
  merchant_below_reserve: 'The merchant is below reserve and cannot trade until invested in.',
  quantity_must_be_positive: 'Choose a quantity first.',
  out_of_stock: 'Out of stock.',
  merchant_cash_exhausted: 'The merchant does not have enough cash for this purchase.',
  insufficient_player_cash: 'You do not have enough cash.',
  insufficient_player_inventory: 'You do not have that many to sell.',
  carry_capacity_exceeded: 'That would exceed your carry capacity.',
  quantity_exceeds_fill_limit: 'That quantity exceeds the fill limit.',
  fill_unavailable: 'This trade cannot be filled right now.',
  unknown_item: 'Unknown item.',
  unknown_merchant: 'Unknown merchant.',
  unknown_personality: 'This merchant has no pricing personality.',
  merchant_does_not_sell_item: 'This merchant does not sell that item.',
  merchant_does_not_buy_item: 'This merchant does not buy that item.',
}

export const blockedReasonLabel = (code: string | undefined): string =>
  code ? (BLOCKED_REASON_LABELS[code] ?? 'This trade is unavailable.') : 'This trade is unavailable.'

/** Explain why a quote cannot be filled, including which limit binds. */
export function explainQuote(quote: Quote, itemName: string): string {
  if (quote.canTrade) {
    if (quote.partialFill) {
      return `Only ${quote.fillQuantity} of ${quote.quantity} can be filled at this price.`
    }
    return `${quote.fillQuantity} × ${itemName} for ${formatMoney(quote.total, quote.currencySymbol)}.`
  }

  const constraints = quote.constraints
  const limitNotes: string[] = []
  if (quote.side === 'buy') {
    if (constraints.maxByStock === 0) limitNotes.push('stall stock is empty')
    if (constraints.maxByPlayerCash === 0) limitNotes.push('not enough cash')
    if (constraints.maxByCarry === 0) limitNotes.push('bag is full')
    if (constraints.maxByTradeLimit === 0) limitNotes.push('trade limit reached')
  } else {
    if (constraints.maxByPlayerInventory === 0) limitNotes.push('nothing to sell')
    if (constraints.maxByMerchantCash === 0) limitNotes.push('merchant cash is exhausted')
  }

  const base = blockedReasonLabel(quote.blockedReason)
  return limitNotes.length > 0 ? `${base} (${limitNotes.join(', ')})` : base
}

const EVENT_TYPE_LABELS: Record<string, string> = {
  'trade.buy': 'Purchase',
  'trade.sell': 'Sale',
  'bot.trade': 'Townsfolk trade',
  'merchant.restock': 'Restock',
  'merchant.bankrupt': 'Bankruptcy',
  'merchant.investment': 'Investment',
  'merchant.price': 'Price move',
  'player.gather': 'Gather',
  'player.craft': 'Craft',
  'player.repair': 'Repair',
  'sink.rent': 'Rent',
  'sink.tax': 'Tax',
  'caravan.arrival': 'Caravan',
  'system.fast-forward': 'Fast-forward',
  'system.configuration': 'Market notice',
}

export const eventTypeLabel = (type: string): string =>
  EVENT_TYPE_LABELS[type] ?? type.replace(/[._]/g, ' ')

export interface EventLine {
  actor: string
  headline: string
  detail: string
  tone: 'neutral' | 'good' | 'warn' | 'bad'
}

const eventTone = (event: MarketEvent): EventLine['tone'] => {
  switch (event.type) {
    case 'merchant.bankrupt':
      return 'bad'
    case 'merchant.investment':
    case 'caravan.arrival':
      return 'good'
    case 'sink.rent':
    case 'sink.tax':
      return 'warn'
    default:
      return 'neutral'
  }
}

/** Short, readable event line for the ticker. */
export function describeEvent(event: MarketEvent, itemName?: string): EventLine {
  const actor = event.actor.displayName ?? event.actor.id
  const item = itemName ?? event.item ?? 'market'
  const price = event.price !== null ? formatMoney(event.price) : ''
  let headline = event.message
  if (event.type === 'trade.buy' || event.type === 'trade.sell') {
    headline =
      event.type === 'trade.buy'
        ? `bought ${event.quantity ?? 0}× ${item} at ${price}`
        : `sold ${event.quantity ?? 0}× ${item} at ${price}`
  } else if (event.type === 'bot.trade') {
    headline = `${event.quantity ?? 0}× ${item} at ${price}`
  } else if (event.type === 'merchant.bankrupt') {
    headline = 'closed below reserve'
  } else if (event.type === 'merchant.investment') {
    headline = `reopened with ${price}`
  } else if (event.type === 'caravan.arrival') {
    headline = `delivered ${event.quantity ?? 0}× ${item}`
  } else if (event.type === 'sink.rent' || event.type === 'sink.tax') {
    headline = `${eventTypeLabel(event.type).toLowerCase()} paid · ${price}`
  }

  const reasons = event.reasons.filter(reason => Math.abs(reason.effect) >= 0.005)
  const detail =
    reasons.length > 0
      ? reasons
          .slice(0, 3)
          .map(reason => `${reason.label} ${signedEffect(reason.effect)}`)
          .join(' · ')
      : event.message

  return {
    actor,
    headline,
    detail,
    tone: eventTone(event),
  }
}

export const townHealthLabel = (health: string): string => {
  switch (health) {
    case 'thriving':
      return 'Thriving'
    case 'stable':
      return 'Stable'
    case 'strained':
      return 'Strained'
    case 'critical':
      return 'Critical'
    default:
      return health
  }
}

export const percentOf = (value: number, max: number): number => {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0
  return Math.max(0, Math.min(100, (value / max) * 100))
}

export const pluralize = (count: number, singular: string, plural = `${singular}s`): string =>
  `${count} ${count === 1 ? singular : plural}`

/** Format a simulation timestamp (seconds since market open) as a short clock. */
export const formatEventTime = (time: number): string =>
  formatDayClock(Math.floor(time / 86400) + 1, time % 86400)
