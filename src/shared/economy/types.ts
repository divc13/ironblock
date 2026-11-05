import type {
  EconomyConfig,
  ItemId,
  MarketEvent,
  MarketState,
  MerchantId,
  MerchantState,
  PlayerEconomyState,
  RecipeId,
  ResourceId,
} from '../types'

/** The runtime engine schema, independent of the data-config schema version. */
export const ECONOMY_ENGINE_SCHEMA_VERSION = 2

export interface ConfigFingerprint {
  hash: string
  version: string
  schemaVersion: number
}

export interface SequencedMarketEvent extends MarketEvent {
  /** Monotonically increasing within one world; retained events keep their original sequence. */
  sequence: number
}

export interface MerchantRuntimeState extends MerchantState {
  bankrupt: boolean
  bankruptAt: number | null
  reopenedAt: number | null
  lastRestockAt: number
  cashAtDayStart: number
}

export interface PlayerRuntimeState extends PlayerEconomyState {
  displayName?: string
  joinedAt: number
}

export interface BotRuntimeState {
  id: string
  displayName: string
  cash: number
  inventory: Record<ItemId, number>
  stamina: number
  maxStamina: number
  nextActionAt: number
  lastActionAt: number | null
  trades: number
}

export interface ResourceRuntimeState {
  id: ResourceId
  available: number
  nextRespawnAt: number | null
  lastGatherAt: number | null
}

export interface CaravanRuntimeState {
  nextArrivalAt: number
  lastArrivalAt: number | null
  arrivals: number
}

export interface ScenarioRescueRecord {
  shockId: string
  investorId: string
  investmentId: string
  at: number
}

export interface ScenarioRuntimeState {
  appliedShockIds: string[]
  rescues: ScenarioRescueRecord[]
}

export interface InvestmentDistribution {
  day: number
  time: number
  amount: number
  receipt: string
}

export interface InvestmentRecord {
  id: string
  playerId: string
  merchantId: MerchantId
  amount: number
  day: number
  time: number
  status: 'active' | 'settled'
  receipt: string
  totalDistributed: number
  distributions: InvestmentDistribution[]
}

export type OrderStatus = 'open' | 'accepted' | 'fulfilled' | 'expired'

export interface OrderState {
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
  status: OrderStatus
  acceptedBy?: string
  acceptedAt?: number
  fulfilledAt?: number
  updatedAt: number
}

export interface TradeTotals {
  buys: number
  sells: number
  volume: number
  value: number
}

export interface CaravanTotals {
  arrivals: number
  /** Units the caravan sold into town (merchant stock increased). */
  unitsSold: number
  /** Units the caravan bought from town (merchant stock decreased). */
  unitsBought: number
  /** Cash merchants paid to the caravan. */
  cashIn: number
  /** Cash merchants received from the caravan. */
  cashOut: number
}

export interface SinkTotals {
  rent: number
  salesTax: number
  repairs: number
  /** Cash removed from merchants by configured scenario shocks. */
  shocks: number
  total: number
}

export interface OrderTotals {
  created: number
  accepted: number
  fulfilled: number
  units: number
  payouts: number
}

export interface DailyAccumulator {
  day: number
  startedAt: number
  merchantCashStart: Record<MerchantId, number>
  playerCashStart: Record<string, number>
  priceSnapshot: Record<string, { bid: number | null; ask: number | null }>
  trades: TradeTotals
  botTrades: number
  bankruptcies: MerchantId[]
  investments: { count: number; amount: number }
  caravan: CaravanTotals
  sinks: SinkTotals
  orders: OrderTotals
}

export interface PriceMover {
  merchantId: MerchantId
  itemId: ItemId
  open: number
  close: number
  changePct: number
}

export interface DaySummary {
  day: number
  startedAt: number
  endedAt: number
  merchantCash: Record<MerchantId, number>
  playerCash: Record<string, number>
  totalMerchantCash: number
  totalPlayerCash: number
  trades: TradeTotals
  botTrades: number
  bankruptcies: MerchantId[]
  investments: { count: number; amount: number }
  caravan: CaravanTotals
  sinks: SinkTotals
  orders: OrderTotals
  topMovers: PriceMover[]
}

export interface EconomyStats {
  totalBuys: number
  totalSells: number
  tradeVolume: number
  tradeValue: number
  botTrades: number
  botGathers: number
  botItemsGathered: number
  caravanArrivals: number
  caravanUnitsSold: number
  caravanUnitsBought: number
  caravanCashIn: number
  caravanCashOut: number
  bankruptcies: number
  investments: number
  investmentAmount: number
  investmentDistributions: number
  gathers: number
  itemsGathered: number
  crafts: number
  itemsCrafted: number
  itemsConsumed: number
  repairs: number
  toolWear: number
  restocks: number
  ordersCreated: number
  ordersAccepted: number
  ordersFulfilled: number
  orderUnits: number
  orderPayouts: number
  sinks: SinkTotals
  sources: {
    merchantRecovery: number
    orderPayouts: number
  }
}

