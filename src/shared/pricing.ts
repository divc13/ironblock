import { priceBoundsFor } from './price-bounds'
import { stableCompare, stableHashIndex, stableStringify } from './stable-hash'
import type {
  EconomyConfig,
  ItemConfig,
  ItemId,
  MarketState,
  MerchantConfig,
  MerchantState,
  PersonalityConfig,
  PriceReason,
  Quote,
  QuoteConstraints,
  TradeSide,
} from './types'

/**
 * The single pricing-rules file.
 *
 * A quote is always from the player's point of view:
 *   side "buy"  -> the player buys from the merchant, so the merchant's ask is used.
 *   side "sell" -> the player sells to the merchant, so the merchant's bid is used.
 *
 * Order of operations for both bid and ask:
 *   1. item base value
 *   2. stock pressure       (low stock raises the price, excess stock lowers it)
 *   3. recent demand EMA    (demand raises the price)
 *   4. cash pressure        (a cash-thin merchant lowers bids and lifts asks)
 *   5. merchant margin      (buy/sell margin, scaled by personality)
 *   6. market spread        (half-spread, scaled by personality)
 *   7. rival quotes         (pull toward the average competing bid/ask)
 *   8. configured clamps    (multiplier bounds and absolute unit-price bounds)
 *   9. configured rounding
 *
 * Every coefficient comes from EconomyConfig. No merchant or item IDs are
 * referenced here.
 */

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max)

const roundTo = (value: number, decimals: number, mode: EconomyConfig['pricing']['rounding']['mode']): number => {
  const scale = 10 ** Math.max(0, Math.floor(decimals))
  const scaled = value * scale
  const rounded =
    mode === 'floor'
      ? Math.floor(scaled)
      : mode === 'ceil'
        ? Math.ceil(scaled)
        : Math.round(scaled)
  return rounded / scale
}

const roundMoney = (value: number, decimals: number, mode: EconomyConfig['pricing']['rounding']['mode']): number =>
  roundTo(value, decimals, mode)

const totalForQuantity = (
  quantity: number,
  unitPrice: number,
  config: EconomyConfig,
): number =>
  roundMoney(
    quantity * unitPrice,
    config.currency.decimals,
    config.pricing.rounding.mode,
  )

/**
 * Largest quantity whose rounded total does not exceed the available cash.
 * Checking the rounded total (rather than floor(cash / unitPrice)) keeps buyer
 * cash and merchant reserve limits safe when currency precision is coarser than
 * pricing precision.
 */
const maxAffordableQuantity = (
  available: number,
  unitPrice: number,
  config: EconomyConfig,
): number => {
  if (
    !Number.isFinite(available) ||
    !Number.isFinite(unitPrice) ||
    available <= 0 ||
    unitPrice <= 0
  ) {
    return 0
  }

  let quantity = Math.max(0, Math.floor(available / unitPrice))
  while (
    quantity > 0 &&
    totalForQuantity(quantity, unitPrice, config) > available
  ) {
    quantity -= 1
  }
  return quantity
}

/**
 * Cash pressure is 1 at the reserve floor and falls to 0 once the merchant has
 * `comfortMultiple` reserves of excess cash.
 */
export function merchantCashPressure(merchant: MerchantState, config: EconomyConfig): number {
  const comfort = Math.max(
    merchant.reserve * config.pricing.cash.comfortMultiple,
    config.pricing.clamps.minUnitPrice,
  )
  const excess = Math.max(0, merchant.cash - merchant.reserve)
  return clamp(1 - excess / comfort, 0, 1)
}

/** A merchant is bankrupt when cash falls to (or below) its effective reserve threshold. */
export function isMerchantBankrupt(merchant: MerchantState, config: EconomyConfig): boolean {
  return merchant.cash <= merchant.reserve * config.pricing.cash.bankruptcyRatio
}

/** Merchants must be open and above their reserve to trade. */
export function canMerchantTrade(merchant: MerchantState, config: EconomyConfig): boolean {
  return merchant.open && !isMerchantBankrupt(merchant, config)
}

const targetStockFor = (
  merchant: MerchantState,
  merchantConfig: MerchantConfig,
  itemId: ItemId,
  config: EconomyConfig,
): number =>
  Math.max(
    config.pricing.stock.fallbackTargetStock,
    merchant.targetStock[itemId] ??
      merchantConfig.targetStock[itemId] ??
      config.pricing.stock.fallbackTargetStock,
  )

const stockFor = (merchant: MerchantState, itemId: ItemId): number =>
  Math.max(0, merchant.stock[itemId] ?? 0)

