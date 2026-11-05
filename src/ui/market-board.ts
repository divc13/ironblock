import { economy } from '../config/economy'
import type { EconomyClient, EconomySnapshot } from '../client/economy/types'
import type { ItemId, MerchantId, Quote, TradeSide } from '../shared/types'
import { formatMoney } from './format'

/**
 * Market board selectors.
 *
 * Every number on the board comes from the economy client's `getQuote`. This
 * module only picks the lowest ask / highest bid and arranges the result for
 * display, so the board can never drift from the merchant panels.
 */

export interface MarketQuoteEntry {
  merchantId: MerchantId
  merchantName: string
  itemId: ItemId
  side: TradeSide
  quote: Quote
}

export interface MarketSide {
  merchantId: MerchantId
  merchantName: string
  unitPrice: number
  quote: Quote
}

export interface MarketBoardRow {
  itemId: ItemId
  displayName: string
  description: string
  category: string
  where: string
  bestBuy: MarketSide | null
  bestSell: MarketSide | null
  spread: number
  spreadPct: number
  profitable: boolean
}

export interface ItemBestPrices {
  /** Cheapest merchant ask (the player buys here). */
  buy: MarketSide | null
  /** Highest merchant bid (the player sells here). */
  sell: MarketSide | null
}

export type MarketRouteKind = 'trade' | 'craft' | 'gather'

export interface MarketRoute {
  id: string
  kind: MarketRouteKind
  title: string
  detail: string
  profit: number
  profitLabel: string
  /** The stall the primary "Go there" action walks the player to. */
  target: MarketSide
  actionLabel: string
}

const itemConfig = (itemId: ItemId) =>
  (economy.items as Record<string, (typeof economy.items)[keyof typeof economy.items] | undefined>)[
    itemId
  ]

export const itemDisplayName = (itemId: ItemId): string =>
  itemConfig(itemId)?.displayName ?? itemId

const availableAt = (entry: MarketQuoteEntry): boolean => {
  const { quote } = entry
  if (!quote.merchantOpen || quote.merchantBankrupt) return false
  if (quote.side === 'buy') {
    // Player buys: the stall must have at least one unit on the shelf.
    return quote.constraints.stock >= 1
  }
  // Player sells: the stall must be able to pay for one unit.
  return quote.constraints.merchantCash >= quote.unitPrice - 0.005
}

/** Lowest ask among merchants that can actually fill one unit. */
const bestBuySide = (
  entries: readonly MarketQuoteEntry[],
  itemId: ItemId,
): MarketSide | null => {
  const candidates = entries
    .filter(entry => entry.itemId === itemId && entry.side === 'buy' && availableAt(entry))
    .sort(
      (left, right) =>
        left.quote.unitPrice - right.quote.unitPrice ||
        left.merchantId.localeCompare(right.merchantId),
    )
  const best = candidates[0]
  return best
    ? {
        merchantId: best.merchantId,
        merchantName: best.merchantName,
        unitPrice: best.quote.unitPrice,
        quote: best.quote,
      }
    : null
}

/** Highest bid among merchants that can actually pay for one unit. */
const bestSellSide = (
  entries: readonly MarketQuoteEntry[],
  itemId: ItemId,
): MarketSide | null => {
  const candidates = entries
    .filter(entry => entry.itemId === itemId && entry.side === 'sell' && availableAt(entry))
    .sort(
      (left, right) =>
        right.quote.unitPrice - left.quote.unitPrice ||
        left.merchantId.localeCompare(right.merchantId),
    )
  const best = candidates[0]
  return best
    ? {
        merchantId: best.merchantId,
        merchantName: best.merchantName,
        unitPrice: best.quote.unitPrice,
        quote: best.quote,
      }
    : null
}

