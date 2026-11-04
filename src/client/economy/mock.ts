import {
  botIdForIndex,
  characterForBotIndex,
} from '../../config/characters'
import { economy } from '../../config/economy'
import { createMarketEvent } from '../../shared/market-events'
import { isMerchantBankrupt, quote } from '../../shared/pricing'
import { stableHash64, stableStringify } from '../../shared/stable-hash'
import type {
  EconomyConfig,
  ItemId,
  MarketEvent,
  MarketEventSnapshot,
  MarketState,
  MerchantConfig,
  MerchantId,
  MerchantState,
  PlayerEconomyState,
  PriceReason,
  Quote,
  RecipeId,
  ResourceId,
  TradeSide,
} from '../../shared/types'
import type {
  CraftResult,
  EatResult,
  EconomyClient,
  EconomySnapshot,
  FastForwardClient,
  FastForwardDay,
  FastForwardEvent,
  FastForwardState,
  GatherResult,
  InvestResult,
  InventoryLine,
  MerchantSummary,
  MerchantView,
  OrderBoardEntry,
  PlayerView,
  RecapTopMover,
  RepairResult,
  SessionRecap,
  ToolView,
  TownHealth,
  TradeRequest,
  TradeResult,
} from './types'

/* -------------------------------------------------------------------------- */
/* Deterministic helpers                                                      */
/* -------------------------------------------------------------------------- */

