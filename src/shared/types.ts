/**
 * Shared domain and configuration types for Ironblock.
 *
 * IDs are config-defined strings on purpose: the economy is data-driven and the
 * merchant/item/resource count may change without touching execution code.
 */

export type ItemId = string
export type MerchantId = string
export type ResourceId = string
export type RecipeId = string
export type PersonalityId = string

export type ItemCategory =
  | 'ore'
  | 'metal'
  | 'grain'
  | 'food'
  | 'timber'
  | 'wood'
  | 'fiber'
  | 'textile'
  | 'tool'
  | 'clothing'

export type ItemUseKind = 'ingredient' | 'tool' | 'consumable' | 'wearable'
export type ToolKind = 'pickaxe' | 'hoe' | 'axe'
export type RecipeCategory =
  | 'smelting'
  | 'milling'
  | 'sawing'
  | 'weaving'
  | 'cooking'
  | 'smithing'
  | 'tailoring'

export type TradeSide = 'buy' | 'sell'

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

export interface EconomyMetaConfig {
  name: string
  version: string
  schemaVersion: number
  seed: string
  description: string
}

export interface CurrencyConfig {
  code: string
  symbol: string
  decimals: number
  startingPlayerBalance: number
}

export interface ItemTokenMetadata {
  standard: 'nep-245'
  contract: string
  tokenId: string
  symbol: string
  decimals: number
  icon: string
  reference: string
}

export interface ItemUseConfig {
  kind: ItemUseKind
  toolKind?: ToolKind
  staminaRestore?: number
}

export interface ToolConfig {
  kind: ToolKind
  maxDurability: number
  gatherSpeedMultiplier: number
}

export interface ItemConfig {
  id: ItemId
  displayName: string
  description: string
  category: ItemCategory
  baseValue: number
  weight: number
  icon: string
  token: ItemTokenMetadata
  use: ItemUseConfig
  tool?: ToolConfig
}

export interface YieldRange {
  min: number
  max: number
}

export interface ResourceNodeConfig {
  id: ResourceId
  displayName: string
  itemId: ItemId
  nodeCount: number
  yieldRange: YieldRange
  respawnSeconds: number
  staminaCost: number
  requiredTool?: ToolKind
}

export interface ResourcesConfig {
  nodes: Record<ResourceId, ResourceNodeConfig>
}

export interface RecipeConfig {
  id: RecipeId
  displayName: string
  category: RecipeCategory
  inputs: Record<ItemId, number>
  outputs: Record<ItemId, number>
  staminaCost: number
  durationSeconds: number
}

export interface PersonalityConfig {
  stockSensitivity: number
  demandSensitivity: number
  cashBidSensitivity: number
  cashAskSensitivity: number
  rivalSensitivity: number
  buyMarginMultiplier: number
  sellMarginMultiplier: number
  spreadMultiplier: number
}

export interface MerchantMargins {
  buy: number
  sell: number
}

export interface RestockRateConfig {
  intervalSeconds: number
  unitsPerTick: number
  targetRatio: number
}

export interface SupplyChainConfig {
  inputs: Record<ItemId, number>
  outputs: Record<ItemId, number>
  batchesPerRestock: number
}

export interface MerchantConfig {
  id: MerchantId
  displayName: string
  stallSlot: number
  personality: PersonalityId
  cash: number
  reserve: number
  targetStock: Record<ItemId, number>
  buys: ItemId[]
  sells: ItemId[]
  margins: MerchantMargins
  restockRate: RestockRateConfig
  supplyChain?: SupplyChainConfig
}

export interface StockPricingConfig {
  elasticity: number
  minFactor: number
  maxFactor: number
  fallbackTargetStock: number
}

export interface DemandPricingConfig {
  windowSeconds: number
  weight: number
  emaAlpha: number
  maxPressure: number
}

export interface CashPricingConfig {
  weight: number
  bidWeight: number
  askWeight: number
  comfortMultiple: number
  bankruptcyRatio: number
  minFactor: number
  maxFactor: number
}

export interface RivalPricingConfig {
  weight: number
  maxAdjustment: number
  maxRivals: number
  /** Rotate the deterministic rival sample at this interval. */
  rotationSeconds: number
}

export interface SpreadPricingConfig {
  base: number
  min: number
  max: number
}

export interface PriceClampsConfig {
  minMultiplier: number
  maxMultiplier: number
  minUnitPrice: number
  maxUnitPrice: number
}

export type RoundingMode = 'nearest' | 'floor' | 'ceil'

export interface RoundingConfig {
  decimals: number
  mode: RoundingMode
}

export interface TradePricingConfig {
  maxQuantityPerTrade: number
  maxStockMultiple: number
  allowPartialFills: boolean
}

export interface PricingConfig {
  stock: StockPricingConfig
  demand: DemandPricingConfig
  cash: CashPricingConfig
  rival: RivalPricingConfig
  spread: SpreadPricingConfig
  clamps: PriceClampsConfig
  rounding: RoundingConfig
  trade: TradePricingConfig
}