interface PricedSide {
  unitPrice: number
  reasons: PriceReason[]
}

/**
 * Computes one side without consulting rivals. Rival discovery calls this
 * function with includeRivals=false, which keeps the pricing graph acyclic.
 */
const computeSidePrice = (
  merchant: MerchantState,
  merchantConfig: MerchantConfig,
  item: ItemConfig,
  personality: PersonalityConfig,
  side: TradeSide,
  market: MarketState,
  config: EconomyConfig,
  includeRivals: boolean,
): PricedSide => {
  const reasons: PriceReason[] = []
  const bounds = priceBoundsFor(item, config)
  const upperBound = Math.max(bounds.min, bounds.max)
  const targetStock = targetStockFor(merchant, merchantConfig, item.id, config)
  const stock = stockFor(merchant, item.id)
  const demandEma = Math.max(0, merchant.demandEma[item.id] ?? 0)
  const cashPressure = merchantCashPressure(merchant, config)

  let price = item.baseValue
  reasons.push({
    code: 'base',
    label: 'Base value',
    value: item.baseValue,
    effect: 0,
    detail: `${item.displayName} reference value`,
  })

  const stockPressure = clamp((targetStock - stock) / targetStock, -1, 1)
  const stockFactor = clamp(
    1 + config.pricing.stock.elasticity * personality.stockSensitivity * stockPressure,
    config.pricing.stock.minFactor,
    config.pricing.stock.maxFactor,
  )
  let previous = price
  price *= stockFactor
  reasons.push({
    code: 'stock',
    label: stockPressure >= 0 ? 'Low stock' : 'Excess stock',
    value: stockPressure,
    effect: price - previous,
    detail: `Stock ${stock} vs target ${targetStock}`,
  })

  const demandPressure = clamp(
    demandEma / targetStock,
    0,
    config.pricing.demand.maxPressure,
  )
  const demandFactor =
    1 + config.pricing.demand.weight * personality.demandSensitivity * demandPressure
  previous = price
  price *= demandFactor
  reasons.push({
    code: 'demand',
    label: 'Recent demand',
    value: demandPressure,
    effect: price - previous,
    detail: `Demand EMA ${demandEma} units over ${config.pricing.demand.windowSeconds}s`,
  })

  const cashSensitivity =
    side === 'buy' ? personality.cashAskSensitivity : personality.cashBidSensitivity
  const cashWeight =
    side === 'buy' ? config.pricing.cash.askWeight : config.pricing.cash.bidWeight
  const cashDirection = side === 'buy' ? 1 : -1
  const cashFactor = clamp(
    1 +
      cashDirection *
        config.pricing.cash.weight *
        cashWeight *
        cashSensitivity *
        cashPressure,
    config.pricing.cash.minFactor,
    config.pricing.cash.maxFactor,
  )
  previous = price
  price *= cashFactor
  reasons.push({
    code: 'cash',
    label: 'Cash pressure',
    value: cashPressure,
    effect: price - previous,
    detail: `Cash ${merchant.cash} vs reserve ${merchant.reserve}`,
  })

  const marginRate =
    side === 'buy'
      ? merchantConfig.margins.sell * personality.sellMarginMultiplier
      : merchantConfig.margins.buy * personality.buyMarginMultiplier
  const marginFactor = side === 'buy' ? 1 + marginRate : 1 - marginRate
  previous = price
  price *= marginFactor
  reasons.push({
    code: 'margin',
    label: side === 'buy' ? 'Sell margin' : 'Buy margin',
    value: marginRate,
    effect: price - previous,
    detail: `${(marginRate * 100).toFixed(2)}% ${side === 'buy' ? 'above' : 'below'} reference`,
  })

  const spreadRate = clamp(
    config.pricing.spread.base * personality.spreadMultiplier,
    config.pricing.spread.min,
    config.pricing.spread.max,
  )
  const spreadFactor = side === 'buy' ? 1 + spreadRate : 1 - spreadRate
  previous = price
  price *= spreadFactor
  reasons.push({
    code: 'spread',
    label: 'Market spread',
    value: spreadRate,
    effect: price - previous,
    detail: `${(spreadRate * 100).toFixed(2)}% half-spread`,
  })

  let rivalGap = 0
  let rivalDetail = 'No competing quotes'
  if (includeRivals) {
    const rivalReference = rivalReferencePrice(
      merchant,
      item,
      side,
      market,
      config,
    )
    if (rivalReference !== null && rivalReference > 0) {
      rivalGap = clamp(
        (rivalReference - price) / Math.max(rivalReference, config.pricing.clamps.minUnitPrice),
        -1,
        1,
      )
      rivalDetail = `Rival reference ${rivalReference.toFixed(config.pricing.rounding.decimals)}`
    }
    const rivalFactor = clamp(
      1 +
        config.pricing.rival.weight *
          personality.rivalSensitivity *
          rivalGap,
      1 - config.pricing.rival.maxAdjustment,
      1 + config.pricing.rival.maxAdjustment,
    )
    previous = price
    price *= rivalFactor
  }
  reasons.push({
    code: 'rival',
    label: 'Rival quotes',
    value: rivalGap,
    effect: includeRivals ? price - previous : 0,
    detail: rivalDetail,
  })

  previous = price
  const clamped = clamp(price, bounds.min, upperBound)
  price = clamped
  reasons.push({
    code: 'clamp',
    label: clamped === bounds.min ? 'Price floor' : clamped === upperBound ? 'Price ceiling' : 'Price clamps',
    value: clamped === bounds.min ? bounds.min : clamped === upperBound ? upperBound : 0,
    effect: price - previous,
    detail: `Allowed range ${bounds.min.toFixed(config.pricing.rounding.decimals)}-${upperBound.toFixed(config.pricing.rounding.decimals)}`,
  })

  previous = price
  const rounded = roundTo(price, config.pricing.rounding.decimals, config.pricing.rounding.mode)
  price = clamp(rounded, bounds.min, upperBound)
  reasons.push({
    code: 'rounding',
    label: 'Rounding',
    value: config.pricing.rounding.decimals,
    effect: price - previous,
    detail: `${config.pricing.rounding.mode} to ${config.pricing.rounding.decimals} decimals`,
  })

  return { unitPrice: price, reasons }
}

