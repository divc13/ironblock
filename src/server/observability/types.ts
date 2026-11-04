import type {
  CaravanTotals,
  DaySummary,
  EconomyStats,
  EconomyWorldState,
  OrderTotals,
  PriceMover,
  SequencedMarketEvent,
  SinkTotals,
  SpectatorSnapshot,
  TradeTotals,
} from '../../shared/economy'
import type { EconomyConfig, ItemId, MerchantId } from '../../shared/types'

/**
 * The read-only slice of the economy the observability layer needs.
 *
 * Both `EconomyService` and `EconomyEngine` satisfy it, so tests can run the
 * whole API against a bare engine and the live host can pass its service.
 */
export interface ObservabilitySource {
  readonly config: EconomyConfig
  snapshot(): EconomyWorldState
  spectatorSnapshot(): SpectatorSnapshot
  eventsSince(sequence: number): SequencedMarketEvent[]
  /** Lowest retained event sequence, or 0 when unknown. */
  readonly firstRetainedSequence?: number
}

/* -------------------------------------------------------------------------- */
/* Core request/response shape (transport independent)                        */
/* -------------------------------------------------------------------------- */

export interface ObservabilityRequest {
  method: string
  /** Path with the API prefix removed, always starting with "/". */
  path: string
  query: URLSearchParams
  /** Raw body bytes for POST requests (already size-capped by the adapter). */
  rawBody?: Uint8Array | null
}

export type ObservabilityResult =
  | { kind: 'json'; status: number; body: unknown; headers?: Record<string, string> }
  | {
      kind: 'error'
      status: number
      body: { error: string; message: string }
      headers?: Record<string, string>
    }
  | { kind: 'sse'; stream: ObservabilityStream }

export interface ObservabilityStream {
  /**
   * Called by the transport when the client is listening. The returned
   * disposer must stop all timers; it is invoked on client disconnect.
   */
  start(send: ObservabilityStreamSender): () => void
}

export interface ObservabilityStreamSender {
  event(name: string, data: string): void
  comment(text: string): void
}

/* -------------------------------------------------------------------------- */
/* Rate limiting / body caps                                                  */
/* -------------------------------------------------------------------------- */

export interface RateLimitOptions {
  /** Requests allowed per window. Default 6. */
  max: number
  /** Sliding window length in ms. Default 60_000. */
  windowMs: number
}

export interface ObservabilityContext {
  apiPath: string
  getService(): ObservabilitySource | null | Promise<ObservabilitySource | null>
  now(): number
  rateLimit: RateLimitOptions
  bodyLimit: number
  stream: { pollMs: number; snapshotEveryMs: number }
  /** Tokens taken per client key; transport layers supply a client key. */
  takeToken(clientKey: string): { allowed: boolean; retryAfterMs: number }
}

/* -------------------------------------------------------------------------- */
/* Public (sanitized) spectator data                                          */
/* -------------------------------------------------------------------------- */

export interface PublicMerchant {
  id: MerchantId
  displayName: string
  personality: string
  open: boolean
  bankrupt: boolean
  cash: number
  reserve: number
  stock: Record<ItemId, number>
  targetStock: Record<ItemId, number>
  askPrices: Record<ItemId, number>
  bidPrices: Record<ItemId, number>
  bankruptAt: number | null
}

export interface PublicTrade {
  sequence: number
  time: number
  day: number
  side: 'buy' | 'sell'
  trader: string
  traderName: string
  merchantId: MerchantId | null
  merchantName: string | null
  item: ItemId
  quantity: number
  unitPrice: number
  currencySymbol: string
  reason: string | null
  eventId: string
}

export interface PublicInvestment {
  id: string
  merchantId: MerchantId
  amount: number
  day: number
  time: number
  status: 'active' | 'settled'
  receipt: string
  totalDistributed: number
}

export interface PublicOrder {
  id: string
  templateId: string
  issuer: string
  itemId: ItemId
  quantity: number
  remaining: number
  unitReward: number
  currencySymbol: string
  createdAt: number
  dayCreated: number
  expiresAt: number
  status: 'open' | 'accepted' | 'fulfilled' | 'expired'
  accepted: boolean
}