export interface PlayerStaminaConfig {
  max: number
  regenerationPerSecond: number
}

export interface PlayerConfig {
  carryCapacity: number
  stamina: PlayerStaminaConfig
  gatherDurationSeconds: number
  startingCash: number
  startingTool: ItemId
  startingInventory: Record<ItemId, number>
}

export interface BotBehaviorConfig {
  cadenceSeconds: number
  jitterSeconds: number
  maxTradeQuantity: number
  /** Merchant offers a bot tests before giving up on a trade. */
  maxTradeAttempts: number
  buyProbability: number
  sellProbability: number
}

export interface BotStartingCashConfig {
  min: number
  max: number
}

/** Deterministic bot seed inventory; no item IDs are hardcoded in the engine. */
export interface BotStartingInventoryConfig {
  chance: number
  quantityRange: YieldRange
  fallbackQuantityRange: YieldRange
}

export interface BotsConfig {
  count: number
  behavior: BotBehaviorConfig
  startingCash: BotStartingCashConfig
  startingInventory: BotStartingInventoryConfig
}

export interface CaravanGoodConfig {
  itemId: ItemId
  quantityRange: YieldRange
}

export interface CaravanPriceBiasConfig {
  bid: number
  ask: number
}

export interface CaravanConfig {
  intervalSeconds: number
  goods: CaravanGoodConfig[]
  priceBias: CaravanPriceBiasConfig
}

export interface StallRentConfig {
  amountPerDay: number
  graceDays: number
}

export interface SalesTaxConfig {
  rate: number
  appliesTo: 'player' | 'merchant'
}

export interface ToolDurabilitySinkConfig {
  lossPerGather: number
  repairCostPerPoint: number
  repairThresholdRatio: number
}

export interface SinksConfig {
  stallRent: StallRentConfig
  salesTax: SalesTaxConfig
  toolDurability: ToolDurabilitySinkConfig
}

/** Passive cash recovery for open merchants that are under their comfort target. */
export interface CashRecoveryConfig {
  /** Fraction of the merchant reserve credited per closed day at most. */
  dailyRate: number
  /** Recovery stops once cash reaches reserve * targetReserveMultiple. */
  targetReserveMultiple: number
}

/** How investments are repaid from future merchant profit. */
export interface InvestmentConfig {
  /** Fraction of positive daily merchant profit shared with investors. */
  profitShareRate: number
  /** Skip distributions below this amount. */
  minDistribution: number
}

export interface OrderTemplateConfig {
  id: string
  issuer: string
  itemId: ItemId
  quantityRange: YieldRange
}

/** Optional bot participation on the town order board. */
export interface OrderBotParticipationConfig {
  enabled: boolean
  /** Chance a bot with matching stock checks the order board on an action. */
  chance: number
  /** Cap on units a single bot delivery may hand to an order. */
  maxUnitsPerDelivery: number
}

/** Daily bulk-order board. All quantities and rewards stay data-driven. */
export interface OrdersConfig {
  maxActive: number
  /** A new batch of orders is considered every N days. */
  cadenceDays: number
  expiryDays: number
  rewardMultiplier: YieldRange
  templates: OrderTemplateConfig[]
  botParticipation: OrderBotParticipationConfig
}

export type ScenarioShockKind = 'cash-drain' | 'bulk-purchase'

/** A deterministic story beat that applies once at a configured world time. */
export interface ScenarioShockConfig {
  id: string
  /** 1-based world day. */
  day: number
  /** Second of the day, 0-86399. */
  atSecond: number
  merchantId: MerchantId
  kind: ScenarioShockKind
  /** Cash removed by a cash-drain shock. */
  amount?: number
  /** Item bought by a bulk-purchase shock. */
  itemId?: ItemId
  /** Maximum units sought by a bulk-purchase shock. */
  quantity?: number
  /** Unit price offered for a bulk-purchase shock. */
  unitPrice?: number
  /** Plain-language narrative shown in the event feed. */
  message: string
  /** Optional scheduled rescue investment from the configured scenario investor. */
  rescue?: ScenarioRescueConfig
}

export interface ScenarioRescueConfig {
  investorId: string
  amount: number
  /** Wait this long after the bankruptcy before the investor acts. */
  delaySeconds: number
}

export interface ScenarioInvestorConfig {
  id: string
  displayName: string
  cash: number
}

/** Data-only demo story. Empty shocks keep the economy in its stable sandbox mode. */
export interface ScenarioConfig {
  id: string
  description: string
  investor?: ScenarioInvestorConfig
  shocks: ScenarioShockConfig[]
}

export interface ReportingConfig {
  eventRetention: number
  summaryRetentionDays: number
  topMovers: number
  eventSampleSize: number
}

export type FastForwardSeedBehavior = 'reuse-config-seed' | 'derive-per-run'

export interface FastForwardConfig {
  days: number
  stepSeconds: number
  durationSeconds: number
  maxDays: number
  maxSteps: number
  seedBehavior: FastForwardSeedBehavior
}

