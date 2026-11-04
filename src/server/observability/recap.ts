import { stableCompare } from '../../shared/stable-hash'
import type { PriceMover } from '../../shared/economy'
import type { EconomyConfig } from '../../shared/types'
import { money } from './format'
import type { PublicSnapshot, Recap, RecapMerchantStanding } from './types'

const dayKey = (merchantId: string, itemId: string): string => `${merchantId}:${itemId}`

/**
 * Top price movers for the *current, unfinished* day, computed the same way the
 * engine scores closed days: day-open snapshot price vs current quote.
 */
function currentDayMovers(snapshot: PublicSnapshot, config: EconomyConfig): PriceMover[] {
  const movers: PriceMover[] = []
  for (const merchant of snapshot.merchants) {
    for (const [itemId, ask] of Object.entries(merchant.askPrices)) {
      const open = snapshot.daily.priceSnapshot[dayKey(merchant.id, itemId)]
      const openPrice = open?.ask ?? open?.bid ?? null
      if (openPrice === null || openPrice <= 0) continue
      movers.push({
        merchantId: merchant.id,
        itemId,
        open: openPrice,
        close: ask,
        changePct: ((ask - openPrice) / openPrice) * 100,
      })
    }
  }
  movers.sort((left, right) => {
    const difference = Math.abs(right.changePct) - Math.abs(left.changePct)
    if (difference !== 0) return difference
    const merchantOrder = stableCompare(left.merchantId, right.merchantId)
    if (merchantOrder !== 0) return merchantOrder
    return stableCompare(left.itemId, right.itemId)
  })
  return movers.slice(0, Math.max(1, Math.floor(config.reporting.topMovers)))
}

const displayName = (snapshot: PublicSnapshot, merchantId: string): string =>
  snapshot.merchants.find(merchant => merchant.id === merchantId)?.displayName ?? merchantId

const itemDisplayName = (config: EconomyConfig, itemId: string): string =>
  config.items[itemId]?.displayName ?? itemId

/**
 * Builds the end-of-day recap ("town newspaper") from a public snapshot.
 *
 * All copy is derived deterministically from engine data — no random text and
 * no private identity data. The most recent *closed* day wins; when the day is
 * still running the live daily accumulator is used instead.
 */
