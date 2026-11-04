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
  buyProbability: number
  sellProbability: number
}

export interface BotStartingCashConfig {
  min: number
  max: number
}

export interface BotsConfig {
  count: number
  behavior: BotBehaviorConfig
  startingCash: BotStartingCashConfig
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
  | 'system.fast-forward'
  | 'system.configuration'

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