/** Small, fast, deterministic PRNG. */
function mulberry32(seed: number): () => number {
  let value = seed >>> 0
  return () => {
    value = (value + 0x6d2b79f5) >>> 0
    let t = value
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function seededRandom(seedText: string): () => number {
  const hash = parseInt(stableHash64(seedText), 16) >>> 0
  return mulberry32(hash)
}

const roundMoney = (config: EconomyConfig, value: number): number => {
  const scale = 10 ** config.currency.decimals
  return Math.round(value * scale) / scale
}

const DAY_SECONDS = 86_400
const MARKET_OPENS_AT = 8 * 3600

export const requiredInvestmentFor = (cash: number, reserve: number): number =>
  Math.max(0, Math.ceil(reserve * 2 - cash))

/* -------------------------------------------------------------------------- */
/* Mock economy                                                               */
/* -------------------------------------------------------------------------- */

interface MockStats {
  rent: number
  tax: number
  repairs: number
  tradeCount: number
  buyCount: number
  sellCount: number
  tradeVolume: number
  tradeValue: number
  caravanArrivals: number
}

interface MockOptions {
  config?: EconomyConfig
  /** Delay between simulated days in the fast-forward playback (ms). */
  fastForwardPaceMs?: number
}

interface MockPlayer extends PlayerEconomyState {
  stats: MockStats
  equippedTool: ItemId
  toolDurability: Record<ItemId, number>
}

type Holder = { itemId: ItemId; durability: number }

const emptyStats = (): MockStats => ({
  rent: 0,
  tax: 0,
  repairs: 0,
  tradeCount: 0,
  buyCount: 0,
  sellCount: 0,
  tradeVolume: 0,
  tradeValue: 0,
  caravanArrivals: 0,
})

export class MockEconomyClient implements EconomyClient {
  readonly mode = 'mock' as const
  readonly fastForward: MockFastForwardClient

  readonly config: EconomyConfig
  private readonly listeners = new Set<() => void>()
  private merchants: Record<MerchantId, MerchantState> = {}
  private player!: MockPlayer
  private events: MarketEvent[] = []
  private sequence = 0
  private sessionDay = 1
  private sessionTime = MARKET_OPENS_AT
  private rng!: () => number
  private resetCount = 0
  private recapCache: SessionRecap | null = null

  constructor(options: MockOptions = {}) {
    this.config = options.config ?? economy
    this.fastForward = new MockFastForwardClient(this, options.fastForwardPaceMs ?? 220)
    this.reset()
  }

  /* --------------------------------- state -------------------------------- */

  reset(): void {
    this.resetCount += 1
    this.merchants = {}
    for (const config of Object.values(this.config.merchants)) {
      this.merchants[config.id] = {
        id: config.id,
        displayName: config.displayName,
        personality: config.personality,
        cash: config.cash,
        reserve: config.reserve,
        stock: { ...config.targetStock },
        targetStock: { ...config.targetStock },
        demandEma: Object.fromEntries(
          Object.keys(config.targetStock).map(itemId => [itemId, 0]),
        ),
        open: true,
      }
    }

    const inventory: Record<ItemId, number> = { ...this.config.player.startingInventory }
    const equippedTool = this.config.player.startingTool
    if (this.config.items[equippedTool]?.use.kind === 'tool') {
      inventory[equippedTool] = Math.max(1, inventory[equippedTool] ?? 0)
    }
    const toolDurability: Record<ItemId, number> = {}
    for (const [itemId, item] of Object.entries(this.config.items)) {
      if (item.tool) toolDurability[itemId] = item.tool.maxDurability
    }

    this.player = {
      id: 'player-town',
      cash: this.config.player.startingCash,
      inventory,
      stamina: this.config.player.stamina.max,
      maxStamina: this.config.player.stamina.max,
      equippedTool,
      toolDurability,
      stats: emptyStats(),
    }

    this.events = []
    this.sequence = 0
    this.sessionDay = 1
    this.sessionTime = MARKET_OPENS_AT
    this.rng = seededRandom(
      `${this.config.meta.seed}:session:${this.resetCount}`,
    )
    this.recapCache = null
    this.fastForward.stop()
    this.notify()
  }

  private market(): MarketState {
    return {
      time: this.sessionTime,
      day: this.sessionDay,
      seed: this.config.meta.seed,
      merchants: this.merchants,
      player: this.player,
    }
  }

  private notify(): void {
    this.recapCache = null
    for (const listener of this.listeners) listener()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /* ------------------------------- reading -------------------------------- */

  private merchantConfig(id: MerchantId): MerchantConfig | undefined {
    return this.config.merchants[id]
  }

  private merchantState(id: MerchantId): MerchantState | undefined {
    return this.merchants[id]
  }

  private requiredInvestment(state: MerchantState): number {
    return requiredInvestmentFor(state.cash, state.reserve)
  }

  private merchantSummary(state: MerchantState): MerchantSummary {
    const config = this.merchantConfig(state.id)
    const stockEntries = Object.entries(state.stock)
    return {
      id: state.id,
      displayName: state.displayName,
      personality: state.personality,
      cash: state.cash,
      reserve: state.reserve,
      open: state.open,
      bankrupt: isMerchantBankrupt(state, this.config),
      requiredInvestment: this.requiredInvestment(state),
      stockUnits: stockEntries.reduce((sum, [, quantity]) => sum + quantity, 0),
      stockValue: roundMoney(
        this.config,
        stockEntries.reduce(
          (sum, [itemId, quantity]) =>
            sum + quantity * (this.config.items[itemId]?.baseValue ?? 0),
          0,
        ),
      ),
    }
  }

  private townHealth(): TownHealth {
    const all = Object.values(this.merchants)
    const open = all.filter(merchant => merchant.open && !isMerchantBankrupt(merchant, this.config))
    const ratio = open.length / Math.max(1, all.length)
    if (ratio >= 1) return 'thriving'
    if (ratio >= 0.75) return 'stable'
    if (ratio >= 0.4) return 'strained'
    return 'critical'
  }

  private playerView(): PlayerView {
    const inventory: InventoryLine[] = []
    for (const [itemId, quantity] of Object.entries(this.player.inventory)) {
      if (quantity <= 0) continue
      const item = this.config.items[itemId]
      if (!item) continue
      const tool: ToolView | undefined = item.tool
        ? {
            itemId,
            displayName: item.displayName,
            durability: this.player.toolDurability[itemId] ?? item.tool.maxDurability,
            maxDurability: item.tool.maxDurability,
          }
        : undefined
      inventory.push({
        itemId,
        displayName: item.displayName,
        category: item.category,
        quantity,
        unitWeight: item.weight,
        totalWeight: Math.round(quantity * item.weight * 100) / 100,
        equipped: this.player.equippedTool === itemId,
        tool,
      })
    }
    inventory.sort(
      (left, right) =>
        left.category.localeCompare(right.category) ||
        left.displayName.localeCompare(right.displayName),
    )

    const weight = inventory.reduce((sum, line) => sum + line.totalWeight, 0)
    return {
      cash: this.player.cash,
      inventory,
      stamina: this.player.stamina,
      maxStamina: this.player.maxStamina,
      weight: Math.round(weight * 100) / 100,
      carryCapacity: this.config.player.carryCapacity,
      equippedTool: this.player.equippedTool ?? null,
      toolDurability: { ...this.player.toolDurability },
    }
  }

  private clockLabel(): string {
    const dayTime = ((this.sessionTime % DAY_SECONDS) + DAY_SECONDS) % DAY_SECONDS
    const hours = Math.floor(dayTime / 3600)
    const minutes = Math.floor((dayTime % 3600) / 60)
    const pad = (value: number) => String(value).padStart(2, '0')
    return `Day ${this.sessionDay} · ${pad(hours)}:${pad(minutes)}`
  }

  async getSnapshot(): Promise<EconomySnapshot> {
    const merchants = Object.values(this.merchants)
      .map(state => this.merchantSummary(state))
      .sort((left, right) => {
        const leftSlot = this.merchantConfig(left.id)?.stallSlot ?? 0
        const rightSlot = this.merchantConfig(right.id)?.stallSlot ?? 0
        return leftSlot - rightSlot
      })

    return {
      day: this.sessionDay,
      time: this.sessionTime,
      clock: this.clockLabel(),
      player: this.playerView(),
      merchants,
      openMerchants: merchants.filter(merchant => merchant.open && !merchant.bankrupt).length,
      bankruptcies: merchants.filter(merchant => merchant.bankrupt).length,
      townHealth: this.townHealth(),
      recentEvents: this.events.slice(-25).reverse(),
      orderBoardSupported: false,
    }
  }

  async getMerchant(id: MerchantId): Promise<MerchantView | null> {
    const state = this.merchantState(id)
    const config = this.merchantConfig(id)
    if (!state || !config) return null
    return {
      ...this.merchantSummary(state),
      buys: [...config.buys],
      sells: [...config.sells],
      stock: { ...state.stock },
      targetStock: { ...state.targetStock },
      buyMargin: config.margins.buy,
      sellMargin: config.margins.sell,
    }
  }

  async getQuote(
    merchantId: MerchantId,
    itemId: ItemId,
    side: TradeSide,
    quantity: number,
  ): Promise<Quote> {
    const state = this.merchantState(merchantId)
    if (!state) {
      throw new Error(`Unknown merchant: ${merchantId}`)
    }
    return quote(state, itemId, side, quantity, this.market(), this.config)
  }

  async getEvents(since?: string): Promise<MarketEvent[]> {
    if (!since) return [...this.events]
    const index = this.events.findIndex(event => event.id === since)
    return index < 0 ? [...this.events] : this.events.slice(index + 1)
  }

  async getOrderBoard(): Promise<OrderBoardEntry[]> {
    // The mock does not have a live order book. The panel renders a clearly
    // labelled placeholder so the integration agent can wire the real service.
    return []
  }

  /* -------------------------------- events -------------------------------- */

  private nextEventId(): string {
    this.sequence += 1
    return `evt_mock_${this.sequence.toString(36)}`
  }

  private snapshotFor(
    state: MerchantState,
    itemId: ItemId,
    side: TradeSide,
  ): MarketEventSnapshot {
    return {
      stock: state.stock[itemId] ?? 0,
      cash: roundMoney(this.config, state.cash),
      bid: this.quoteUnit(state, itemId, 'sell'),
      ask: this.quoteUnit(state, itemId, 'buy'),
    }
  }

  private quoteUnit(
    state: MerchantState,
    itemId: ItemId,
    side: TradeSide,
  ): number | null {
    const config = this.config.merchants[state.id]
    if (!config) return null
    const offers = side === 'buy' ? config.sells : config.buys
    if (!offers.includes(itemId)) return null
    const result = quote(state, itemId, side, 1, this.market(), this.config)
    return result.unitPrice > 0 ? result.unitPrice : null
  }

  private recordEvent(input: {
    type: MarketEvent['type']
    actor: MarketEvent['actor']
    item?: ItemId | null
    quantity?: number | null
    price?: number | null
    before: MarketEventSnapshot
    after: MarketEventSnapshot
    reasons?: PriceReason[]
    cause: MarketEvent['cause']
    causeId?: string
    message?: string
  }): MarketEvent {
    const event = createMarketEvent({
      id: this.nextEventId(),
      time: this.sessionTime,
      type: input.type,
      actor: input.actor,
      item: input.item,
      quantity: input.quantity,
      price: input.price,
      before: input.before,
      after: input.after,
      reasons: input.reasons ?? [],
      cause: input.cause,
      causeId: input.causeId ?? `mock-${this.sequence}`,
      message: input.message,
    })
    this.events.push(event)
    return event
  }

  private failTrade(quoteResult: Quote, message: string): TradeResult {
    return {
      ok: false,
      message,
      quote: quoteResult,
      fillQuantity: 0,
      total: 0,
    }
  }

  /* -------------------------------- trading ------------------------------- */

  async buy(request: TradeRequest): Promise<TradeResult> {
    return this.trade('buy', request)
  }

  async sell(request: TradeRequest): Promise<TradeResult> {
    return this.trade('sell', request)
  }

  private trade(side: TradeSide, request: TradeRequest): TradeResult {
    const state = this.merchantState(request.merchantId)
    const config = this.merchantConfig(request.merchantId)
    const item = this.config.items[request.itemId]
    if (!state || !config || !item) {
      throw new Error(`Unknown trade target: ${request.merchantId}/${request.itemId}`)
    }

    const quantity = Math.max(1, Math.floor(request.quantity))
    const result = quote(state, request.itemId, side, quantity, this.market(), this.config)

    if (!result.canTrade || result.fillQuantity <= 0) {
      const message = blockedMessage(result, this.config.items)
      return this.failTrade(result, message)
    }

    const fill = result.fillQuantity
    const total = result.total
    const before = this.snapshotFor(state, request.itemId, side)

    if (side === 'buy') {
      this.player.cash = roundMoney(this.config, this.player.cash - total)
      this.player.inventory[request.itemId] =
        (this.player.inventory[request.itemId] ?? 0) + fill
      state.cash = roundMoney(this.config, state.cash + total)
      state.stock[request.itemId] = Math.max(0, (state.stock[request.itemId] ?? 0) - fill)

      const tax = roundMoney(
        this.config,
        total * this.config.sinks.salesTax.rate,
      )
      if (tax > 0) {
        state.cash = roundMoney(this.config, state.cash - tax)
        this.player.stats.tax = roundMoney(this.config, this.player.stats.tax + tax)
        this.recordEvent({
          type: 'sink.tax',
          actor: { type: 'merchant', id: state.id, displayName: state.displayName },
          item: request.itemId,
          quantity: fill,
          price: tax,
          before,
          after: this.snapshotFor(state, request.itemId, side),
          cause: 'tax',
          message: `${state.displayName} pays ${tax.toFixed(2)} ${this.config.currency.symbol} stall tax on the sale`,
        })
      }

      this.player.stats.tradeCount += 1
      this.player.stats.buyCount += 1
      this.player.stats.tradeVolume += fill
      this.player.stats.tradeValue = roundMoney(this.config, this.player.stats.tradeValue + total)
    } else {
      this.player.cash = roundMoney(this.config, this.player.cash + total)
      this.player.inventory[request.itemId] = Math.max(
        0,
        (this.player.inventory[request.itemId] ?? 0) - fill,
      )
      state.cash = roundMoney(this.config, state.cash - total)
      state.stock[request.itemId] = (state.stock[request.itemId] ?? 0) + fill

      this.player.stats.tradeCount += 1
      this.player.stats.sellCount += 1
      this.player.stats.tradeVolume += fill
      this.player.stats.tradeValue = roundMoney(this.config, this.player.stats.tradeValue + total)
    }

    updateDemand(state, request.itemId, fill, this.config)
    state.lastTradeAt = this.sessionTime
    this.sessionTime += 20

    this.recordEvent({
      type: side === 'buy' ? 'trade.buy' : 'trade.sell',
      actor: { type: 'player', id: this.player.id, displayName: 'You' },
      item: request.itemId,
      quantity: fill,
      price: result.unitPrice,
      before,
      after: this.snapshotFor(state, request.itemId, side),
      reasons: result.reasons,
      cause: 'trade',
      message:
        side === 'buy'
          ? `You bought ${fill} ${item.displayName} from ${state.displayName} for ${total.toFixed(2)} ${this.config.currency.symbol}`
          : `You sold ${fill} ${item.displayName} to ${state.displayName} for ${total.toFixed(2)} ${this.config.currency.symbol}`,
    })

    this.applyBankruptcy(state)
    this.notify()

    const verb = side === 'buy' ? 'Bought' : 'Sold'
    return {
      ok: true,
      message: `${verb} ${fill} ${item.displayName} for ${total.toFixed(2)} ${this.config.currency.symbol}.`,
      quote: result,
      fillQuantity: fill,
      total,
    }
  }

  private applyBankruptcy(state: MerchantState): void {
    if (state.open && isMerchantBankrupt(state, this.config)) {
      const before = this.snapshotFor(state, Object.keys(state.stock)[0] ?? '', 'sell')
      state.open = false
      this.recordEvent({
        type: 'merchant.bankrupt',
        actor: { type: 'merchant', id: state.id, displayName: state.displayName },
        before,
        after: this.snapshotFor(state, Object.keys(state.stock)[0] ?? '', 'sell'),
        cause: 'bankruptcy',
        message: `${state.displayName} is below reserve (${state.cash.toFixed(2)} ${this.config.currency.symbol}) and closes until invested in.`,
      })
    }
  }

  /* ------------------------------ gathering ------------------------------- */

  async gather(resourceId: ResourceId): Promise<GatherResult> {
    const node = this.config.resources.nodes[resourceId]
    if (!node) throw new Error(`Unknown resource: ${resourceId}`)
    const item = this.config.items[node.itemId]
    if (!item) throw new Error(`Resource ${resourceId} points at an unknown item`)

    const fail = (message: string, durabilityLeft: number | null = null): GatherResult => ({
      ok: false,
      message,
      itemId: node.itemId,
      quantity: 0,
      staminaSpent: 0,
      durabilityLeft,
    })

    if (this.player.stamina < node.staminaCost) {
      return fail('Too tired to gather. Eat something or rest.')
    }
    if (node.requiredTool) {
      const equipped = this.player.equippedTool
      const toolItem = equipped ? this.config.items[equipped] : undefined
      if (!toolItem || toolItem.tool?.kind !== node.requiredTool) {
        return fail(`Requires a ${node.requiredTool}. Equip one from your bag first.`)
      }
      const durability = this.player.toolDurability[equipped as string] ?? 0
      if (durability <= 0) {
        return fail(`Your ${toolItem.displayName} is worn out. Repair it first.`, 0)
      }
    }

    const freeWeight = this.config.player.carryCapacity - this.currentWeight()
    if (freeWeight < item.weight) {
      return fail(`Not enough carry capacity for ${item.displayName}.`)
    }

    const toolItemId = this.player.equippedTool
    const durabilityBefore =
      toolItemId && this.config.items[toolItemId]?.tool
        ? (this.player.toolDurability[toolItemId] ?? 0)
        : null

    const roll = this.rng()
    const quantity =
      node.yieldRange.min +
      Math.floor(roll * (node.yieldRange.max - node.yieldRange.min + 1))

    this.player.inventory[node.itemId] =
      (this.player.inventory[node.itemId] ?? 0) + quantity
    this.player.stamina = Math.max(0, this.player.stamina - node.staminaCost)
    this.sessionTime += Math.round(this.config.player.gatherDurationSeconds)

    let durabilityLeft = durabilityBefore
    if (durabilityBefore !== null && toolItemId) {
      const loss = this.config.sinks.toolDurability.lossPerGather
      durabilityLeft = Math.max(0, durabilityBefore - loss)
      this.player.toolDurability[toolItemId] = durabilityLeft
      if (durabilityLeft <= 0) {
        this.player.inventory[toolItemId] = 0
      }
    }

    const before = this.snapshotFor(Object.values(this.merchants)[0], node.itemId, 'sell')
    this.recordEvent({
      type: 'player.gather',
      actor: { type: 'player', id: this.player.id, displayName: 'You' },
      item: node.itemId,
      quantity,
      before,
      after: { ...before, stock: null },
      cause: 'gather',
      message: `You gathered ${quantity} ${item.displayName} at the ${node.displayName}.`,
    })

    this.notify()
    return {
      ok: true,
      message: `+${quantity} ${item.displayName} · stamina −${node.staminaCost}`,
      itemId: node.itemId,
      quantity,
      staminaSpent: node.staminaCost,
      durabilityLeft,
    }
  }

  private currentWeight(): number {
    return Object.entries(this.player.inventory).reduce((sum, [itemId, quantity]) => {
      const item = this.config.items[itemId]
      return item ? sum + Math.max(0, quantity) * item.weight : sum
    }, 0)
  }

  /* -------------------------------- crafting ------------------------------ */

  async craft(recipeId: RecipeId): Promise<CraftResult> {
    const recipe = this.config.recipes[recipeId]
    if (!recipe) throw new Error(`Unknown recipe: ${recipeId}`)

    const fail = (message: string): CraftResult => ({
      ok: false,
      message,
      recipeId,
      outputs: {},
      staminaSpent: 0,
    })

    for (const [itemId, quantity] of Object.entries(recipe.inputs)) {
      if ((this.player.inventory[itemId] ?? 0) < quantity) {
        return fail(`Missing ${quantity}× ${this.config.items[itemId]?.displayName ?? itemId}.`)
      }
    }
    if (this.player.stamina < recipe.staminaCost) {
      return fail('Not enough stamina to craft this.')
    }

    const beforeWeight = this.currentWeight()
    let afterWeight = beforeWeight
    for (const [itemId, quantity] of Object.entries(recipe.inputs)) {
      afterWeight -= quantity * (this.config.items[itemId]?.weight ?? 0)
    }
    for (const [itemId, quantity] of Object.entries(recipe.outputs)) {
      afterWeight += quantity * (this.config.items[itemId]?.weight ?? 0)
    }
    if (afterWeight > this.config.player.carryCapacity) {
      return fail('The finished goods would exceed your carry capacity.')
    }

    for (const [itemId, quantity] of Object.entries(recipe.inputs)) {
      this.player.inventory[itemId] = Math.max(
        0,
        (this.player.inventory[itemId] ?? 0) - quantity,
      )
    }
    for (const [itemId, quantity] of Object.entries(recipe.outputs)) {
      this.player.inventory[itemId] = (this.player.inventory[itemId] ?? 0) + quantity
    }
    this.player.stamina = Math.max(0, this.player.stamina - recipe.staminaCost)
    this.sessionTime += recipe.durationSeconds

    const firstItem = Object.keys(recipe.outputs)[0]
    const before = this.snapshotFor(Object.values(this.merchants)[0], firstItem, 'buy')
    this.recordEvent({
      type: 'player.craft',
      actor: { type: 'player', id: this.player.id, displayName: 'You' },
      item: firstItem,
      quantity: Object.values(recipe.outputs)[0] ?? null,
      before,
      after: { ...before, stock: null },
      cause: 'craft',
      message: `You crafted ${recipe.displayName}.`,
    })

    this.notify()
    return {
      ok: true,
      message: `${recipe.displayName} complete.`,
      recipeId,
      outputs: { ...recipe.outputs },
      staminaSpent: recipe.staminaCost,
    }
  }

  /* ------------------------------ town actions ---------------------------- */

  async invest(merchantId: MerchantId, amount?: number): Promise<InvestResult> {
    const state = this.merchantState(merchantId)
    const config = this.merchantConfig(merchantId)
    if (!state || !config) throw new Error(`Unknown merchant: ${merchantId}`)

    const bankrupt = isMerchantBankrupt(state, this.config)
    if (!bankrupt) {
      return {
        ok: false,
        message: `${state.displayName} is not bankrupt and does not need investment.`,
        merchantId,
        amount: 0,
        merchantCash: state.cash,
        reopened: state.open,
      }
    }

    const required = this.requiredInvestment(state)
    const injection = Math.max(required, Math.floor(amount ?? required))
    if (this.player.cash < injection) {
      return {
        ok: false,
        message: `You need ${injection.toFixed(2)} ${this.config.currency.symbol} but only have ${this.player.cash.toFixed(2)}.`,
        merchantId,
        amount: injection,
        merchantCash: state.cash,
        reopened: false,
      }
    }

    const before = this.snapshotFor(state, Object.keys(state.stock)[0] ?? '', 'sell')
    this.player.cash = roundMoney(this.config, this.player.cash - injection)
    state.cash = roundMoney(this.config, state.cash + injection)
    state.open = true
    this.sessionTime += 300

    this.recordEvent({
      type: 'merchant.investment',
      actor: { type: 'player', id: this.player.id, displayName: 'You' },
      price: injection,
      before,
      after: this.snapshotFor(state, Object.keys(state.stock)[0] ?? '', 'sell'),
      cause: 'investment',
      message: `You injected ${injection.toFixed(2)} ${this.config.currency.symbol} into ${state.displayName} and reopened the stall.`,
    })
    this.notify()

    return {
      ok: true,
      message: `${state.displayName} reopened with ${injection.toFixed(2)} ${this.config.currency.symbol}.`,
      merchantId,
      amount: injection,
      merchantCash: state.cash,
      reopened: true,
    }
  }

  async repair(toolItemId?: ItemId): Promise<RepairResult> {
    const itemId = toolItemId ?? this.player.equippedTool
    if (!itemId) {
      return {
        ok: false,
        message: 'No tool equipped.',
        toolItemId: null,
        cost: 0,
        durability: null,
      }
    }
    const item = this.config.items[itemId]
    if (!item?.tool) {
      return {
        ok: false,
        message: `${item?.displayName ?? itemId} is not a repairable tool.`,
        toolItemId: itemId,
        cost: 0,
        durability: null,
      }
    }

    const current = this.player.toolDurability[itemId] ?? item.tool.maxDurability
    if (current >= item.tool.maxDurability) {
      return {
        ok: false,
        message: `${item.displayName} is already in good condition.`,
        toolItemId: itemId,
        cost: 0,
        durability: current,
      }
    }

    const cost = roundMoney(
      this.config,
      (item.tool.maxDurability - current) *
        this.config.sinks.toolDurability.repairCostPerPoint,
    )
    if (this.player.cash < cost) {
      return {
        ok: false,
        message: `Repair costs ${cost.toFixed(2)} ${this.config.currency.symbol}; you cannot afford it.`,
        toolItemId: itemId,
        cost,
        durability: current,
      }
    }

    this.player.cash = roundMoney(this.config, this.player.cash - cost)
    this.player.toolDurability[itemId] = item.tool.maxDurability
    this.player.inventory[itemId] = Math.max(1, this.player.inventory[itemId] ?? 0)
    this.player.stats.repairs = roundMoney(this.config, this.player.stats.repairs + cost)
    this.sessionTime += 60

    const before = this.snapshotFor(Object.values(this.merchants)[0], itemId, 'sell')
    this.recordEvent({
      type: 'player.repair',
      actor: { type: 'player', id: this.player.id, displayName: 'You' },
      item: itemId,
      price: cost,
      before,
      after: { ...before, stock: null },
      cause: 'repair',
      message: `You repaired the ${item.displayName} for ${cost.toFixed(2)} ${this.config.currency.symbol}.`,
    })
    this.notify()

    return {
      ok: true,
      message: `${item.displayName} repaired to ${item.tool.maxDurability}.`,
      toolItemId: itemId,
      cost,
      durability: item.tool.maxDurability,
    }
  }

  async eat(itemId: ItemId): Promise<EatResult> {
    const item = this.config.items[itemId]
    const quantity = this.player.inventory[itemId] ?? 0
    if (!item || item.use.kind !== 'consumable' || !item.use.staminaRestore) {
      return { ok: false, message: 'That is not edible.', itemId, staminaRestored: 0 }
    }
    if (quantity <= 0) {
      return { ok: false, message: `No ${item.displayName} in your bag.`, itemId, staminaRestored: 0 }
    }
    if (this.player.stamina >= this.player.maxStamina) {
      return { ok: false, message: 'You are already at full stamina.', itemId, staminaRestored: 0 }
    }

    const restore = Math.min(
      item.use.staminaRestore,
      this.player.maxStamina - this.player.stamina,
    )
    this.player.stamina = Math.min(
      this.player.maxStamina,
      this.player.stamina + item.use.staminaRestore,
    )
    this.player.inventory[itemId] = quantity - 1
    this.sessionTime += 10
    this.notify()

    return {
      ok: true,
      message: `Ate ${item.displayName} · stamina +${restore}`,
      itemId,
      staminaRestored: restore,
    }
  }

  /* ------------------------------- fast-forward --------------------------- */

  async fastForwardDays(days: number): Promise<FastForwardState> {
    return this.fastForward.start(days)
  }

  /** Internal hook used by the fast-forward simulation. */
  async simulateDay(day: number, runId: number): Promise<FastForwardDay> {
    this.sessionDay = day
    this.sessionTime = (day - 1) * DAY_SECONDS + MARKET_OPENS_AT
    const rng = seededRandom(
      `${this.config.meta.seed}:fast-forward:${runId}:${day}`,
    )

    // Caravan delivers to the highest-cash merchant that sells the good.
    for (const good of this.config.caravan.goods) {
      const candidates = Object.values(this.merchants)
        .filter(merchant => this.merchantConfig(merchant.id)?.sells.includes(good.itemId))
        .sort((left, right) => right.cash - left.cash)
      const merchant = candidates[0]
      if (!merchant) continue
      const quantity =
        good.quantityRange.min +
        Math.floor(rng() * (good.quantityRange.max - good.quantityRange.min + 1))
      const unit = this.config.items[good.itemId]?.baseValue ?? 1
      const price = roundMoney(
        this.config,
        unit * this.config.caravan.priceBias.bid * (0.95 + rng() * 0.1),
      )
      const affordable = Math.max(
        0,
        Math.min(
          quantity,
          Math.floor(Math.max(0, merchant.cash - merchant.reserve) / Math.max(0.01, price)),
        ),
      )
      if (affordable <= 0) continue
      const total = roundMoney(this.config, affordable * price)
      merchant.stock[good.itemId] = (merchant.stock[good.itemId] ?? 0) + affordable
      merchant.cash = roundMoney(this.config, merchant.cash - total)
      this.player.stats.caravanArrivals += 1
      const before = this.snapshotFor(merchant, good.itemId, 'buy')
      this.recordEvent({
        type: 'caravan.arrival',
        actor: { type: 'caravan', id: 'north-road', displayName: 'North Road caravan' },
        item: good.itemId,
        quantity: affordable,
        price,
        before,
        after: this.snapshotFor(merchant, good.itemId, 'buy'),
        cause: 'caravan',
        message: `The caravan unloads ${affordable} ${this.config.items[good.itemId]?.displayName} at ${merchant.displayName}'s stall.`,
      })
    }

    // Merchants restock from their supply chains.
    for (const merchant of Object.values(this.merchants)) {
      const config = this.merchantConfig(merchant.id)
      if (!config) continue
      for (const [itemId, target] of Object.entries(config.targetStock)) {
        const desired = Math.floor(target * config.restockRate.targetRatio)
        const current = merchant.stock[itemId] ?? 0
        if (current >= desired) continue
        const units = Math.min(desired - current, config.restockRate.unitsPerTick)
        merchant.stock[itemId] = current + units
        merchant.demandEma[itemId] = Math.max(0, (merchant.demandEma[itemId] ?? 0) * 0.9)
      }
      merchant.lastRestockAt = this.sessionTime
    }

    // Bots trade. Each bot makes two trips; the mock keeps this deterministic.
    const botCount = this.config.bots.count
    const behavior = this.config.bots.behavior
    for (let bot = 0; bot < botCount; bot += 1) {
      const identity = characterForBotIndex(bot)
      for (let trip = 0; trip < 2; trip += 1) {
        const merchants = Object.values(this.merchants).filter(
          merchant => merchant.open && !isMerchantBankrupt(merchant, this.config),
        )
        if (merchants.length === 0) break
        const merchant = merchants[Math.floor(rng() * merchants.length)]
        const config = this.merchantConfig(merchant.id)
        if (!config) continue
        const side: TradeSide = rng() < behavior.buyProbability ? 'buy' : 'sell'
        const items = side === 'buy' ? config.sells : config.buys
        if (items.length === 0) continue
        const itemId = items[Math.floor(rng() * items.length)]
        const quantity = 1 + Math.floor(rng() * behavior.maxTradeQuantity)
        const result = quote(merchant, itemId, side, quantity, this.market(), this.config)
        if (!result.canTrade || result.fillQuantity <= 0) continue

        const fill = result.fillQuantity
        const total = result.total
        const before = this.snapshotFor(merchant, itemId, side)
        if (side === 'buy') {
          merchant.cash = roundMoney(this.config, merchant.cash + total)
          merchant.stock[itemId] = Math.max(0, (merchant.stock[itemId] ?? 0) - fill)
        } else {
          merchant.cash = roundMoney(this.config, merchant.cash - total)
          merchant.stock[itemId] = (merchant.stock[itemId] ?? 0) + fill
        }
        updateDemand(merchant, itemId, fill, this.config)
        merchant.lastTradeAt = this.sessionTime
        this.player.stats.tradeVolume += fill
        this.player.stats.tradeValue = roundMoney(this.config, this.player.stats.tradeValue + total)
        this.sessionTime += 30

        this.recordEvent({
          type: 'bot.trade',
          actor: { type: 'bot', id: botIdForIndex(bot), displayName: identity.displayName },
          item: itemId,
          quantity: fill,
          price: result.unitPrice,
          before,
          after: this.snapshotFor(merchant, itemId, side),
          reasons: result.reasons,
          cause: 'trade',
          message: `${identity.displayName} ${side === 'buy' ? 'bought' : 'sold'} ${fill} ${this.config.items[itemId]?.displayName} at ${merchant.displayName}.`,
        })
        this.applyBankruptcy(merchant)
      }
    }

    // Stall rent is the daily sink.
    for (const merchant of Object.values(this.merchants)) {
      const rent = this.config.sinks.stallRent.amountPerDay
      merchant.cash = roundMoney(this.config, merchant.cash - rent)
      this.player.stats.rent = roundMoney(this.config, this.player.stats.rent + rent)
      const itemId = Object.keys(merchant.stock)[0] ?? ''
      const before = this.snapshotFor(merchant, itemId, 'sell')
      this.recordEvent({
        type: 'sink.rent',
        actor: { type: 'merchant', id: merchant.id, displayName: merchant.displayName },
        price: rent,
        before,
        after: this.snapshotFor(merchant, itemId, 'sell'),
        cause: 'rent',
        message: `${merchant.displayName} pays ${rent.toFixed(2)} ${this.config.currency.symbol} stall rent.`,
      })
      this.applyBankruptcy(merchant)
    }

    // A guild investor occasionally reopens one stall, which keeps the weekly
    // story moving even when the player does not invest.
    const bankrupt = Object.values(this.merchants).filter(
      merchant => isMerchantBankrupt(merchant, this.config),
    )
    if (bankrupt.length > 0 && rng() < 0.5) {
      const target = bankrupt[Math.floor(rng() * bankrupt.length)]
      const injection = this.requiredInvestment(target)
      const before = this.snapshotFor(target, Object.keys(target.stock)[0] ?? '', 'sell')
      target.cash = roundMoney(this.config, target.cash + injection)
      target.open = true
      this.recordEvent({
        type: 'merchant.investment',
        actor: { type: 'merchant', id: 'guild', displayName: 'Merchants Guild' },
        price: injection,
        before,
        after: this.snapshotFor(target, Object.keys(target.stock)[0] ?? '', 'sell'),
        cause: 'investment',
        message: `The Merchants Guild injects ${injection.toFixed(2)} ${this.config.currency.symbol} to reopen ${target.displayName}.`,
      })
    }

    this.notify()

    const open = Object.values(this.merchants).filter(
      merchant => merchant.open && !isMerchantBankrupt(merchant, this.config),
    ).length
    const bankruptNow = Object.values(this.merchants).filter(merchant =>
      isMerchantBankrupt(merchant, this.config),
    ).length

    return {
      day,
      merchantsOpen: open,
      bankruptcies: bankruptNow,
      tradeVolume: this.player.stats.tradeVolume,
      headline:
        bankruptNow > 0
          ? `Day ${day}: ${bankruptNow} stall${bankruptNow === 1 ? '' : 's'} closed below reserve`
          : `Day ${day}: all ${open} stalls trading`,
    }
  }

  /* --------------------------------- recap -------------------------------- */

  async getRecap(): Promise<SessionRecap> {
    if (this.recapCache) return this.recapCache
    const recap = this.buildRecap()
    this.recapCache = recap
    return recap
  }

  private buildRecap(): SessionRecap {
    const bankruptcies = this.events
      .filter(event => event.type === 'merchant.bankrupt')
      .map(event => event.actor.displayName ?? event.actor.id)
    const investments = this.events
      .filter(event => event.type === 'merchant.investment')
      .map(event => ({
        merchantId: event.actor.id,
        displayName: event.actor.displayName ?? event.actor.id,
        amount: event.price ?? 0,
      }))

    const playerTrades = this.events.filter(
      event => event.type === 'trade.buy' || event.type === 'trade.sell',
    )
    const buyCount = playerTrades.filter(event => event.type === 'trade.buy').length
    const sellCount = playerTrades.filter(event => event.type === 'trade.sell').length
    const volume = this.events.reduce((sum, event) => sum + (event.quantity ?? 0), 0)
    const value = this.events.reduce(
      (sum, event) => sum + (event.price ?? 0) * (event.quantity ?? 0),
      0,
    )

    const topMovers = this.topMovers()
    const health = this.townHealth()
    const open = Object.values(this.merchants).filter(
      merchant => merchant.open && !isMerchantBankrupt(merchant, this.config),
    ).length
    const total = Object.values(this.merchants).length

    const leader = topMovers[0]
    const headline =
      health === 'critical'
        ? 'Market square in crisis as stalls close'
        : health === 'strained'
          ? 'Trading thins as cash runs short'
          : leader && leader.changePct > 8
            ? `${leader.displayName} leads a firm market`
            : health === 'thriving'
              ? 'Ironblock holds a steady market'
              : 'Stalls steady after a mixed week'

    const standfirst =
      `${playerTrades.length} player trades moved ${volume} units for ` +
      `${value.toFixed(2)} ${this.config.currency.symbol}. ` +
      `${open}/${total} stalls are open, ${bankruptcies.length} closed below reserve and ` +
      `${investments.length} investment${investments.length === 1 ? '' : 's'} reopened a counter. ` +
      `The caravan made ${this.player.stats.caravanArrivals} deliveries.`

    return {
      headline,
      standfirst,
      generatedAtDay: this.sessionDay,
      topMovers,
      trades: {
        count: playerTrades.length,
        buyCount,
        sellCount,
        volume,
        value: Math.round(value * 100) / 100,
      },
      bankruptcies,
      investments,
      caravan: {
        arrivals: this.player.stats.caravanArrivals,
        note:
          this.player.stats.caravanArrivals > 0
            ? 'North Road caravans restocked ore, grain, timber, wool and bread.'
            : 'No caravan reached the square this session.',
      },
      sinks: {
        rent: this.player.stats.rent,
        tax: this.player.stats.tax,
        repairs: this.player.stats.repairs,
        total:
          Math.round(
            (this.player.stats.rent + this.player.stats.tax + this.player.stats.repairs) * 100,
          ) / 100,
      },
      merchants: { open, total, health },
    }
  }

  private topMovers(): RecapTopMover[] {
    const movers: RecapTopMover[] = []
    for (const item of Object.values(this.config.items)) {
      const asks = Object.values(this.merchants)
        .filter(merchant => this.merchantConfig(merchant.id)?.sells.includes(item.id))
        .map(merchant => this.quoteUnit(merchant, item.id, 'buy'))
        .filter((value): value is number => value !== null && value > 0)
      if (asks.length === 0) continue
      const average = asks.reduce((sum, value) => sum + value, 0) / asks.length
      const changePct = ((average - item.baseValue) / Math.max(0.01, item.baseValue)) * 100
      movers.push({
        itemId: item.id,
        displayName: item.displayName,
        changePct: Math.round(changePct * 10) / 10,
        from: item.baseValue,
        to: Math.round(average * 100) / 100,
      })
    }
    return movers
      .filter(mover => Math.abs(mover.changePct) >= 0.5)
      .sort((left, right) => Math.abs(right.changePct) - Math.abs(left.changePct))
      .slice(0, 4)
  }

  /* -------------------------- read-only test access ----------------------- */

  /** Exposed for tests and the integration agent; not used by the UI. */
  get state(): Readonly<MarketState> {
    return this.market()
  }
}

function updateDemand(
  merchant: MerchantState,
  itemId: ItemId,
  quantity: number,
  config: EconomyConfig,
): void {
  const alpha = config.pricing.demand.emaAlpha
  const current = merchant.demandEma[itemId] ?? 0
  merchant.demandEma[itemId] = current * (1 - alpha) + quantity * alpha
}

const BLOCKED_LABELS: Record<string, string> = {
  merchant_closed: 'The stall is closed.',
  merchant_below_reserve: 'The merchant is below reserve and cannot trade.',
  quantity_must_be_positive: 'Choose a quantity first.',
  out_of_stock: 'Out of stock.',
  merchant_cash_exhausted: 'The merchant cannot afford this purchase.',
  insufficient_player_cash: 'You do not have enough cash.',
  insufficient_player_inventory: 'You do not have that item.',
  carry_capacity_exceeded: 'You cannot carry that much.',
  quantity_exceeds_fill_limit: 'Quantity exceeds the fill limit.',
  fill_unavailable: 'This trade cannot be filled right now.',
  unknown_item: 'Unknown item.',
  unknown_merchant: 'Unknown merchant.',
  unknown_personality: 'The merchant has no pricing personality.',
  merchant_does_not_sell_item: 'This merchant does not sell that item.',
  merchant_does_not_buy_item: 'This merchant does not buy that item.',
}

export function blockedMessage(quoteResult: Quote, items: EconomyConfig['items']): string {
  if (quoteResult.blockedReason) {
    const base = BLOCKED_LABELS[quoteResult.blockedReason] ?? 'This trade is unavailable.'
    return `${base} ${describeQuoteLimits(quoteResult, items)}`.trim()
  }
  return 'This trade is unavailable.'
}

function describeQuoteLimits(quoteResult: Quote, items: EconomyConfig['items']): string {
  const constraints = quoteResult.constraints
  const parts: string[] = []
  if (constraints.maxByStock === 0 && quoteResult.side === 'buy') {
    parts.push('The stall has none left.')
  }
  if (constraints.maxByPlayerCash === 0 && quoteResult.side === 'buy') {
    const name = items[quoteResult.itemId]?.displayName ?? quoteResult.itemId
    parts.push(`You cannot afford one ${name}.`)
  }
  if (constraints.maxByCarry === 0 && quoteResult.side === 'buy') {
    parts.push('Your bag is full.')
  }
  if (constraints.maxByMerchantCash === 0 && quoteResult.side === 'sell') {
    parts.push('The merchant is out of cash.')
  }
  if (constraints.maxByPlayerInventory === 0 && quoteResult.side === 'sell') {
    parts.push('You have none to sell.')
  }
  return parts.join(' ')
}

/* -------------------------------------------------------------------------- */
/* Fast-forward client                                                         */
/* -------------------------------------------------------------------------- */

export class MockFastForwardClient implements FastForwardClient {
  private state: FastForwardState = {
    status: 'idle',
    day: 0,
    totalDays: 0,
    progress: 0,
    days: [],
    events: [],
    recap: null,
    message: 'Ready to simulate a week of town trade.',
  }
  private readonly listeners = new Set<(state: FastForwardState) => void>()
  private paused = false
  private runId = 0
  private running = false

  constructor(
    private readonly owner: MockEconomyClient,
    private readonly paceMs: number,
  ) {}

  onChange(listener: (state: FastForwardState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getState(): FastForwardState {
    return this.snapshotState()
  }

  private snapshotState(): FastForwardState {
    return {
      ...this.state,
      days: [...this.state.days],
      events: [...this.state.events],
    }
  }

  private notify(): void {
    const snapshot = this.snapshotState()
    for (const listener of this.listeners) listener(snapshot)
  }

  async start(days?: number): Promise<FastForwardState> {
    const totalDays = Math.min(
      this.owner.config.fastForward.maxDays,
      Math.max(1, Math.floor(days ?? this.owner.config.fastForward.days)),
    )
    if (this.running) this.stop()
    this.runId += 1
    this.paused = false
    this.running = true
    this.state = {
      status: 'running',
      day: 0,
      totalDays,
      progress: 0,
      days: [],
      events: [],
      recap: this.state.recap,
      message: `Simulating ${totalDays} days of market trade…`,
    }
    this.notify()

    await this.run(totalDays, this.runId)
    return this.getState()
  }

  private async run(totalDays: number, runId: number): Promise<void> {
    for (let day = 1; day <= totalDays; day += 1) {
      await this.waitWhilePaused(runId)
      if (runId !== this.runId) return
      const dayState = await this.owner.simulateDay(day, runId)
      if (runId !== this.runId) return

      const newEvents = await this.owner.getEvents()
      const annotated: FastForwardEvent[] = newEvents
        .filter(event => event.type !== 'player.gather' && event.type !== 'player.craft')
        .slice(-120)
        .map(event => ({
          event,
          day,
          annotation: annotateEvent(event),
        }))

      this.state = {
        ...this.state,
        day,
        days: [...this.state.days, dayState],
        events: annotated,
        progress: day / totalDays,
        message: dayState.headline,
      }
      this.notify()
      if (this.paceMs > 0) await delay(this.paceMs)
    }

    if (runId !== this.runId) return
    this.running = false
    const recap = await this.owner.getRecap()
    this.state = {
      ...this.state,
      status: 'done',
      progress: 1,
      recap,
      message: `Week complete — ${recap.headline}.`,
    }
    this.notify()
  }

  pause(): void {
    if (!this.running || this.state.status !== 'running') return
    this.paused = true
    this.state = { ...this.state, status: 'paused', message: 'Paused. Step a day or resume.' }
    this.notify()
  }

  async resume(): Promise<FastForwardState> {
    if (this.state.status === 'paused') {
      this.paused = false
      this.state = { ...this.state, status: 'running', message: 'Resuming…' }
      this.notify()
    }
    return this.getState()
  }

  async step(): Promise<FastForwardState> {
    if (this.running && this.state.status === 'running') this.pause()
    const nextDay = Math.min(this.state.day + 1, this.state.totalDays)
    if (this.state.totalDays === 0) {
      this.state = { ...this.state, totalDays: this.owner.config.fastForward.days }
    }
    if (nextDay <= this.state.day) {
      return this.getState()
    }

    const dayState = await this.owner.simulateDay(nextDay, this.runId + 1)
    this.runId += 1
    this.running = false
    this.paused = true
    const newEvents = await this.owner.getEvents()
    const annotated: FastForwardEvent[] = newEvents
      .filter(event => event.type !== 'player.gather' && event.type !== 'player.craft')
      .slice(-120)
      .map(event => ({ event, day: nextDay, annotation: annotateEvent(event) }))

    this.state = {
      ...this.state,
      status: 'paused',
      day: nextDay,
      days: [...this.state.days, dayState],
      events: annotated,
      progress: nextDay / Math.max(1, this.state.totalDays),
      recap: nextDay >= this.state.totalDays ? await this.owner.getRecap() : this.state.recap,
      message: dayState.headline,
    }
    this.notify()
    return this.getState()
  }

  stop(): void {
    this.runId += 1
    this.running = false
    this.paused = false
  }

  private async waitWhilePaused(runId: number): Promise<void> {
    while (this.paused && runId === this.runId) {
      await delay(40)
    }
  }
}

function annotateEvent(event: MarketEvent): string {
  switch (event.type) {
    case 'trade.buy':
    case 'trade.sell':
      return `${event.actor.displayName ?? event.actor.id} traded ${event.item ?? 'goods'} at ${(event.price ?? 0).toFixed(2)}`
    case 'bot.trade':
      return `Bot activity: ${event.quantity ?? 0} units changed hands`
    case 'merchant.bankrupt':
      return 'Stall closed below reserve'
    case 'merchant.investment':
      return 'Cash injection reopened the stall'
    case 'caravan.arrival':
      return 'Caravan restocked the square'
    case 'sink.rent':
      return `Rent paid: ${(event.price ?? 0).toFixed(2)}`
    case 'sink.tax':
      return `Sales tax: ${(event.price ?? 0).toFixed(2)}`
    default:
      return event.message
  }
}

const delay = (ms: number): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, ms)
  })