/**
 * Selects the deterministic rival sample used for a quote.
 *
 * Candidates are ordered by stable codepoint, then the ordered list is rotated
 * by a hash of the market context. The rotation is stable for a given market
 * bucket but changes over time, so no merchant is permanently favoured by an
 * alphabetical prefix.
 */
export function selectRivalMerchants(
  merchant: MerchantState,
  itemId: ItemId,
  side: TradeSide,
  market: MarketState,
  config: EconomyConfig,
): MerchantState[] {
  const maxRivals = Math.max(0, Math.floor(config.pricing.rival.maxRivals))
  if (maxRivals === 0) return []

  const ordered = Object.values(market.merchants)
    .filter(candidate => candidate.id !== merchant.id)
    .filter(candidate => canMerchantTrade(candidate, config))
    .filter(candidate => Boolean(config.personalities[candidate.personality]))
    .filter(candidate => {
      const candidateConfig = config.merchants[candidate.id]
      if (!candidateConfig) return false
      if (side === 'buy') {
        return (
          candidateConfig.sells.includes(itemId) &&
          stockFor(candidate, itemId) > 0
        )
      }
      return (
        candidateConfig.buys.includes(itemId) &&
        candidate.cash > candidate.reserve
      )
    })
    .sort((left, right) => stableCompare(left.id, right.id))

  if (ordered.length <= maxRivals) return ordered

  const bucket = Math.floor(
    Math.max(0, market.time) / config.pricing.rival.rotationSeconds,
  )
  const rotationKey = stableStringify([
    market.seed,
    merchant.id,
    itemId,
    side,
    market.day,
    bucket,
  ])
  const offset = stableHashIndex(rotationKey, ordered.length)

  return [...ordered.slice(offset), ...ordered.slice(0, offset)].slice(
    0,
    maxRivals,
  )
}

const rivalReferencePrice = (
  merchant: MerchantState,
  item: ItemConfig,
  side: TradeSide,
  market: MarketState,
  config: EconomyConfig,
): number | null => {
  const rivals = selectRivalMerchants(
    merchant,
    item.id,
    side,
    market,
    config,
  )

  if (rivals.length === 0) return null

  const prices = rivals.map(rival => {
    const rivalConfig = config.merchants[rival.id]
    const rivalPersonality = config.personalities[rival.personality]
    return computeSidePrice(
      rival,
      rivalConfig,
      item,
      rivalPersonality,
      side,
      market,
      config,
      false,
    ).unitPrice
  })

  return prices.reduce((sum, value) => sum + value, 0) / prices.length
}

const emptyConstraints = (): QuoteConstraints => ({
  stock: 0,
  merchantCash: 0,
  merchantReserve: 0,
  playerCash: null,
  playerInventory: null,
  playerCarryFree: null,
  maxByStock: 0,
  maxByMerchantCash: null,
  maxByPlayerCash: null,
  maxByPlayerInventory: null,
  maxByCarry: null,
  maxByTradeLimit: 0,
  maxFill: 0,
})