export interface PublicSummary {
  day: number
  startedAt: number
  endedAt: number
  merchantCash: Record<MerchantId, number>
  totalMerchantCash: number
  totalPlayerCash: number
  playerCount: number
  trades: TradeTotals
  botTrades: number
  bankruptcies: MerchantId[]
  investments: { count: number; amount: number }
  caravan: CaravanTotals
  sinks: SinkTotals
  orders: OrderTotals
  topMovers: PriceMover[]
}

export interface PublicDaily {
  day: number
  startedAt: number
  merchantCashStart: Record<MerchantId, number>
  priceSnapshot: Record<string, { bid: number | null; ask: number | null }>
  trades: TradeTotals
  botTrades: number
  bankruptcies: MerchantId[]
  investments: { count: number; amount: number }
  caravan: CaravanTotals
  sinks: SinkTotals
  orders: OrderTotals
}

export interface PublicSnapshot {
  engineSchemaVersion: number
  configHash: string
  configVersion: string
  seed: string
  time: number
  day: number
  sequence: number
  merchants: PublicMerchant[]
  travelers: { count: number; totalCash: number }
  bots: { count: number; totalCash: number; trades: number }
  caravan: SpectatorSnapshot['caravan']
  investments: PublicInvestment[]
  orders: PublicOrder[]
  stats: EconomyStats
  daily: PublicDaily
  summaries: PublicSummary[]
  recentEvents: SequencedMarketEvent[]
  tape: PublicTrade[]
  firstRetainedSequence: number
}

/* -------------------------------------------------------------------------- */
/* Recap / newspaper                                                          */
/* -------------------------------------------------------------------------- */

export interface RecapMerchantStanding {
  merchantId: MerchantId
  displayName: string
  cashChange: number
  cash: number
  open: boolean
  bankrupt: boolean
}

export interface Recap {
  day: number
  time: number
  closed: boolean
  currencySymbol: string
  headline: string
  story: string[]
  topMovers: PriceMover[]
  trades: TradeTotals
  botTrades: number
  bankruptcies: { today: MerchantId[]; total: number }
  investments: { today: { count: number; amount: number }; total: { count: number; amount: number }; active: number }
  caravan: CaravanTotals & { totalArrivals: number }
  sinks: SinkTotals & { todayTotal: number }
  orders: OrderTotals & { open: number; accepted: number; deliveredToday: number }
  cashInCirculation: number
  inventoryValue: number
  standings: RecapMerchantStanding[]
  best: RecapMerchantStanding | null
  worst: RecapMerchantStanding | null
}

/* -------------------------------------------------------------------------- */
/* On-chain proof (static deployment record, no RPC)                          */
/* -------------------------------------------------------------------------- */

export interface ProofToken {
  itemId: ItemId
  tokenId: string
  symbol: string
  standard: 'nep-245'
  decimals: number
}

export interface ProofPayload {
  network: 'testnet'
  contractId: string
  treasuryId: string
  explorerUrls: { contract: string; treasury: string }
  tokenCount: number
  tokens: ProofToken[]
  genesisSupply: { units: number; note: string }
  note: string
  testnet: true
}

/* -------------------------------------------------------------------------- */
/* Fast-forward clone                                                         */
/* -------------------------------------------------------------------------- */

export interface FastForwardAnnotation {
  kind:
    | 'day-close'
    | 'caravan'
    | 'bankruptcy'
    | 'reopen'
    | 'rent'
    | 'recovery'
    | 'distribution'
    | 'order-expired'
    | 'summary'
  sequence: number
  time: number
  day: number
  title: string
  chain: string
  eventId: string | null
}

export interface FastForwardTiming {
  cloneMs: number
  simulateMs: number
  totalMs: number
  steps: number
  days: number
  eventCount: number
}

export interface FastForwardClonePayload {
  ok: true
  mode: 'deterministic-clone'
  days: number
  startDay: number
  endDay: number
  fromTime: number
  toTime: number
  seed: string
  finalSequence: number
  series: {
    day: number
    endedAt: number
    totalMerchantCash: number
    totalPlayerCash: number
    tradeVolume: number
    tradeValue: number
    bankruptcies: number
    caravanArrivals: number
    sinkTotal: number
  }[]
  summaries: PublicSummary[]
  events: SequencedMarketEvent[]
  annotations: FastForwardAnnotation[]
  recap: Recap
  timing: FastForwardTiming
  live: {
    unchanged: boolean
    sequenceBefore: number
    sequenceAfter: number
    day: number
    time: number
  }
}

export interface FastForwardRequestBody {
  days?: number
}