export interface EconomyWorldState extends MarketState {
  engineSchemaVersion: number
  configHash: string
  configVersion: string
  seed: string
  sequence: number
  players: Record<string, PlayerRuntimeState>
  merchants: Record<MerchantId, MerchantRuntimeState>
  bots: BotRuntimeState[]
  resources: Record<ResourceId, ResourceRuntimeState>
  caravan: CaravanRuntimeState
  investments: InvestmentRecord[]
  orders: OrderState[]
  scenario: ScenarioRuntimeState
  daily: DailyAccumulator
  summaries: DaySummary[]
  stats: EconomyStats
  rngSeed: string
  rngState: number
  rngDraws: number
  fastForwardRuns: number
}

export interface EconomyActionError {
  code: string
  message: string
}

export interface EconomyActionResult<T = unknown> {
  success: boolean
  action: string
  playerId?: string
  error?: EconomyActionError
  data?: T
  events: SequencedMarketEvent[]
  /** Latest world event sequence after the action. */
  sequence: number
}

export interface TradeActionData {
  quote: import('../types').Quote
  requested: number
  filled: number
  unitPrice: number
  total: number
  tax: number
  partial: boolean
}

export interface GatherActionData {
  resourceId: ResourceId
  itemId: ItemId
  quantity: number
  staminaCost: number
  cycles: number
  remainingNodes: number
  toolDurability: number | null
}

export interface WithdrawActionData {
  itemId: ItemId
  quantity: number
  remaining: number
}

export interface CraftActionData {
  recipeId: RecipeId
  quantity: number
  outputs: Record<ItemId, number>
  staminaCost: number
}

export interface RepairActionData {
  itemId: ItemId
  restored: number
  cost: number
}

export interface InvestActionData {
  investment: InvestmentRecord
}

export interface OrderActionData {
  order: OrderState
  paid?: number
}

export interface TickActionData {
  fromTime: number
  toTime: number
  day: number
  steps: number
}

export interface FastForwardSeriesPoint {
  day: number
  endedAt: number
  totalMerchantCash: number
  totalPlayerCash: number
  tradeVolume: number
  tradeValue: number
  bankruptcies: number
  caravanArrivals: number
  sinkTotal: number
}

/** Month-free market snapshot captured at one simulated day close. */
export interface FastForwardPriceSnapshot {
  day: number
  endedAt: number
  /** Keyed by `merchantId:itemId`; only prices, no player or private state. */
  prices: Record<string, { bid: number | null; ask: number | null }>
}

export interface EconomyFastForwardResult {
  success: boolean
  days: number
  fromTime: number
  toTime: number
  startDay: number
  endDay: number
  steps: number
  seed: string
  summaries: DaySummary[]
  series: FastForwardSeriesPoint[]
  priceHistory: FastForwardPriceSnapshot[]
  events: SequencedMarketEvent[]
  eventCount: number
  finalSequence: number
  durationMs: number
  error?: EconomyActionError
}

export interface SpectatorMerchantSnapshot {
  id: MerchantId
  displayName: string
  personality: string
  open: boolean
  bankrupt: boolean
  cash: number
  reserve: number
  stock: Record<ItemId, number>
  targetStock: Record<ItemId, number>
  demandEma: Record<ItemId, number>
  askPrices: Record<ItemId, number>
  bidPrices: Record<ItemId, number>
  bankruptAt: number | null
}

export interface SpectatorSnapshot {
  engineSchemaVersion: number
  configHash: string
  configVersion: string
  seed: string
  time: number
  day: number
  sequence: number
  merchants: SpectatorMerchantSnapshot[]
  players: Record<string, PlayerRuntimeState>
  bots: {
    count: number
    totalCash: number
    trades: number
  }
  resources: Record<ResourceId, ResourceRuntimeState>
  caravan: CaravanRuntimeState
  investments: InvestmentRecord[]
  orders: OrderState[]
  scenario: ScenarioRuntimeState
  stats: EconomyStats
  daily: DailyAccumulator
  summaries: DaySummary[]
  recentEvents: SequencedMarketEvent[]
  firstRetainedSequence: number
}

export interface EconomyEngineOptions {
  state?: EconomyWorldState
  /** Set false to skip the initial order board (useful for deterministic fixtures). */
  seedInitialOrders?: boolean
}

export interface PersistedEconomyEnvelope {
  savedAt: number
  fingerprint: ConfigFingerprint
  state: EconomyWorldState
}

export interface EconomyServiceOptions {
  config: EconomyConfig
  store: EconomyStore
  autoSave?: boolean
}

export interface EconomyStore {
  load(): Promise<PersistedEconomyEnvelope | null>
  save(envelope: PersistedEconomyEnvelope): Promise<void>
  reset(): Promise<void>
  location?(): string
}