/** One row per configured item that has a live ask or bid. */
export function buildMarketBoard(entries: readonly MarketQuoteEntry[]): MarketBoardRow[] {
  const rows: MarketBoardRow[] = []
  for (const itemId of Object.keys(economy.items)) {
    const buy = bestBuySide(entries, itemId)
    const sell = bestSellSide(entries, itemId)
    if (!buy && !sell) continue
    const item = itemConfig(itemId)
    const spread = buy && sell ? sell.unitPrice - buy.unitPrice : 0
    rows.push({
      itemId,
      displayName: item?.displayName ?? itemId,
      description: item?.description ?? '',
      category: item?.category ?? 'trade',
      where: describeSource(itemId),
      bestBuy: buy,
      bestSell: sell,
      spread,
      spreadPct: buy && buy.unitPrice > 0 ? (spread / buy.unitPrice) * 100 : 0,
      profitable: Boolean(buy && sell && spread > 0.005),
    })
  }
  return rows
}

/** Cheapest ask and highest bid for every item, used for the in-town tags. */
export function buildBestPriceIndex(
  entries: readonly MarketQuoteEntry[],
): Map<ItemId, ItemBestPrices> {
  const index = new Map<ItemId, ItemBestPrices>()
  for (const itemId of Object.keys(economy.items)) {
    const buy = bestBuySide(entries, itemId)
    const sell = bestSellSide(entries, itemId)
    if (buy || sell) index.set(itemId, { buy, sell })
  }
  return index
}

/** Where a first-time player can find the item in the town. */
export function describeSource(itemId: ItemId): string {
  const areas = Object.values(economy.resources.nodes)
    .filter(node => node.itemId === itemId)
    .map(node => node.displayName)
  const recipes = Object.values(economy.recipes).filter(
    recipe => (recipe.outputs[itemId] ?? 0) > 0,
  )
  const parts: string[] = []
  if (areas.length > 0) parts.push(`Gather at ${areas.join(' / ')}`)
  if (recipes.length > 0) parts.push(`Craft ${recipes[0].displayName}`)
  if (parts.length === 0) parts.push('Merchant stock')
  return parts.join(' · ')
}

/**
 * Best current routes. Cross-merchant spreads come straight from the board;
 * craft and gather routes compare the same live quotes against configured
 * recipes/resource nodes. No route invents a price of its own.
 */
export function buildMarketRoutes(
  entries: readonly MarketQuoteEntry[],
  rows: readonly MarketBoardRow[],
  limit = 3,
): MarketRoute[] {
  const byItem = new Map(rows.map(row => [row.itemId, row]))
  const routes: MarketRoute[] = []

  for (const row of rows) {
    if (!row.bestBuy || !row.bestSell || row.spread <= 0.005) continue
    routes.push({
      id: `trade:${row.itemId}`,
      kind: 'trade',
      title: `${row.displayName}: buy at ${row.bestBuy.merchantName}, sell at ${row.bestSell.merchantName}`,
      detail: `${money(row.bestBuy.unitPrice)} → ${money(row.bestSell.unitPrice)} per unit.`,
      profit: row.spread,
      profitLabel: `${signedMoney(row.spread)} / unit`,
      target: row.bestSell,
      actionLabel: `Go to ${row.bestSell.merchantName}`,
    })
  }

  for (const recipe of Object.values(economy.recipes)) {
    const inputParts = Object.entries(recipe.inputs).map(([itemId, quantity]) => ({
      row: byItem.get(itemId),
      quantity,
    }))
    if (inputParts.length === 0 || inputParts.some(part => !part.row?.bestBuy)) continue
    const outputParts = Object.entries(recipe.outputs).map(([itemId, quantity]) => ({
      row: byItem.get(itemId),
      quantity,
    }))
    if (outputParts.length === 0 || outputParts.some(part => !part.row?.bestSell)) continue

    const inputsAvailable = inputParts.every(part => {
      const quote = part.row!.bestBuy!.quote
      return quote.constraints.stock >= part.quantity
    })
    if (!inputsAvailable) continue

    const inputCost = inputParts.reduce(
      (total, part) => total + part.row!.bestBuy!.unitPrice * part.quantity,
      0,
    )
    const revenue = outputParts.reduce(
      (total, part) => total + part.row!.bestSell!.unitPrice * part.quantity,
      0,
    )
    const profit = revenue - inputCost
    if (profit <= 0.005) continue

    const sellSide = outputParts[0].row!.bestSell!
    const outputName = outputParts
      .map(part => `${part.quantity}× ${itemDisplayName(part.row!.itemId)}`)
      .join(' + ')
    const inputMerchants = [
      ...new Set(inputParts.map(part => part.row!.bestBuy!.merchantName)),
    ].join(' / ')
    routes.push({
      id: `craft:${recipe.id}`,
      kind: 'craft',
      title: `${recipe.displayName}: ${outputName}`,
      detail: `Buy inputs at ${inputMerchants} (${money(inputCost)}) · ${sellSide.merchantName} pays ${money(revenue)} per batch.`,
      profit,
      profitLabel: `${signedMoney(profit)} / batch`,
      target: sellSide,
      actionLabel: `Go to ${sellSide.merchantName}`,
    })
  }

  for (const node of Object.values(economy.resources.nodes)) {
    const row = byItem.get(node.itemId)
    if (!row?.bestSell) continue
    routes.push({
      id: `gather:${node.id}`,
      kind: 'gather',
      title: `Gather ${row.displayName} at ${node.displayName}`,
      detail: `${row.bestSell.merchantName} bids ${money(row.bestSell.unitPrice)} each. Gathering costs stamina, not cash.`,
      profit: row.bestSell.unitPrice,
      profitLabel: `${money(row.bestSell.unitPrice)} / unit`,
      target: row.bestSell,
      actionLabel: `Go to ${row.bestSell.merchantName}`,
    })
  }

  const kindRank: Record<MarketRouteKind, number> = { trade: 0, craft: 1, gather: 2 }
  return routes
    .sort(
      (left, right) =>
        kindRank[left.kind] - kindRank[right.kind] ||
        right.profit - left.profit ||
        left.id.localeCompare(right.id),
    )
    .slice(0, Math.max(1, limit))
}