export interface EconomyConfig {
  meta: EconomyMetaConfig
  currency: CurrencyConfig
  items: Record<ItemId, ItemConfig>
  resources: ResourcesConfig
  recipes: Record<RecipeId, RecipeConfig>
  personalities: Record<PersonalityId, PersonalityConfig>
  merchants: Record<MerchantId, MerchantConfig>
  pricing: PricingConfig
  player: PlayerConfig
  bots: BotsConfig
  caravan: CaravanConfig
  sinks: SinksConfig
  cashRecovery: CashRecoveryConfig
  investments: InvestmentConfig
  orders: OrdersConfig
  scenario: ScenarioConfig
  reporting: ReportingConfig
  fastForward: FastForwardConfig
}

/* -------------------------------------------------------------------------- */
/* Runtime state                                                              */
/* -------------------------------------------------------------------------- */

export interface MerchantState {
  id: MerchantId
  displayName: string
  personality: PersonalityId
  cash: number
  reserve: number
  stock: Record<ItemId, number>
  targetStock: Record<ItemId, number>
  /** Exponential moving average of recently traded units, per item. */
  demandEma: Record<ItemId, number>
  open: boolean
  lastRestockAt?: number
  lastTradeAt?: number
}

export interface PlayerEconomyState {
  id: string
  cash: number
  inventory: Record<ItemId, number>
  stamina: number
  maxStamina: number
  equippedTool?: ItemId
  toolDurability?: Record<ItemId, number>
}

export interface MarketState {
  time: number
  day: number
  seed: string
  merchants: Record<MerchantId, MerchantState>
  /** Optional: when present, quotes enforce player cash, inventory and carry limits. */
  player?: PlayerEconomyState
}

/* -------------------------------------------------------------------------- */
/* Quotes                                                                     */
/* -------------------------------------------------------------------------- */

export interface PriceReason {
  code: string
  label: string
  /** The measured input behind the adjustment (ratio, pressure, rate, etc.). */
  value: number
  /** Signed change in unit price caused by this step, in currency units. */
  effect: number
  detail?: string
}

export interface QuoteConstraints {
  stock: number
  merchantCash: number
  merchantReserve: number
  playerCash: number | null
  playerInventory: number | null
  playerCarryFree: number | null
  maxByStock: number
  maxByMerchantCash: number | null
  maxByPlayerCash: number | null
  maxByPlayerInventory: number | null
  maxByCarry: number | null
  maxByTradeLimit: number
  maxFill: number
}

export interface Quote {
  merchantId: MerchantId
  itemId: ItemId
  side: TradeSide
  /** Requested quantity. */
  quantity: number
  basePrice: number
  unitPrice: number
  total: number
  currencySymbol: string
  reasons: PriceReason[]
  canTrade: boolean
  fillQuantity: number
  maxQuantity: number
  partialFill: boolean
  merchantOpen: boolean
  merchantBankrupt: boolean
  constraints: QuoteConstraints
  blockedReason?: string
}

/* -------------------------------------------------------------------------- */
/* Events                                                                     */
/* -------------------------------------------------------------------------- */

export type EventActorType = 'player' | 'merchant' | 'bot' | 'caravan' | 'system'

export type EventCauseType =
  | 'trade'
  | 'restock'
  | 'price-change'
  | 'investment'
  | 'bankruptcy'
  | 'rent'
  | 'tax'
  | 'repair'
  | 'gather'
  | 'craft'
  | 'caravan'
  | 'fast-forward'
  | 'configuration'
  | 'order'
  | 'use'
  | 'shock'
  | 'withdrawal'

export type MarketEventType =
  | 'trade.buy'
  | 'trade.sell'
  | 'merchant.restock'
  | 'merchant.bankrupt'
  | 'merchant.investment'
  | 'merchant.price'
  | 'player.gather'
  | 'player.craft'
  | 'player.repair'
  | 'sink.rent'
  | 'sink.tax'
  | 'caravan.arrival'
  | 'bot.trade'
  | 'bot.gather'
  | 'system.fast-forward'
  | 'system.configuration'
  | 'player.join'
  | 'player.use'
  | 'merchant.reopen'
  | 'merchant.distribution'
  | 'merchant.recovery'
  | 'order.created'
  | 'order.accepted'
  | 'order.fulfilled'
  | 'order.expired'
  | 'system.shock'
  | 'player.withdraw'

export interface EventActor {
  type: EventActorType
  id: string
  displayName?: string
}

export interface MarketEventSnapshot {
  /** Null means the field does not apply to this event, not that it is zero. */
  stock: number | null
  cash: number | null
  bid: number | null
  ask: number | null
}

export interface MarketEvent {
  id: string
  time: number
  type: MarketEventType
  actor: EventActor
  item: ItemId | null
  quantity: number | null
  price: number | null
  before: MarketEventSnapshot
  after: MarketEventSnapshot
  reasons: PriceReason[]
  cause: EventCauseType
  causeId: string
  message: string
}