export function buildRecap(snapshot: PublicSnapshot, config: EconomyConfig): Recap {
  const latestSummary = snapshot.summaries[snapshot.summaries.length - 1] ?? null
  const closed = latestSummary !== null && latestSummary.day === snapshot.day
  const dayNumbers = snapshot.summaries.map(summary => summary.day)
  const totalDays = dayNumbers.length

  const trades = closed ? latestSummary.trades : snapshot.daily.trades
  const botTrades = closed ? latestSummary.botTrades : snapshot.daily.botTrades
  const bankruptcies = closed ? latestSummary.bankruptcies : snapshot.daily.bankruptcies
  const investments = closed ? latestSummary.investments : snapshot.daily.investments
  const caravan = closed ? latestSummary.caravan : snapshot.daily.caravan
  const sinks = closed ? latestSummary.sinks : snapshot.daily.sinks
  const orders = closed ? latestSummary.orders : snapshot.daily.orders

  const movers: PriceMover[] = closed && latestSummary.topMovers.length > 0
    ? latestSummary.topMovers
    : currentDayMovers(snapshot, config)

  // Merchant standings: cash change since the day opened (public data only).
  const standings: RecapMerchantStanding[] = snapshot.merchants
    .map(merchant => {
      const start = snapshot.daily.merchantCashStart[merchant.id] ?? merchant.cash
      return {
        merchantId: merchant.id,
        displayName: merchant.displayName,
        cashChange: Math.round((merchant.cash - start) * 100) / 100,
        cash: merchant.cash,
        open: merchant.open,
        bankrupt: merchant.bankrupt,
      }
    })
    .sort((left, right) => stableCompare(left.merchantId, right.merchantId))
  const sortedByChange = [...standings].sort((left, right) => right.cashChange - left.cashChange)
  const best = sortedByChange[0] ?? null
  const worst = sortedByChange[sortedByChange.length - 1] ?? null

  const inventoryValue = snapshot.merchants.reduce(
    (total, merchant) =>
      total +
      Object.entries(merchant.stock).reduce(
        (sum, [itemId, quantity]) => sum + Math.max(0, quantity) * (config.items[itemId]?.baseValue ?? 0),
        0,
      ),
    0,
  )
  const cashInCirculation =
    snapshot.merchants.reduce((sum, merchant) => sum + merchant.cash, 0) +
    snapshot.travelers.totalCash +
    snapshot.bots.totalCash

  const activeInvestments = snapshot.investments.filter(
    investment => investment.status === 'active',
  )
  const totalInvestmentAmount = Math.round(
    snapshot.investments.reduce((sum, investment) => sum + investment.amount, 0) * 100,
  ) / 100

  // ---- Newspaper copy -------------------------------------------------------
  const headlineParts: string[] = []
  if (bankruptcies.length > 0) {
    headlineParts.push(
      `${bankruptcies.map(id => displayName(snapshot, id)).join(' and ')} closed their stalls`,
    )
  }
  const topMover = movers[0]
  if (topMover) {
    const direction = topMover.changePct >= 0 ? 'up' : 'down'
    headlineParts.push(
      `${itemDisplayName(config, topMover.itemId)} ${direction} ${Math.abs(topMover.changePct).toFixed(0)}% at ${displayName(snapshot, topMover.merchantId)}`,
    )
  }
  if (caravan.arrivals > 0) {
    headlineParts.push(`caravan moved ${caravan.unitsSold + caravan.unitsBought} units`)
  }
  const headline = headlineParts.length > 0
    ? `Day ${snapshot.day}: ${headlineParts.join('; ')}`
    : `Day ${snapshot.day}: the market stays calm`

  const story: string[] = []
  if (bankruptcies.length > 0) {
    story.push(
      `${bankruptcies.map(id => displayName(snapshot, id)).join(' and ')} breached their cash reserve and shut the stall. A player investment reopens a closed stall instantly.`,
    )
  } else {
    story.push('No merchant breached its cash reserve today.')
  }
  if (investments.count > 0) {
    story.push(
      `${investments.count} investment(s) worth ${money(config, investments.amount)} reopened or backed stalls.`,
    )
  } else if (activeInvestments.length > 0) {
    story.push(`${activeInvestments.length} active investment(s) remain on the books.`)
  }
  if (caravan.arrivals > 0) {
    story.push(
      `The caravan arrived ${caravan.arrivals} time(s): sold ${caravan.unitsSold} units into town for ${money(config, caravan.cashIn)} and bought ${caravan.unitsBought} units for ${money(config, caravan.cashOut)}.`,
    )
  } else {
    story.push('No caravan reached the town today.')
  }
  story.push(
    `Sinks removed ${money(config, sinks.total)} (rent ${money(config, sinks.rent)}, sales tax ${money(config, sinks.salesTax)}, repairs ${money(config, sinks.repairs)}).`,
  )
  story.push(
    `Orders: ${orders.created} created, ${orders.fulfilled} units delivered, ${money(config, orders.payouts)} paid out.`,
  )
  if (best && worst && best.merchantId !== worst.merchantId) {
    story.push(
      `${best.displayName} ends the day strongest (${money(config, best.cashChange)}); ${worst.displayName} weakest (${money(config, worst.cashChange)}).`,
    )
  }

  return {
    day: snapshot.day,
    time: snapshot.time,
    closed,
    currencySymbol: config.currency.symbol,
    headline,
    story,
    topMovers: movers,
    trades,
    botTrades,
    bankruptcies: { today: bankruptcies, total: snapshot.stats.bankruptcies },
    investments: {
      today: investments,
      total: { count: snapshot.stats.investments, amount: totalInvestmentAmount },
      active: activeInvestments.length,
    },
    caravan: { ...caravan, totalArrivals: snapshot.stats.caravanArrivals },
    sinks: { ...sinks, todayTotal: sinks.total },
    orders: {
      ...orders,
      open: snapshot.orders.filter(order => order.status === 'open').length,
      accepted: snapshot.orders.filter(order => order.status === 'accepted').length,
      deliveredToday: orders.fulfilled,
    },
    cashInCirculation,
    inventoryValue,
    standings,
    best,
    worst,
  }
}
