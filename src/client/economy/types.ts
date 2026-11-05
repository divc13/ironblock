import type {
  ItemId,
  MarketEvent,
  MerchantId,
  PriceReason,
  Quote,
  RecipeId,
  ResourceId,
  TradeSide,
} from '../../shared/types'

/**
 * The typed boundary between the playable town UI and the authoritative
 * economy. Everything the UI renders (prices, reasons, availability, events)
 * comes through this interface. The mock implementation is used until the real
 * server service is wired in.
 */

export type EconomyMode = 'mock' | 'server'
export type TownHealth = 'thriving' | 'stable' | 'strained' | 'critical'
export type FastForwardStatus = 'idle' | 'running' | 'paused' | 'done'

export interface ToolView {
  itemId: ItemId
  displayName: string
  durability: number
  maxDurability: number
}

export interface InventoryLine {
  itemId: ItemId
  displayName: string
  category: string
  quantity: number
  unitWeight: number
  totalWeight: number
  equipped: boolean
  tool?: ToolView
}

export interface PlayerView {
  cash: number
  inventory: InventoryLine[]
  stamina: number
  maxStamina: number
  weight: number
  carryCapacity: number
  equippedTool: ItemId | null
  toolDurability: Record<ItemId, number>
}

export interface MerchantSummary {
  id: MerchantId
  displayName: string
  personality: string
  cash: number
  reserve: number
  open: boolean
  bankrupt: boolean
  requiredInvestment: number
  stockUnits: number
  stockValue: number
}

export interface MerchantView extends MerchantSummary {
  buys: ItemId[]
  sells: ItemId[]
  stock: Record<ItemId, number>
  targetStock: Record<ItemId, number>
  buyMargin: number
  sellMargin: number
}

/** One closed trading day, trimmed to the numbers the UI charts. */
export interface EconomyDaySummary {
  day: number
  endedAt: number
  totalMerchantCash: number
  totalPlayerCash: number
  tradeVolume: number
  tradeValue: number
  botTrades: number
  bankruptcies: number
  caravanArrivals: number
}

/** Today's running totals, including the cash baseline for the day. */
export interface EconomyTodaySummary {
  day: number
  startedAt: number
  tradeVolume: number
  tradeValue: number
  botTrades: number
  /** All traveler wallets, matching the metric used by closed-day summaries. */
  totalPlayerCash: number
  merchantCashStart: Record<MerchantId, number>
}

export interface EconomySnapshot {
  day: number
  /** Seconds since the market opened. */
  time: number
  /** Pre-formatted day clock, e.g. `Day 2 · 09:30`. */
  clock: string
  player: PlayerView
  merchants: MerchantSummary[]
  openMerchants: number
  bankruptcies: number
  townHealth: TownHealth
  /** Closed-day history, oldest first. Empty on the opening day. */
  summaries: EconomyDaySummary[]
  /** Today's running totals, so day-one charts still have a pulse. */
  today: EconomyTodaySummary
  recentEvents: MarketEvent[]
  orderBoardSupported: boolean
}

export interface TradeRequest {
  merchantId: MerchantId
  itemId: ItemId
  quantity: number
}

export interface TradeResult {
  ok: boolean
  message: string
  quote: Quote
  fillQuantity: number
  total: number
}

export interface GatherResult {
  ok: boolean
  message: string
  itemId: ItemId
  quantity: number
  staminaSpent: number
  durabilityLeft: number | null
}

export interface CraftResult {
  ok: boolean
  message: string
  recipeId: RecipeId
  outputs: Record<ItemId, number>
  staminaSpent: number
}

export interface RepairResult {
  ok: boolean
  message: string
  toolItemId: ItemId | null
  cost: number
  durability: number | null
}

export interface EatResult {
  ok: boolean
  message: string
  itemId: ItemId
  staminaRestored: number
}

export interface InvestResult {
  ok: boolean
  message: string
  merchantId: MerchantId
  amount: number
  merchantCash: number
  reopened: boolean
}

export interface FastForwardEvent {
  event: MarketEvent
  day: number
  annotation: string
}

export interface FastForwardDay {
  day: number
  merchantsOpen: number
  bankruptcies: number
  tradeVolume: number
  headline: string
}

export interface FastForwardState {
  status: FastForwardStatus
  /** Revealed day count within this run (0 while the POST is in flight). */
  day: number
  totalDays: number
  /** 0..1 completion across the requested days. */
  progress: number
  days: FastForwardDay[]
  events: FastForwardEvent[]
  recap: SessionRecap | null
  message: string
  /** In-game time at the start of the simulated window, in seconds. */
  fromTime: number
  /** In-game time at the end of the simulated window, in seconds. */
  toTime: number
  /** Absolute day the run started from. */
  startDay: number
  /** Absolute day the simulated window ends on. */
  endDay: number
  /** Wall-clock reveal/playback length used by the client and server. */
  revealDurationMs: number
  /** Whether server-authoritative map actors move during the reveal. */
  worldPlayback: 'server' | 'unavailable'
}

export interface RecapTopMover {
  itemId: ItemId
  displayName: string
  changePct: number
  from: number
  to: number
}

export interface SessionRecap {
  headline: string
  standfirst: string
  generatedAtDay: number
  topMovers: RecapTopMover[]
  trades: {
    count: number
    buyCount: number
    sellCount: number
    volume: number
    value: number
  }
  bankruptcies: string[]
  investments: Array<{ merchantId: MerchantId; displayName: string; amount: number }>
  caravan: { arrivals: number; note: string }
  sinks: { rent: number; tax: number; repairs: number; total: number }
  merchants: { open: number; total: number; health: TownHealth }
}

/** Placeholder shape for the integration agent's order board. */
export interface OrderBoardEntry {
  id: string
  side: TradeSide
  merchantId: MerchantId
  merchantName: string
  itemId: ItemId
  itemName: string
  quantity: number
  unitPrice: number
}

export interface FastForwardClient {
  start(days?: number): Promise<FastForwardState>
  pause(): void
  resume(): Promise<FastForwardState>
  step(): Promise<FastForwardState>
  /** Reveal the remaining days/events immediately (server map playback may finish on its own). */
  skip(): void
  getState(): FastForwardState
  onChange(listener: (state: FastForwardState) => void): () => void
}

export interface EconomyClient {
  readonly mode: EconomyMode
  readonly fastForward: FastForwardClient
  getSnapshot(): Promise<EconomySnapshot>
  getMerchant(id: MerchantId): Promise<MerchantView | null>
  getQuote(
    merchantId: MerchantId,
    itemId: ItemId,
    side: TradeSide,
    quantity: number,
  ): Promise<Quote>
  buy(request: TradeRequest): Promise<TradeResult>
  sell(request: TradeRequest): Promise<TradeResult>
  gather(resourceId: ResourceId): Promise<GatherResult>
  craft(recipeId: RecipeId): Promise<CraftResult>
  invest(merchantId: MerchantId, amount?: number): Promise<InvestResult>
  repair(toolItemId?: ItemId): Promise<RepairResult>
  eat(itemId: ItemId): Promise<EatResult>
  /** Events newer than the given event id; omit for the full session stream. */
  getEvents(since?: string): Promise<MarketEvent[]>
  /** Convenience delegate for `fastForward.start(days)`. */
  fastForwardDays(days: number): Promise<FastForwardState>
  getRecap(): Promise<SessionRecap>
  getOrderBoard(): Promise<OrderBoardEntry[]>
  subscribe(listener: () => void): () => void
  reset(): void
}

/** UI helper contract for rendering reason rows without importing pricing internals. */
export type ReasonRow = PriceReason