/** Load every sell/buy quote for the visible merchants. */
export async function loadMarketQuotes(
  client: EconomyClient,
  snapshot: EconomySnapshot,
): Promise<MarketQuoteEntry[]> {
  const views = await Promise.all(
    snapshot.merchants.map(async summary => ({
      summary,
      view: await client.getMerchant(summary.id).catch(() => null),
    })),
  )

  const requests: Array<Promise<MarketQuoteEntry | null>> = []
  for (const { summary, view } of views) {
    if (!view) continue
    const merchantName = view.displayName || summary.displayName
    for (const itemId of view.sells) {
      requests.push(
        client
          .getQuote(summary.id, itemId, 'buy', 1)
          .then(quote => ({
            merchantId: summary.id,
            merchantName,
            itemId,
            side: 'buy' as const,
            quote,
          }))
          .catch(() => null),
      )
    }
    for (const itemId of view.buys) {
      requests.push(
        client
          .getQuote(summary.id, itemId, 'sell', 1)
          .then(quote => ({
            merchantId: summary.id,
            merchantName,
            itemId,
            side: 'sell' as const,
            quote,
          }))
          .catch(() => null),
      )
    }
  }

  const settled = await Promise.all(requests)
  return settled.filter((entry): entry is MarketQuoteEntry => entry !== null)
}

/** Best live buyer for one item, used by the first-day "sell" step. */
export async function findBestBuyer(
  client: EconomyClient,
  snapshot: EconomySnapshot,
  itemId: ItemId,
): Promise<MarketSide | null> {
  const views = await Promise.all(
    snapshot.merchants.map(async summary => ({
      summary,
      view: await client.getMerchant(summary.id).catch(() => null),
    })),
  )
  const requests: Array<Promise<MarketQuoteEntry | null>> = []
  for (const { summary, view } of views) {
    if (!view || !view.buys.includes(itemId)) continue
    requests.push(
      client
        .getQuote(summary.id, itemId, 'sell', 1)
        .then(quote => ({
          merchantId: summary.id,
          merchantName: view.displayName || summary.displayName,
          itemId,
          side: 'sell' as const,
          quote,
        }))
        .catch(() => null),
    )
  }
  const entries = (await Promise.all(requests)).filter(
    (entry): entry is MarketQuoteEntry => entry !== null,
  )
  return bestSellSide(entries, itemId)
}

const money = (value: number): string => formatMoney(value, economy.currency.symbol)

const signedMoney = (value: number): string =>
  `${value > 0 ? '+' : value < 0 ? '−' : ''}${formatMoney(
    Math.abs(value),
    economy.currency.symbol,
  )}`