const blockedQuote = (
  merchant: MerchantState,
  itemId: ItemId,
  side: TradeSide,
  quantity: number,
  config: EconomyConfig,
  item: ItemConfig | undefined,
  blockedReason: string,
): Quote => ({
  merchantId: merchant.id,
  itemId,
  side,
  quantity,
  basePrice: item?.baseValue ?? 0,
  unitPrice: 0,
  total: 0,
  currencySymbol: config.currency.symbol,
  reasons: [],
  canTrade: false,
  fillQuantity: 0,
  maxQuantity: 0,
  partialFill: false,
  merchantOpen: merchant.open,
  merchantBankrupt: isMerchantBankrupt(merchant, config),
  constraints: emptyConstraints(),
  blockedReason,
})

const inventoryWeight = (market: MarketState, config: EconomyConfig): number => {
  if (!market.player) return 0
  return Object.entries(market.player.inventory).reduce((total, [itemId, quantity]) => {
    const item = config.items[itemId]
    if (!item) return total
    return total + Math.max(0, quantity) * item.weight
  }, 0)
}

/**
 * Builds a complete quote, including reasons, fill limits and cash constraints.
 * The function is pure: it reads state but never mutates it.
 */
export function quote(
  merchant: MerchantState,
  item: ItemId | ItemConfig,
  side: TradeSide,
  quantity: number,
  market: MarketState,
  config: EconomyConfig,
): Quote {
  const requested = Number.isFinite(quantity) ? Math.max(0, Math.floor(quantity)) : 0
  const itemId = typeof item === 'string' ? item : item.id
  const itemConfig = typeof item === 'string' ? config.items[item] : item
  const merchantConfig = config.merchants[merchant.id]
  const personality = config.personalities[merchant.personality]

  if (!itemConfig) {
    return blockedQuote(merchant, itemId, side, requested, config, undefined, 'unknown_item')
  }
  if (!merchantConfig) {
    return blockedQuote(merchant, itemId, side, requested, config, itemConfig, 'unknown_merchant')
  }
  if (!personality) {
    return blockedQuote(merchant, itemId, side, requested, config, itemConfig, 'unknown_personality')
  }

  const offers = side === 'buy' ? merchantConfig.sells : merchantConfig.buys
  if (!offers.includes(itemId)) {
    return blockedQuote(
      merchant,
      itemId,
      side,
      requested,
      config,
      itemConfig,
      side === 'buy' ? 'merchant_does_not_sell_item' : 'merchant_does_not_buy_item',
    )
  }

  const priced = computeSidePrice(
    merchant,
    merchantConfig,
    itemConfig,
    personality,
    side,
    market,
    config,
    true,
  )

  const reasons = [...priced.reasons]
  let unitPrice = priced.unitPrice
  const bounds = priceBoundsFor(itemConfig, config)
  const upperBound = Math.max(bounds.min, bounds.max)

  // Never return a crossed quote if the merchant both buys and sells the item.
  const oppositeSide: TradeSide = side === 'buy' ? 'sell' : 'buy'
  const oppositeOffers =
    oppositeSide === 'buy' ? merchantConfig.sells : merchantConfig.buys
  if (oppositeOffers.includes(itemId)) {
    const opposite = computeSidePrice(
      merchant,
      merchantConfig,
      itemConfig,
      personality,
      oppositeSide,
      market,
      config,
      true,
    )
    const crossed =
      side === 'buy'
        ? unitPrice < opposite.unitPrice
        : unitPrice > opposite.unitPrice
    if (crossed) {
      const guarded = clamp(
        roundTo(
          (unitPrice + opposite.unitPrice) / 2,
          config.pricing.rounding.decimals,
          config.pricing.rounding.mode,
        ),
        bounds.min,
        upperBound,
      )
      reasons.push({
        code: 'spread-guard',
        label: 'Bid/ask guard',
        value: opposite.unitPrice,
        effect: guarded - unitPrice,
        detail: 'Quote moved to the midpoint to keep the spread positive',
      })
      unitPrice = guarded
    }
  }

  const bankrupt = isMerchantBankrupt(merchant, config)
  if (!merchant.open || bankrupt) {
    reasons.push({
      code: bankrupt ? 'merchant-bankrupt' : 'merchant-closed',
      label: bankrupt ? 'Merchant below reserve' : 'Merchant closed',
      value: merchant.cash,
      effect: 0,
      detail: bankrupt
        ? `Cash ${merchant.cash} is at or below reserve ${merchant.reserve}`
        : 'Stall is closed for business',
    })
  }

  const stock = stockFor(merchant, itemId)
  const targetStock = targetStockFor(merchant, merchantConfig, itemId, config)
  const maxStockForPurchases = targetStock * config.pricing.trade.maxStockMultiple
  const maxByStock =
    side === 'buy'
      ? Math.max(0, Math.floor(stock))
      : Math.max(0, Math.floor(maxStockForPurchases - stock))
  const maxByMerchantCash =
    side === 'sell'
      ? maxAffordableQuantity(
          Math.max(0, merchant.cash - merchant.reserve),
          unitPrice,
          config,
        )
      : null

  let playerCash: number | null = null
  let playerInventory: number | null = null
  let playerCarryFree: number | null = null
  let maxByPlayerCash: number | null = null
  let maxByPlayerInventory: number | null = null
  let maxByCarry: number | null = null

  if (market.player) {
    playerCash = Math.max(0, market.player.cash)
    if (side === 'buy') {
      maxByPlayerCash = maxAffordableQuantity(playerCash, unitPrice, config)
    } else {
      playerInventory = Math.max(
        0,
        Math.floor(market.player.inventory[itemId] ?? 0),
      )
      maxByPlayerInventory = playerInventory
    }

    if (side === 'buy') {
      playerCarryFree = Math.max(
        0,
        config.player.carryCapacity - inventoryWeight(market, config),
      )
      maxByCarry =
        itemConfig.weight > 0
          ? Math.max(0, Math.floor(playerCarryFree / itemConfig.weight))
          : null
    }
  }

  const maxByTradeLimit = config.pricing.trade.maxQuantityPerTrade
  const finiteLimits = [
    maxByStock,
    maxByMerchantCash,
    maxByPlayerCash,
    maxByPlayerInventory,
    maxByCarry,
    maxByTradeLimit,
  ].filter((value): value is number => value !== null)
  const maxQuantity = Math.max(0, Math.min(...finiteLimits))

  let fillQuantity = Math.min(requested, maxQuantity)
  if (
    !config.pricing.trade.allowPartialFills &&
    requested > maxQuantity
  ) {
    fillQuantity = 0
  }
  if (requested === 0) fillQuantity = 0

  const canTrade =
    fillQuantity > 0 && merchant.open && !bankrupt
  const partialFill = fillQuantity > 0 && fillQuantity < requested
  const total =
    fillQuantity > 0
      ? totalForQuantity(fillQuantity, unitPrice, config)
      : 0

  let blockedReason: string | undefined
  if (!merchant.open) {
    blockedReason = 'merchant_closed'
  } else if (bankrupt) {
    blockedReason = 'merchant_below_reserve'
  } else if (requested === 0) {
    blockedReason = 'quantity_must_be_positive'
  } else if (fillQuantity === 0) {
    if (side === 'buy' && maxByStock === 0) {
      blockedReason = 'out_of_stock'
    } else if (side === 'sell' && maxByMerchantCash === 0) {
      blockedReason = 'merchant_cash_exhausted'
    } else if (side === 'buy' && maxByPlayerCash === 0) {
      blockedReason = 'insufficient_player_cash'
    } else if (side === 'sell' && maxByPlayerInventory === 0) {
      blockedReason = 'insufficient_player_inventory'
    } else if (side === 'buy' && maxByCarry === 0) {
      blockedReason = 'carry_capacity_exceeded'
    } else if (
      !config.pricing.trade.allowPartialFills &&
      requested > maxQuantity
    ) {
      blockedReason = 'quantity_exceeds_fill_limit'
    } else {
      blockedReason = 'fill_unavailable'
    }
  }

  return {
    merchantId: merchant.id,
    itemId,
    side,
    quantity: requested,
    basePrice: itemConfig.baseValue,
    unitPrice,
    total,
    currencySymbol: config.currency.symbol,
    reasons,
    canTrade,
    fillQuantity,
    maxQuantity,
    partialFill,
    merchantOpen: merchant.open,
    merchantBankrupt: bankrupt,
    constraints: {
      stock,
      merchantCash: merchant.cash,
      merchantReserve: merchant.reserve,
      playerCash,
      playerInventory,
      playerCarryFree,
      maxByStock,
      maxByMerchantCash,
      maxByPlayerCash,
      maxByPlayerInventory,
      maxByCarry,
      maxByTradeLimit,
      maxFill: maxQuantity,
    },
    blockedReason,
  }
}

export default quote
