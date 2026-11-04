import { stableCompare, stableHash64 } from '../../shared/stable-hash'
import type {
  DailyAccumulator,
  DaySummary,
  OrderState,
  SequencedMarketEvent,
  SpectatorMerchantSnapshot,
  SpectatorSnapshot,
} from '../../shared/economy'
import type { EconomyConfig, ItemId, MarketEvent, MerchantId } from '../../shared/types'
import type {
  PublicDaily,
  PublicInvestment,
  PublicMerchant,
  PublicOrder,
  PublicSnapshot,
  PublicSummary,
  PublicTrade,
} from './types'

/**
 * Privacy boundary for the public spectator feed.
 *
 * Player identities (ids, session names, emails, wallets) must never appear on
 * the public feed, so every player actor is replaced with a stable pseudonym
 * derived from a hash of the internal id. Merchant, bot, caravan and system
 * actors are public NPCs and keep their names.
 */

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const TRAVELER_PREFIX = 'Traveler'

const travelerPseudonym = (playerId: string): string =>
  `${TRAVELER_PREFIX}-${stableHash64(`traveler:${playerId}`).slice(0, 4).toUpperCase()}`

/** Stable per-world pseudonym table: internal player id -> public alias. */
export interface PlayerAliasTable {
  readonly ids: ReadonlyMap<string, string>
  /** Maps both ids and raw display names to their public alias. */
  readonly names: ReadonlyMap<string, string>
  readonly count: number
}

export function buildPlayerAliases(players: SpectatorSnapshot['players']): PlayerAliasTable {
  const ids = new Map<string, string>()
  const names = new Map<string, string>()
  for (const [playerId, player] of Object.entries(players)) {
    const alias = travelerPseudonym(playerId)
    ids.set(playerId, alias)
    names.set(playerId, alias)
    if (player.displayName && player.displayName !== playerId) {
      names.set(player.displayName, alias)
    }
  }
  return { ids, names, count: Object.keys(players).length }
}

/**
 * Replaces every known player id/display name occurrence in a free-form
 * message with its public alias, then masks anything that still looks like an
 * email address or NEAR account (defense in depth for unknown names).
 */
function publicizeMessage(message: string, aliases: PlayerAliasTable): string {
  let result = message
  for (const [secret, alias] of aliases.names) {
    if (!secret) continue
    result = result.split(secret).join(alias)
  }
  // Mask residual emails/near accounts in free-form text without breaking words.
  result = result.replace(
    /[\w.+-]+@[\w-]+(?:\.[\w-]+)+|[\w-]+\.(?:testnet|near)/g,
    `${TRAVELER_PREFIX}-****`,
  )
  return result
}

const TRADE_MERCHANT_PATTERNS = [/\bfrom (.+?) for\b/, /\bto (.+?) for\b/]

/**
 * Trade events do not carry a merchant id, but their messages end with
 * "... from <Merchant> for ...". Extract the merchant display name and map it
 * back to the configured merchant id for the market tape.
 */
function merchantFromEvent(event: MarketEvent, config: EconomyConfig): {
  id: MerchantId
  displayName: string
} | null {
  const byName = new Map<string, MerchantId>()
  for (const merchant of Object.values(config.merchants)) {
    byName.set(merchant.displayName, merchant.id)
  }
  for (const pattern of TRADE_MERCHANT_PATTERNS) {
    const match = pattern.exec(event.message)
    if (!match) continue
    const displayName = match[1].trim()
    const id = byName.get(displayName)
    if (id) return { id, displayName }
  }
  return null
}

function publicActor(
  event: MarketEvent,
  aliases: PlayerAliasTable,
): MarketEvent['actor'] {
  if (event.actor.type !== 'player') return event.actor
  const known = aliases.ids.get(event.actor.id) ?? aliases.names.get(event.actor.displayName ?? '')
  if (known) {
    return { type: 'player', id: known, displayName: known }
  }
  // Ids that already look like public aliases (server-publicized events
  // replayed client-side) pass through; everything else is pseudonymized.
  const truncated =
    event.actor.id.startsWith(`${TRAVELER_PREFIX}-`)
      ? event.actor.id
      : travelerPseudonym(event.actor.id)
  return { type: 'player', id: truncated, displayName: truncated }
}

/** Copy of an event that is safe to publish on the public feed. */
export function publicizeEvent(
  event: SequencedMarketEvent,
  aliases: PlayerAliasTable,
  config: EconomyConfig,
): SequencedMarketEvent {
  const clone = cloneJson(event)
  clone.actor = publicActor(event, aliases)
  clone.message = publicizeMessage(event.message, aliases)
  // `reasons[].detail` can embed player names (e.g. investment receipts).
  clone.reasons = clone.reasons.map(reason => ({
    ...reason,
    detail: reason.detail ? publicizeMessage(reason.detail, aliases) : reason.detail,
  }))
  return clone
}

export function publicizeEvents(
  events: SequencedMarketEvent[],
  aliases: PlayerAliasTable,
  config: EconomyConfig,
): SequencedMarketEvent[] {
  return events.map(event => publicizeEvent(event, aliases, config))
}

const publicReasonText = (event: MarketEvent, aliases: PlayerAliasTable): string | null => {
  const reason = event.reasons.find(candidate => Boolean(candidate.detail || candidate.label))
  if (!reason) return null
  const detail = reason.detail ? publicizeMessage(reason.detail, aliases) : ''
  return detail ? `${reason.label}: ${detail}` : reason.label
}

/** Build the compact market tape (recent trades) from retained events. */
export function buildTape(
  events: SequencedMarketEvent[],
  aliases: PlayerAliasTable,
  config: EconomyConfig,
  limit = 24,
): PublicTrade[] {
  const currencySymbol = config.currency.symbol
  const tape: PublicTrade[] = []
  for (const event of events) {
    if (event.type !== 'trade.buy' && event.type !== 'trade.sell' && event.type !== 'bot.trade') {
      continue
    }
    const side: 'buy' | 'sell' = event.type === 'trade.sell' ? 'sell' : 'buy'
    const merchant = merchantFromEvent(event, config)
    const actor = publicActor(event, aliases)
    tape.push({
      sequence: event.sequence,
      time: event.time,
      day: Math.floor(event.time / 86400) + 1,
      side,
      trader: actor.id,
      traderName: actor.displayName ?? actor.id,
      merchantId: merchant?.id ?? null,
      merchantName: merchant?.displayName ?? null,
      item: event.item ?? 'unknown',
      quantity: event.quantity ?? 0,
      unitPrice: event.price ?? 0,
      currencySymbol,
      reason: publicReasonText(event, aliases),
      eventId: event.id,
    })
  }
  return tape.slice(-limit).reverse()
}

const publicMerchant = (merchant: SpectatorMerchantSnapshot): PublicMerchant => ({
  id: merchant.id,
  displayName: merchant.displayName,
  personality: merchant.personality,
  open: merchant.open,
  bankrupt: merchant.bankrupt,
  cash: merchant.cash,
  reserve: merchant.reserve,
  stock: cloneJson(merchant.stock),
  targetStock: cloneJson(merchant.targetStock),
  askPrices: cloneJson(merchant.askPrices),
  bidPrices: cloneJson(merchant.bidPrices),
  bankruptAt: merchant.bankruptAt,
})

export const sanitizeSummary = (summary: DaySummary): PublicSummary => ({
  day: summary.day,
  startedAt: summary.startedAt,
  endedAt: summary.endedAt,
  merchantCash: cloneJson(summary.merchantCash),
  totalMerchantCash: summary.totalMerchantCash,
  totalPlayerCash: summary.totalPlayerCash,
  playerCount: Object.keys(summary.playerCash).length,
  trades: cloneJson(summary.trades),
  botTrades: summary.botTrades,
  bankruptcies: [...summary.bankruptcies].sort(stableCompare),
  investments: cloneJson(summary.investments),
  caravan: cloneJson(summary.caravan),
  sinks: cloneJson(summary.sinks),
  orders: cloneJson(summary.orders),
  topMovers: cloneJson(summary.topMovers),
})

export const sanitizeDaily = (daily: DailyAccumulator): PublicDaily => ({
  day: daily.day,
  startedAt: daily.startedAt,
  merchantCashStart: cloneJson(daily.merchantCashStart),
  priceSnapshot: cloneJson(daily.priceSnapshot),
  trades: cloneJson(daily.trades),
  botTrades: daily.botTrades,
  bankruptcies: [...daily.bankruptcies].sort(stableCompare),
  investments: cloneJson(daily.investments),
  caravan: cloneJson(daily.caravan),
  sinks: cloneJson(daily.sinks),
  orders: cloneJson(daily.orders),
})

const publicInvestment = (investment: SpectatorSnapshot['investments'][number], aliases: PlayerAliasTable): PublicInvestment => ({
  id: investment.id,
  merchantId: investment.merchantId,
  amount: investment.amount,
  day: investment.day,
  time: investment.time,
  status: investment.status,
  receipt: publicizeMessage(investment.receipt, aliases),
  totalDistributed: investment.totalDistributed,
})

const publicOrder = (order: OrderState): PublicOrder => ({
  id: order.id,
  templateId: order.templateId,
  issuer: order.issuer,
  itemId: order.itemId,
  quantity: order.quantity,
  remaining: order.remaining,
  unitReward: order.unitReward,
  currencySymbol: order.currencySymbol,
  createdAt: order.createdAt,
  dayCreated: order.dayCreated,
  expiresAt: order.expiresAt,
  status: order.status,
  accepted: order.status === 'accepted' || order.status === 'fulfilled',
})

/**
 * Strips all private player identity data from a spectator snapshot and adds
 * the derived market tape.
 */
export function sanitizeSpectatorSnapshot(
  snapshot: SpectatorSnapshot,
  config: EconomyConfig,
): PublicSnapshot {
  const aliases = buildPlayerAliases(snapshot.players)
  const players = Object.values(snapshot.players)
  return {
    engineSchemaVersion: snapshot.engineSchemaVersion,
    configHash: snapshot.configHash,
    configVersion: snapshot.configVersion,
    seed: snapshot.seed,
    time: snapshot.time,
    day: snapshot.day,
    sequence: snapshot.sequence,
    merchants: snapshot.merchants.map(publicMerchant),
    travelers: {
      count: players.length,
      totalCash: players.reduce((sum, player) => sum + player.cash, 0),
    },
    bots: snapshot.bots,
    caravan: cloneJson(snapshot.caravan),
    investments: snapshot.investments.map(investment => publicInvestment(investment, aliases)),
    orders: snapshot.orders.map(publicOrder),
    stats: cloneJson(snapshot.stats),
    daily: sanitizeDaily(snapshot.daily),
    summaries: snapshot.summaries.map(sanitizeSummary),
    recentEvents: publicizeEvents(snapshot.recentEvents, aliases, config),
    tape: buildTape(snapshot.recentEvents, aliases, config),
    firstRetainedSequence: snapshot.firstRetainedSequence,
  }
}

export { travelerPseudonym }
