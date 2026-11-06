import {
  botIdForIndex,
  characterForBotId,
  characterForBotIndex,
} from '../../config/characters'
import { createMarketEvent } from '../market-events'
import type { CreateMarketEventInput } from '../market-events'
import { isMerchantBankrupt, quote } from '../pricing'
import { stableCompare, stableHash64 } from '../stable-hash'
import type {
  EconomyConfig,
  ItemId,
  MarketEventSnapshot,
  MarketState,
  MerchantConfig,
  MerchantId,
  MerchantState,
  PlayerEconomyState,
  Quote,
  ResourceId,
  TradeSide,
} from '../types'
import { sampleFastForwardEvents } from './fast-forward'
import { fingerprintConfig } from './fingerprint'
import { DeterministicRng } from './rng'
import {
  ECONOMY_ENGINE_SCHEMA_VERSION,
  type BotRuntimeState,
  type CraftActionData,
  type DailyAccumulator,
  type DaySummary,
  type EconomyActionResult,
  type EconomyActionError,
  type EconomyEngineOptions,
  type EconomyFastForwardResult,
  type EconomyStats,
  type EconomyWorldState,
  type FastForwardPriceSnapshot,
  type FastForwardSeriesPoint,
  type GatherActionData,
  type InvestActionData,
  type InvestmentRecord,
  type MerchantRuntimeState,
  type OrderActionData,
  type OrderState,
  type PlayerRuntimeState,
  type PriceMover,
  type RepairActionData,
  type SequencedMarketEvent,
  type SpectatorMerchantSnapshot,
  type SpectatorSnapshot,
  type TickActionData,
  type TradeActionData,
  type WithdrawActionData,
} from './types'

const EMPTY_SNAPSHOT = (): MarketEventSnapshot => ({
  stock: null,
  cash: null,
  bid: null,
  ask: null,
})

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const round = (value: number, decimals: number, mode: EconomyConfig['pricing']['rounding']['mode']): number => {
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

const emptyTradeTotals = () => ({ buys: 0, sells: 0, volume: 0, value: 0 })
const emptySinkTotals = () => ({ rent: 0, salesTax: 0, repairs: 0, shocks: 0, total: 0 })
const emptyCaravanTotals = () => ({
  arrivals: 0,
  unitsSold: 0,
  unitsBought: 0,
  cashIn: 0,
  cashOut: 0,
})
const emptyOrderTotals = () => ({
  created: 0,
  accepted: 0,
  fulfilled: 0,
  units: 0,
  payouts: 0,
})

const emptyStats = (): EconomyStats => ({
  totalBuys: 0,
  totalSells: 0,
  tradeVolume: 0,
  tradeValue: 0,
  botTrades: 0,
  botGathers: 0,
  botItemsGathered: 0,
  caravanArrivals: 0,
  caravanUnitsSold: 0,
  caravanUnitsBought: 0,
  caravanCashIn: 0,
  caravanCashOut: 0,
  bankruptcies: 0,
  investments: 0,
  investmentAmount: 0,
  investmentDistributions: 0,
  gathers: 0,
  itemsGathered: 0,
  crafts: 0,
  itemsCrafted: 0,
  itemsConsumed: 0,
  repairs: 0,
  toolWear: 0,
  restocks: 0,
  ordersCreated: 0,
  ordersAccepted: 0,
  ordersFulfilled: 0,
  orderUnits: 0,
  orderPayouts: 0,
  sinks: emptySinkTotals(),
  sources: { merchantRecovery: 0, orderPayouts: 0 },
})

const totalStock = (merchant: MerchantRuntimeState): number =>
  Object.values(merchant.stock).reduce((sum, quantity) => sum + Math.max(0, quantity), 0)

const totalMerchantCash = (state: EconomyWorldState): number =>
  Object.values(state.merchants).reduce((sum, merchant) => sum + merchant.cash, 0)

const totalPlayerCash = (state: EconomyWorldState): number =>
  Object.values(state.players).reduce((sum, player) => sum + player.cash, 0)

const inventoryWeight = (
  inventory: Record<string, number>,
  config: EconomyConfig,
): number =>
  Object.entries(inventory).reduce((total, [itemId, quantity]) => {
    const item = config.items[itemId]
    if (!item) return total
    return total + Math.max(0, quantity) * item.weight
  }, 0)

const toInteger = (value: unknown): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  if (!Number.isInteger(value)) return null
  return value
}

export function isStateCompatible(config: EconomyConfig, state: EconomyWorldState): boolean {
  const fingerprint = fingerprintConfig(config)
  return (
    state.engineSchemaVersion === ECONOMY_ENGINE_SCHEMA_VERSION &&
    state.configHash === fingerprint.hash &&
    state.configVersion === fingerprint.version
  )
}

/**
 * Deterministic, Node-free economy simulation.
 *
 * All randomness comes from a persisted Mulberry32 stream seeded by the config
 * seed. Actions are synchronous and atomic: they either apply fully and return
 * the events they created, or reject without changing state.
 */
export class EconomyEngine {
  readonly config: EconomyConfig
  readonly fingerprint: ReturnType<typeof fingerprintConfig>

  private state: EconomyWorldState
  private rng: DeterministicRng

  constructor(config: EconomyConfig, options: EconomyEngineOptions = {}) {
    this.config = config
    this.fingerprint = fingerprintConfig(config)

    if (options.state) {
      if (!isStateCompatible(config, options.state)) {
        throw new Error(
          'Persisted economy state does not match this configuration (config hash or engine schema changed)',
        )
      }
      this.state = cloneJson(options.state)
      this.applyBotIdentities()
      this.rng = new DeterministicRng(this.state.rngSeed, this.state.rngState)
    } else {
      this.rng = new DeterministicRng(config.meta.seed)
      this.state = this.createWorldState()
      this.state.daily = this.buildDailyAccumulator(1, 0)
      this.rng = new DeterministicRng(this.state.rngSeed, this.state.rngState)
      this.emit(
        {
          time: this.state.time,
          type: 'system.configuration',
          actor: { type: 'system', id: 'economy', displayName: 'Economy' },
          item: null,
          quantity: null,
          price: null,
          before: {
            stock: totalStockOf(this.state),
            cash: totalMerchantCash(this.state),
            bid: null,
            ask: null,
          },
          after: {
            stock: totalStockOf(this.state),
            cash: totalMerchantCash(this.state),
            bid: null,
            ask: null,
          },
          reasons: [
            {
              code: 'config',
              label: 'Configuration fingerprint',
              value: this.state.sequence,
              effect: 0,
              detail: this.fingerprint.hash,
            },
          ],
          cause: 'configuration',
          causeId: 'engine-init',
          message: `Economy initialised with ${Object.keys(this.state.merchants).length} merchants and ${Object.keys(config.items).length} items from seed "${config.meta.seed}".`,
        },
      )
      if (options.seedInitialOrders !== false) this.generateOrders()
    }

    // Defensive repair for older/edited snapshots whose daily cursor drifted.
    if (this.state.daily.day !== this.state.day) {
      this.state.daily = this.buildDailyAccumulator(this.state.day, (this.state.day - 1) * 86400)
    }
    if (!this.state.scenario) {
      this.state.scenario = { appliedShockIds: [], rescues: [] }
    }
  }

  /* ---------------------------------------------------------------------- */
  /* State construction                                                     */
  /* ---------------------------------------------------------------------- */

  /**
   * Rebind persisted bots to the current townsfolk roster. Names are cosmetic:
   * ids, cash, inventory and schedules are left untouched, so older saves keep
   * their economy while picking up roster renames.
   */
  private applyBotIdentities(): void {
    this.state.bots = this.state.bots.map((bot, index) => {
      const identity = characterForBotId(bot.id) ?? characterForBotIndex(index)
      return { ...bot, displayName: identity.displayName }
    })
  }

  private createWorldState(): EconomyWorldState {
    const config = this.config
    const merchantIds = Object.keys(config.merchants).sort(stableCompare)
    const merchants: Record<MerchantId, MerchantRuntimeState> = {}

    for (const merchantId of merchantIds) {
      const merchantConfig = config.merchants[merchantId]
      const stock: Record<ItemId, number> = {}
      const demandEma: Record<ItemId, number> = {}
      for (const itemId of Object.keys(merchantConfig.targetStock).sort(stableCompare)) {
        stock[itemId] = Math.max(
          0,
          Math.floor(merchantConfig.targetStock[itemId] * merchantConfig.restockRate.targetRatio),
        )
        demandEma[itemId] = 0
      }
      merchants[merchantId] = {
        id: merchantConfig.id,
        displayName: merchantConfig.displayName,
        personality: merchantConfig.personality,
        cash: merchantConfig.cash,
        reserve: merchantConfig.reserve,
        stock,
        targetStock: { ...merchantConfig.targetStock },
        demandEma,
        open: true,
        bankrupt: false,
        bankruptAt: null,
        reopenedAt: null,
        lastRestockAt: 0,
        lastTradeAt: undefined,
        cashAtDayStart: merchantConfig.cash,
      }
    }

    const botItems = Array.from(
      new Set(
        Object.values(config.resources.nodes)
          .map(node => node.itemId)
          .filter(itemId => Boolean(config.items[itemId])),
      ),
    ).sort(stableCompare)

    const bots: BotRuntimeState[] = []
    const startingInventory = config.bots.startingInventory
    for (let index = 0; index < config.bots.count; index += 1) {
      const inventory: Record<ItemId, number> = {}
      for (const itemId of botItems) {
        if (this.rng.chance(startingInventory.chance)) {
          inventory[itemId] = this.rng.int(
            startingInventory.quantityRange.min,
            startingInventory.quantityRange.max,
          )
        }
      }
      if (Object.keys(inventory).length === 0 && botItems.length > 0) {
        inventory[botItems[0]] = this.rng.int(
          startingInventory.fallbackQuantityRange.min,
          startingInventory.fallbackQuantityRange.max,
        )
      }
      const cash = roundMoney(
        this.rng.int(config.bots.startingCash.min, config.bots.startingCash.max),
        config,
      )
      bots.push({
        id: botIdForIndex(index),
        displayName: characterForBotIndex(index).displayName,
        cash,
        inventory,
        stamina: config.player.stamina.max,
        maxStamina: config.player.stamina.max,
        nextActionAt: this.rng.int(1, Math.max(1, config.bots.behavior.cadenceSeconds)),
        lastActionAt: null,
        trades: 0,
      })
    }

    const resources: EconomyWorldState['resources'] = {}
    for (const resourceId of Object.keys(config.resources.nodes).sort(stableCompare)) {
      const node = config.resources.nodes[resourceId]
      resources[resourceId] = {
        id: resourceId,
        available: node.nodeCount,
        nextRespawnAt: null,
        lastGatherAt: null,
      }
    }

    return {
      engineSchemaVersion: ECONOMY_ENGINE_SCHEMA_VERSION,
      configHash: this.fingerprint.hash,
      configVersion: this.fingerprint.version,
      time: 0,
      day: 1,
      seed: config.meta.seed,
      sequence: 0,
      events: [],
      players: {},
      merchants,
      bots,
      resources,
      caravan: {
        nextArrivalAt: config.caravan.intervalSeconds,
        lastArrivalAt: null,
        arrivals: 0,
      },
      investments: [],
      orders: [],
      scenario: {
        appliedShockIds: [],
        rescues: [],
      },
      daily: {
        day: 1,
        startedAt: 0,
        merchantCashStart: {},
        playerCashStart: {},
        priceSnapshot: {},
        trades: emptyTradeTotals(),
        botTrades: 0,
        bankruptcies: [],
        investments: { count: 0, amount: 0 },
        caravan: emptyCaravanTotals(),
        sinks: emptySinkTotals(),
        orders: emptyOrderTotals(),
      },
      summaries: [],
      stats: emptyStats(),
      rngSeed: config.meta.seed,
      rngState: this.rng.state,
      rngDraws: 0,
      fastForwardRuns: 0,
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Public read API                                                        */
  /* ---------------------------------------------------------------------- */

  get time(): number {
    return this.state.time
  }

  get day(): number {
    return this.state.day
  }

  get sequence(): number {
    return this.state.sequence
  }

  get firstRetainedSequence(): number {
    return this.state.events[0]?.sequence ?? this.state.sequence + 1
  }

  hasPlayer(playerId: string): boolean {
    return Boolean(this.state.players[playerId])
  }

  getPlayer(playerId: string): PlayerRuntimeState | null {
    return this.state.players[playerId]
      ? cloneJson(this.state.players[playerId])
      : null
  }

  snapshot(): EconomyWorldState {
    return cloneJson(this.state)
  }

  eventsSince(sequence: number): SequencedMarketEvent[] {
    const safe = Number.isFinite(sequence) ? Math.floor(sequence) : 0
    return cloneJson(this.state.events.filter(event => event.sequence > safe))
  }

  /** Read-only quote preview using the same constraints as a real trade. */
  preview(
    playerId: string,
    merchantId: string,
    itemId: string,
    side: TradeSide,
    quantity: number,
  ): Quote | null {
    const player = this.state.players[playerId]
    const merchant = this.state.merchants[merchantId]
    const item = this.config.items[itemId]
    if (!player || !merchant || !item) return null
    if (side !== 'buy' && side !== 'sell') return null
    return quote(
      merchant,
      item,
      side,
      quantity,
      this.marketFor(player),
      this.config,
    )
  }

  spectatorSnapshot(): SpectatorSnapshot {
    const askPrices: Record<string, Record<ItemId, number>> = {}
    const bidPrices: Record<string, Record<ItemId, number>> = {}
    const market = this.marketFor()
    for (const merchant of Object.values(this.state.merchants)) {
      const merchantConfig = this.config.merchants[merchant.id]
      askPrices[merchant.id] = {}
      bidPrices[merchant.id] = {}
      for (const itemId of [...merchantConfig.sells].sort(stableCompare)) {
        askPrices[merchant.id][itemId] = quote(
          merchant,
          itemId,
          'buy',
          1,
          market,
          this.config,
        ).unitPrice
      }
      for (const itemId of [...merchantConfig.buys].sort(stableCompare)) {
        bidPrices[merchant.id][itemId] = quote(
          merchant,
          itemId,
          'sell',
          1,
          market,
          this.config,
        ).unitPrice
      }
    }

    const merchants: SpectatorMerchantSnapshot[] = Object.values(this.state.merchants).map(
      merchant => ({
        id: merchant.id,
        displayName: merchant.displayName,
        personality: merchant.personality,
        open: merchant.open,
        bankrupt: merchant.bankrupt,
        cash: merchant.cash,
        reserve: merchant.reserve,
        stock: cloneJson(merchant.stock),
        targetStock: cloneJson(merchant.targetStock),
        demandEma: cloneJson(merchant.demandEma),
        askPrices: askPrices[merchant.id],
        bidPrices: bidPrices[merchant.id],
        bankruptAt: merchant.bankruptAt,
      }),
    )

    const sampleSize = Math.max(1, Math.floor(this.config.reporting.eventSampleSize))
    return {
      engineSchemaVersion: this.state.engineSchemaVersion,
      configHash: this.state.configHash,
      configVersion: this.state.configVersion,
      seed: this.state.seed,
      time: this.state.time,
      day: this.state.day,
      sequence: this.state.sequence,
      merchants,
      players: cloneJson(this.state.players),
      bots: {
        count: this.state.bots.length,
        totalCash: this.state.bots.reduce((sum, bot) => sum + bot.cash, 0),
        trades: this.state.stats.botTrades,
      },
      resources: cloneJson(this.state.resources),
      caravan: cloneJson(this.state.caravan),
      investments: cloneJson(this.state.investments),
      orders: cloneJson(this.state.orders),
      scenario: cloneJson(this.state.scenario),
      stats: cloneJson(this.state.stats),
      daily: cloneJson(this.state.daily),
      summaries: cloneJson(this.state.summaries),
      recentEvents: cloneJson(this.state.events.slice(-sampleSize)),
      firstRetainedSequence: this.firstRetainedSequence,
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Player lifecycle                                                       */
  /* ---------------------------------------------------------------------- */

  createPlayer(playerId: string, displayName?: string): EconomyActionResult<PlayerRuntimeState> {
    const action = 'createPlayer'
    if (typeof playerId !== 'string' || playerId.trim().length === 0) {
      return this.failure(action, 'invalid_player_id', 'Player id must be a non-empty string')
    }
    if (this.state.players[playerId]) {
      return this.failure(action, 'player_exists', `Player "${playerId}" already exists`, playerId)
    }

    const toolId = this.config.player.startingTool
    const tool = this.config.items[toolId]
    const toolDurability: Record<ItemId, number> = {}
    if (tool?.tool) toolDurability[toolId] = tool.tool.maxDurability

    const player: PlayerRuntimeState = {
      id: playerId,
      displayName: displayName ?? playerId,
      cash: this.config.player.startingCash,
      inventory: { ...this.config.player.startingInventory },
      stamina: this.config.player.stamina.max,
      maxStamina: this.config.player.stamina.max,
      equippedTool: toolId,
      toolDurability,
      joinedAt: this.state.time,
    }
    this.state.players[playerId] = player

    const events: SequencedMarketEvent[] = []
    this.emit(
      {
        time: this.state.time,
        type: 'player.join',
        actor: { type: 'player', id: playerId, displayName: player.displayName },
        item: null,
        quantity: null,
        price: null,
        before: EMPTY_SNAPSHOT(),
        after: { stock: null, cash: player.cash, bid: null, ask: null },
        reasons: [
          {
            code: 'starting-cash',
            label: 'Starting cash',
            value: player.cash,
            effect: 0,
            detail: this.config.currency.code,
          },
        ],
        cause: 'configuration',
        causeId: `player-join-${this.state.sequence + 1}`,
        message: `${player.displayName} joined the town with ${this.money(player.cash)}.`,
      },
      events,
    )

    return this.success(action, events, cloneJson(player), playerId)
  }

  /* ---------------------------------------------------------------------- */
  /* Actions                                                                */
  /* ---------------------------------------------------------------------- */

  gather(
    playerId: string,
    resourceId: ResourceId,
    duration?: number,
  ): EconomyActionResult<GatherActionData> {
    const action = 'gather'
    const player = this.state.players[playerId]
    if (!player) return this.failure(action, 'unknown_player', `Unknown player "${playerId}"`, playerId)
    const nodeConfig = this.config.resources.nodes[resourceId]
    const node = this.state.resources[resourceId]
    if (!nodeConfig || !node) {
      return this.failure(action, 'unknown_resource', `Unknown resource "${resourceId}"`, playerId)
    }
    const requestedDuration = duration ?? this.config.player.gatherDurationSeconds
    if (
      !Number.isFinite(requestedDuration) ||
      requestedDuration < this.config.player.gatherDurationSeconds
    ) {
      return this.failure(
        action,
        'gather_duration_invalid',
        `Gather duration must be at least ${this.config.player.gatherDurationSeconds}s`,
        playerId,
      )
    }
    const cycles = Math.max(
      1,
      Math.floor(requestedDuration / this.config.player.gatherDurationSeconds),
    )
    if (node.available < cycles) {
      return this.failure(
        action,
        'resource_depleted',
        `${nodeConfig.displayName} has ${node.available} available node(s), ${cycles} required`,
        playerId,
      )
    }

    const staminaCost = nodeConfig.staminaCost * cycles
    if (player.stamina < staminaCost) {
      return this.failure(
        action,
        'insufficient_stamina',
        `Gather needs ${staminaCost} stamina; ${player.stamina} available`,
        playerId,
      )
    }

    let toolDurability: number | null = null
    let toolWear: { id: ItemId; current: number; next: number } | null = null
    if (nodeConfig.requiredTool) {
      const equipped = player.equippedTool ? this.config.items[player.equippedTool] : undefined
      if (!equipped?.tool || equipped.tool.kind !== nodeConfig.requiredTool) {
        return this.failure(
          action,
          'required_tool_missing',
          `${nodeConfig.displayName} requires a ${nodeConfig.requiredTool}`,
          playerId,
        )
      }
      const current = player.toolDurability?.[equipped.id] ?? equipped.tool.maxDurability
      if (current <= 0) {
        return this.failure(action, 'tool_broken', `${equipped.displayName} needs repair`, playerId)
      }
      const next = Math.max(
        0,
        current - this.config.sinks.toolDurability.lossPerGather * cycles,
      )
      toolDurability = next
      toolWear = { id: equipped.id, current, next }
    }

    const item = this.config.items[nodeConfig.itemId]
    if (!item) {
      return this.failure(action, 'unknown_item', `Resource references unknown item "${nodeConfig.itemId}"`, playerId)
    }

    // Roll the yield on a temporary stream so a rejected gather cannot consume
    // randomness or wear the tool. The state is committed only after validation.
    const rng = new DeterministicRng(this.state.rngSeed, this.rng.state)
    let quantity = 0
    for (let cycle = 0; cycle < cycles; cycle += 1) {
      quantity += rng.int(nodeConfig.yieldRange.min, nodeConfig.yieldRange.max)
    }
    const free = this.carryFree(player)
    if (quantity * item.weight > free + 1e-9) {
      return this.failure(
        action,
        'carry_capacity_exceeded',
        `Yield of ${quantity} ${item.displayName} needs ${(quantity * item.weight).toFixed(2)} carry; ${free.toFixed(2)} free`,
        playerId,
      )
    }

    if (toolWear) {
      player.toolDurability = {
        ...(player.toolDurability ?? {}),
        [toolWear.id]: toolWear.next,
      }
      this.state.stats.toolWear += toolWear.current - toolWear.next
    }
    this.rng.state = rng.state
    this.state.rngState = rng.state
    this.state.rngDraws += cycles

    const beforeNodes = node.available
    node.available -= cycles
    node.lastGatherAt = this.state.time
    if (node.available === 0) {
      node.nextRespawnAt = roundSeconds(this.state.time + nodeConfig.respawnSeconds)
    }
    player.inventory[nodeConfig.itemId] = (player.inventory[nodeConfig.itemId] ?? 0) + quantity
    player.stamina = Math.max(0, player.stamina - staminaCost)
    this.state.stats.gathers += 1
    this.state.stats.itemsGathered += quantity

    const events: SequencedMarketEvent[] = []
    this.emit(
      {
        time: this.state.time,
        type: 'player.gather',
        actor: { type: 'player', id: player.id, displayName: player.displayName },
        item: nodeConfig.itemId,
        quantity,
        price: null,
        before: { stock: beforeNodes, cash: player.cash, bid: null, ask: null },
        after: { stock: node.available, cash: player.cash, bid: null, ask: null },
        reasons: [
          {
            code: 'stamina',
            label: 'Stamina spent',
            value: staminaCost,
            effect: 0,
            detail: `${cycles} gather cycle(s)`,
          },
          {
            code: 'yield',
            label: 'Resource yield',
            value: quantity,
            effect: 0,
            detail: `${beforeNodes} -> ${node.available} nodes`,
          },
        ],
        cause: 'gather',
        causeId: `gather-${this.state.sequence + 1}`,
        message: `${player.displayName} gathered ${quantity} ${item.displayName} at ${nodeConfig.displayName} for ${staminaCost} stamina.`,
      },
      events,
    )

    return this.success(
      action,
      events,
      {
        resourceId,
        itemId: nodeConfig.itemId,
        quantity,
        staminaCost,
        cycles,
        remainingNodes: node.available,
        toolDurability,
      },
      playerId,
    )
  }

  buy(
    playerId: string,
    merchantId: MerchantId,
    itemId: ItemId,
    quantity: number,
  ): EconomyActionResult<TradeActionData> {
    return this.playerTrade('buy', playerId, merchantId, itemId, quantity)
  }

  sell(
    playerId: string,
    merchantId: MerchantId,
    itemId: ItemId,
    quantity: number,
  ): EconomyActionResult<TradeActionData> {
    return this.playerTrade('sell', playerId, merchantId, itemId, quantity)
  }

  private playerTrade(
    side: TradeSide,
    playerId: string,
    merchantId: MerchantId,
    itemId: ItemId,
    quantity: number,
  ): EconomyActionResult<TradeActionData> {
    const action = side
    const player = this.state.players[playerId]
    if (!player) return this.failure(action, 'unknown_player', `Unknown player "${playerId}"`, playerId)
    const merchant = this.state.merchants[merchantId]
    if (!merchant) {
      return this.failure(action, 'unknown_merchant', `Unknown merchant "${merchantId}"`, playerId)
    }
    const item = this.config.items[itemId]
    if (!item) return this.failure(action, 'unknown_item', `Unknown item "${itemId}"`, playerId)
    const count = toInteger(quantity)
    if (count === null || count <= 0) {
      return this.failure(action, 'invalid_quantity', 'Quantity must be a positive integer', playerId)
    }

    const result = quote(
      merchant,
      item,
      side,
      count,
      this.marketFor(player),
      this.config,
    )
    if (!result.canTrade) {
      return this.failure(
        action,
        result.blockedReason ?? 'trade_blocked',
        this.tradeBlockedMessage(result, side),
        playerId,
      )
    }

    const fill = result.fillQuantity
    const beforeBand = this.priceBand(merchant, itemId)
    const beforeStock = merchant.stock[itemId] ?? 0
    const beforeCash = merchant.cash
    const total = result.total
    const tax = this.taxFor(side, total)
    let playerCash = player.cash

    if (side === 'buy') {
      if (this.config.sinks.salesTax.appliesTo === 'player') {
        if (player.cash + 1e-9 < total + tax) {
          return this.failure(
            action,
            'insufficient_cash',
            `Purchase plus tax needs ${this.money(total + tax)}; ${this.money(player.cash)} available`,
            playerId,
          )
        }
        player.cash = roundMoney(player.cash - total - tax, this.config)
        merchant.cash = roundMoney(merchant.cash + total, this.config)
      } else {
        player.cash = roundMoney(player.cash - total, this.config)
        merchant.cash = roundMoney(merchant.cash + total - tax, this.config)
      }
      merchant.stock[itemId] = (merchant.stock[itemId] ?? 0) - fill
      player.inventory[itemId] = (player.inventory[itemId] ?? 0) + fill
      this.updateDemand(merchant, itemId, fill)
      this.state.stats.totalBuys += fill
    } else {
      if (this.config.sinks.salesTax.appliesTo === 'player') {
        player.cash = roundMoney(player.cash + total - tax, this.config)
      } else {
        player.cash = roundMoney(player.cash + total, this.config)
      }
      merchant.cash = roundMoney(merchant.cash - total, this.config)
      merchant.stock[itemId] = (merchant.stock[itemId] ?? 0) + fill
      player.inventory[itemId] = Math.max(0, (player.inventory[itemId] ?? 0) - fill)
      this.state.stats.totalSells += fill
    }

    merchant.lastTradeAt = this.state.time
    playerCash = player.cash
    if (tax > 0) this.recordSink('salesTax', tax)

    this.state.stats.tradeVolume += fill
    this.state.stats.tradeValue = roundMoney(this.state.stats.tradeValue + total, this.config)
    this.state.daily.trades.buys += side === 'buy' ? fill : 0
    this.state.daily.trades.sells += side === 'sell' ? fill : 0
    this.state.daily.trades.volume += fill
    this.state.daily.trades.value = roundMoney(
      this.state.daily.trades.value + total,
      this.config,
    )

    const afterBand = this.priceBand(merchant, itemId)
    const reasons = [...result.reasons]
    if (tax > 0) {
      reasons.push({
        code: 'sales-tax',
        label: 'Sales tax',
        value: this.config.sinks.salesTax.rate,
        effect: -tax,
        detail: `${this.money(tax)} removed from merchant proceeds`,
      })
    }

    const events: SequencedMarketEvent[] = []
    this.emit(
      {
        time: this.state.time,
        type: side === 'buy' ? 'trade.buy' : 'trade.sell',
        actor: { type: 'player', id: player.id, displayName: player.displayName },
        item: itemId,
        quantity: fill,
        price: result.unitPrice,
        before: {
          stock: beforeStock,
          cash: beforeCash,
          bid: beforeBand.bid,
          ask: beforeBand.ask,
        },
        after: {
          stock: merchant.stock[itemId] ?? 0,
          cash: merchant.cash,
          bid: afterBand.bid,
          ask: afterBand.ask,
        },
        reasons,
        cause: 'trade',
        causeId: `trade-${this.state.sequence + 1}`,
        message:
          side === 'buy'
            ? `${player.displayName} bought ${fill} ${item.displayName} from ${merchant.displayName} for ${this.money(total)} (${this.money(result.unitPrice)} each).`
            : `${player.displayName} sold ${fill} ${item.displayName} to ${merchant.displayName} for ${this.money(total)} (${this.money(result.unitPrice)} each).`,
      },
      events,
    )
    this.detectBankruptcy(merchant, events)

    return this.success(
      action,
      events,
      {
        quote: result,
        requested: count,
        filled: fill,
        unitPrice: result.unitPrice,
        total,
        tax,
        partial: fill < count,
      },
      playerId,
    )
  }

  craft(playerId: string, recipeId: string, quantity: number): EconomyActionResult<CraftActionData> {
    const action = 'craft'
    const player = this.state.players[playerId]
    if (!player) return this.failure(action, 'unknown_player', `Unknown player "${playerId}"`, playerId)
    const recipe = this.config.recipes[recipeId]
    if (!recipe) return this.failure(action, 'unknown_recipe', `Unknown recipe "${recipeId}"`, playerId)
    const count = toInteger(quantity)
    if (count === null || count <= 0) {
      return this.failure(action, 'invalid_quantity', 'Quantity must be a positive integer', playerId)
    }

    const staminaCost = recipe.staminaCost * count
    if (player.stamina < staminaCost) {
      return this.failure(
        action,
        'insufficient_stamina',
        `Craft needs ${staminaCost} stamina; ${player.stamina} available`,
        playerId,
      )
    }

    for (const [itemId, amount] of Object.entries(recipe.inputs)) {
      const required = amount * count
      if ((player.inventory[itemId] ?? 0) < required) {
        return this.failure(
          action,
          'insufficient_inputs',
          `Craft needs ${required} ${this.config.items[itemId]?.displayName ?? itemId}; ${player.inventory[itemId] ?? 0} available`,
          playerId,
        )
      }
    }

    const projected: Record<string, number> = { ...player.inventory }
    for (const [itemId, amount] of Object.entries(recipe.inputs)) {
      projected[itemId] = Math.max(0, (projected[itemId] ?? 0) - amount * count)
    }
    for (const [itemId, amount] of Object.entries(recipe.outputs)) {
      projected[itemId] = (projected[itemId] ?? 0) + amount * count
    }
    const nextWeight = inventoryWeight(projected, this.config)
    if (nextWeight > this.config.player.carryCapacity + 1e-9) {
      return this.failure(
        action,
        'carry_capacity_exceeded',
        `Craft would use ${nextWeight.toFixed(2)} of ${this.config.player.carryCapacity} carry`,
        playerId,
      )
    }

    const beforeOutputId = Object.keys(recipe.outputs).sort(stableCompare)[0]
    const beforeStock = player.inventory[beforeOutputId] ?? 0
    for (const [itemId, amount] of Object.entries(recipe.inputs)) {
      player.inventory[itemId] = Math.max(0, (player.inventory[itemId] ?? 0) - amount * count)
    }
    for (const [itemId, amount] of Object.entries(recipe.outputs)) {
      player.inventory[itemId] = (player.inventory[itemId] ?? 0) + amount * count
    }
    player.stamina = Math.max(0, player.stamina - staminaCost)
    this.state.stats.crafts += 1
    this.state.stats.itemsCrafted += Object.values(recipe.outputs).reduce(
      (sum, amount) => sum + amount * count,
      0,
    )

    const events: SequencedMarketEvent[] = []
    this.emit(
      {
        time: this.state.time,
        type: 'player.craft',
        actor: { type: 'player', id: player.id, displayName: player.displayName },
        item: beforeOutputId ?? null,
        quantity: Object.values(recipe.outputs).reduce((sum, amount) => sum + amount * count, 0),
        price: null,
        before: { stock: beforeStock, cash: player.cash, bid: null, ask: null },
        after: {
          stock: player.inventory[beforeOutputId] ?? 0,
          cash: player.cash,
          bid: null,
          ask: null,
        },
        reasons: [
          {
            code: 'recipe',
            label: 'Recipe completed',
            value: count,
            effect: 0,
            detail: recipe.displayName,
          },
          {
            code: 'stamina',
            label: 'Stamina spent',
            value: staminaCost,
            effect: 0,
          },
        ],
        cause: 'craft',
        causeId: `craft-${this.state.sequence + 1}`,
        message: `${player.displayName} crafted ${count}x ${recipe.displayName}.`,
      },
      events,
    )

    return this.success(
      action,
      events,
      {
        recipeId,
        quantity: count,
        outputs: Object.fromEntries(
          Object.entries(recipe.outputs).map(([itemId, amount]) => [itemId, amount * count]),
        ),
        staminaCost,
      },
      playerId,
    )
  }

  eat(playerId: string, itemId: ItemId): EconomyActionResult<{ itemId: ItemId; restored: number }> {
    const action = 'eat'
    const player = this.state.players[playerId]
    if (!player) return this.failure(action, 'unknown_player', `Unknown player "${playerId}"`, playerId)
    const item = this.config.items[itemId]
    if (!item) return this.failure(action, 'unknown_item', `Unknown item "${itemId}"`, playerId)
    if (item.use.kind !== 'consumable' || !item.use.staminaRestore) {
      return this.failure(action, 'item_not_consumable', `${item.displayName} cannot be eaten`, playerId)
    }
    if ((player.inventory[itemId] ?? 0) <= 0) {
      return this.failure(
        action,
        'insufficient_inventory',
        `No ${item.displayName} in inventory`,
        playerId,
      )
    }
    if (player.stamina >= player.maxStamina) {
      return this.failure(action, 'stamina_full', 'Stamina is already full', playerId)
    }

    const before = player.stamina
    player.inventory[itemId] = (player.inventory[itemId] ?? 0) - 1
    player.stamina = Math.min(player.maxStamina, player.stamina + item.use.staminaRestore)
    this.state.stats.itemsConsumed += 1
    const restored = player.stamina - before

    const events: SequencedMarketEvent[] = []
    this.emit(
      {
        time: this.state.time,
        type: 'player.use',
        actor: { type: 'player', id: player.id, displayName: player.displayName },
        item: itemId,
        quantity: 1,
        price: null,
        before: { stock: (player.inventory[itemId] ?? 0) + 1, cash: player.cash, bid: null, ask: null },
        after: { stock: player.inventory[itemId] ?? 0, cash: player.cash, bid: null, ask: null },
        reasons: [
          {
            code: 'stamina-restore',
            label: 'Stamina restored',
            value: restored,
            effect: 0,
            detail: `${before} -> ${player.stamina}`,
          },
        ],
        cause: 'use',
        causeId: `use-${this.state.sequence + 1}`,
        message: `${player.displayName} used ${item.displayName} and restored ${restored.toFixed(1)} stamina.`,
      },
      events,
    )

    return this.success(action, events, { itemId, restored }, playerId)
  }

  /**
   * Debits `amount` units of one item straight out of a player's inventory.
   *
   * This is the economy-side seam used by the settlement ledger: units become
   * unavailable for trading when the withdrawal is committed on testnet. All
   * validation happens before the inventory is touched, and a real market
   * event (`player.withdraw` / `withdrawal`) is emitted for the feed.
   */
  withdrawItem(
    playerId: string,
    itemId: ItemId,
    amount: number,
  ): EconomyActionResult<WithdrawActionData> {
    const action = 'withdrawItem'
    const player = this.state.players[playerId]
    if (!player) return this.failure(action, 'unknown_player', `Unknown player "${playerId}"`, playerId)
    const item = this.config.items[itemId]
    if (!item) return this.failure(action, 'unknown_item', `Unknown item "${itemId}"`, playerId)
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      return this.failure(
        action,
        'invalid_amount',
        `Withdraw amount must be a positive whole number, got ${amount}`,
        playerId,
      )
    }
    const current = player.inventory[itemId] ?? 0
    if (current < amount) {
      return this.failure(
        action,
        'insufficient_inventory',
        `Cannot withdraw ${amount} ${item.displayName}; only ${current} in inventory`,
        playerId,
      )
    }

    // All checks passed: debit now, then report the opening and closing stock.
    player.inventory[itemId] = current - amount

    const events: SequencedMarketEvent[] = []
    this.emit(
      {
        time: this.state.time,
        type: 'player.withdraw',
        actor: { type: 'player', id: player.id, displayName: player.displayName },
        item: itemId,
        quantity: amount,
        price: null,
        before: { stock: current, cash: player.cash, bid: null, ask: null },
        after: { stock: current - amount, cash: player.cash, bid: null, ask: null },
        reasons: [
          {
            code: 'withdrawal',
            label: 'Units withdrawn from game inventory',
            value: amount,
            effect: 0,
            detail: item.displayName,
          },
        ],
        cause: 'withdrawal',
        causeId: `withdraw-${this.state.sequence + 1}`,
        message: `${player.displayName} withdrew ${amount}x ${item.displayName} from the game economy.`,
      },
      events,
    )

    return this.success(
      action,
      events,
      { itemId, quantity: amount, remaining: current - amount },
      playerId,
    )
  }

  repair(playerId: string): EconomyActionResult<RepairActionData> {
    const action = 'repair'
    const player = this.state.players[playerId]
    if (!player) return this.failure(action, 'unknown_player', `Unknown player "${playerId}"`, playerId)
    const toolId = player.equippedTool
    const tool = toolId ? this.config.items[toolId] : undefined
    if (!tool?.tool) {
      return this.failure(action, 'no_tool_equipped', 'No repairable tool is equipped', playerId)
    }
    const current = player.toolDurability?.[tool.id] ?? tool.tool.maxDurability
    const missing = tool.tool.maxDurability - current
    if (missing <= 0) {
      return this.failure(action, 'tool_already_full', `${tool.displayName} is already fully repaired`, playerId)
    }
    const cost = roundMoney(missing * this.config.sinks.toolDurability.repairCostPerPoint, this.config)
    if (player.cash + 1e-9 < cost) {
      return this.failure(
        action,
        'insufficient_cash',
        `Repair needs ${this.money(cost)}; ${this.money(player.cash)} available`,
        playerId,
      )
    }

    const beforeCash = player.cash
    player.cash = roundMoney(player.cash - cost, this.config)
    player.toolDurability = { ...(player.toolDurability ?? {}), [tool.id]: tool.tool.maxDurability }
    this.state.stats.repairs += 1
    this.recordSink('repairs', cost)

    const events: SequencedMarketEvent[] = []
    this.emit(
      {
        time: this.state.time,
        type: 'player.repair',
        actor: { type: 'player', id: player.id, displayName: player.displayName },
        item: tool.id,
        quantity: missing,
        price: cost,
        before: { stock: current, cash: beforeCash, bid: null, ask: null },
        after: { stock: tool.tool.maxDurability, cash: player.cash, bid: null, ask: null },
        reasons: [
          {
            code: 'repair',
            label: 'Tool repaired',
            value: missing,
            effect: -cost,
            detail: `${this.money(this.config.sinks.toolDurability.repairCostPerPoint)} per point`,
          },
        ],
        cause: 'repair',
        causeId: `repair-${this.state.sequence + 1}`,
        message: `${player.displayName} repaired ${tool.displayName} for ${this.money(cost)}.`,
      },
      events,
    )

    return this.success(action, events, { itemId: tool.id, restored: missing, cost }, playerId)
  }

  invest(
    playerId: string,
    merchantId: MerchantId,
    amount: number,
  ): EconomyActionResult<InvestActionData> {
    const action = 'invest'
    const player = this.state.players[playerId]
    if (!player) return this.failure(action, 'unknown_player', `Unknown player "${playerId}"`, playerId)
    const merchant = this.state.merchants[merchantId]
    if (!merchant) {
      return this.failure(action, 'unknown_merchant', `Unknown merchant "${merchantId}"`, playerId)
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return this.failure(action, 'invalid_amount', 'Investment amount must be positive', playerId)
    }
    const value = roundMoney(amount, this.config)
    if (value <= 0) {
      return this.failure(action, 'invalid_amount', 'Investment amount is below currency precision', playerId)
    }
    if (player.cash + 1e-9 < value) {
      return this.failure(
        action,
        'insufficient_cash',
        `Investment needs ${this.money(value)}; ${this.money(player.cash)} available`,
        playerId,
      )
    }
    if (merchant.open && !merchant.bankrupt) {
      return this.failure(
        action,
        'merchant_not_bankrupt',
        `${merchant.displayName} is already trading`,
        playerId,
      )
    }

    const events: SequencedMarketEvent[] = []
    const record = this.investInMerchant(player, merchant, value, events)
    return this.success(action, events, { investment: cloneJson(record) }, playerId)
  }

  /** Shared investment application used by players and scheduled scenario rescuers. */
  private investInMerchant(
    player: PlayerRuntimeState,
    merchant: MerchantRuntimeState,
    value: number,
    events: SequencedMarketEvent[],
  ): InvestmentRecord {
    const beforeCash = merchant.cash
    player.cash = roundMoney(player.cash - value, this.config)
    merchant.cash = roundMoney(merchant.cash + value, this.config)
    merchant.open = true
    merchant.bankrupt = false
    merchant.bankruptAt = null
    merchant.reopenedAt = this.state.time
    merchant.lastRestockAt = this.state.time
    // The reopening capital is not trading profit, so exclude it from tomorrow's
    // distribution calculation.
    merchant.cashAtDayStart = roundMoney(merchant.cashAtDayStart + value, this.config)

    const id = `inv_${stableHash64(`${this.state.seed}:${this.state.sequence + 1}:${player.id}:${merchant.id}:${value}`)}`
    const record: InvestmentRecord = {
      id,
      playerId: player.id,
      merchantId: merchant.id,
      amount: value,
      day: this.state.day,
      time: this.state.time,
      status: 'active',
      receipt: `Investment of ${this.money(value)} reopened ${merchant.displayName}. ${(this.config.investments.profitShareRate * 100).toFixed(0)}% of positive daily merchant profit is shared pro rata with active investors.`,
      totalDistributed: 0,
      distributions: [],
    }
    this.state.investments.push(record)
    this.state.stats.investments += 1
    this.state.stats.investmentAmount = roundMoney(
      this.state.stats.investmentAmount + value,
      this.config,
    )
    this.state.daily.investments.count += 1
    this.state.daily.investments.amount = roundMoney(
      this.state.daily.investments.amount + value,
      this.config,
    )

    this.emit(
      {
        time: this.state.time,
        type: 'merchant.investment',
        actor: { type: 'player', id: player.id, displayName: player.displayName },
        item: null,
        quantity: null,
        price: value,
        before: { stock: totalStock(merchant), cash: beforeCash, bid: null, ask: null },
        after: { stock: totalStock(merchant), cash: merchant.cash, bid: null, ask: null },
        reasons: [
          {
            code: 'reopen',
            label: 'Merchant reopened',
            value,
            effect: 0,
            detail: `${merchant.displayName} cash ${this.money(beforeCash)} -> ${this.money(merchant.cash)}`,
          },
          {
            code: 'terms',
            label: 'Profit share',
            value: this.config.investments.profitShareRate,
            effect: 0,
            detail: 'Paid daily from positive profit while the merchant trades',
          },
        ],
        cause: 'investment',
        causeId: id,
        message: `${player.displayName} invested ${this.money(value)} to reopen ${merchant.displayName}.`,
      },
      events,
    )
    this.emit(
      {
        time: this.state.time,
        type: 'merchant.reopen',
        actor: { type: 'merchant', id: merchant.id, displayName: merchant.displayName },
        item: null,
        quantity: null,
        price: null,
        before: { stock: totalStock(merchant), cash: beforeCash, bid: null, ask: null },
        after: { stock: totalStock(merchant), cash: merchant.cash, bid: null, ask: null },
        reasons: [
          {
            code: 'reopen',
            label: 'Stall reopened',
            value: merchant.cash,
            effect: 0,
            detail: `Cash ${this.money(merchant.cash)} vs reserve ${this.money(merchant.reserve)}`,
          },
        ],
        cause: 'investment',
        causeId: id,
        message: `${merchant.displayName}'s stall reopened for business.`,
      },
      events,
    )

    return record
  }

  acceptOrder(playerId: string, orderId: string): EconomyActionResult<OrderActionData> {
    const action = 'acceptOrder'
    const player = this.state.players[playerId]
    if (!player) return this.failure(action, 'unknown_player', `Unknown player "${playerId}"`, playerId)
    const order = this.state.orders.find(candidate => candidate.id === orderId)
    if (!order) return this.failure(action, 'unknown_order', `Unknown order "${orderId}"`, playerId)
    if (order.status === 'expired') {
      return this.failure(action, 'order_expired', 'Order has expired', playerId)
    }
    if (order.status !== 'open') {
      return this.failure(
        action,
        'order_not_open',
        order.acceptedBy === playerId ? 'Order is already accepted by you' : 'Order is no longer available',
        playerId,
      )
    }
    if (order.expiresAt <= this.state.time) {
      order.status = 'expired'
      order.updatedAt = this.state.time
      return this.failure(action, 'order_expired', 'Order has expired', playerId)
    }

    order.status = 'accepted'
    order.acceptedBy = playerId
    order.acceptedAt = this.state.time
    order.updatedAt = this.state.time
    this.state.stats.ordersAccepted += 1
    this.state.daily.orders.accepted += 1

    const events: SequencedMarketEvent[] = []
    this.emit(
      {
        time: this.state.time,
        type: 'order.accepted',
        actor: { type: 'player', id: player.id, displayName: player.displayName },
        item: order.itemId,
        quantity: order.remaining,
        price: order.unitReward,
        before: EMPTY_SNAPSHOT(),
        after: { stock: null, cash: player.cash, bid: null, ask: null },
        reasons: [
          {
            code: 'order',
            label: 'Bulk order accepted',
            value: order.remaining,
            effect: 0,
            detail: `${order.issuer} pays ${this.money(order.unitReward)} per unit`,
          },
        ],
        cause: 'order',
        causeId: order.id,
        message: `${player.displayName} accepted ${order.remaining} ${this.config.items[order.itemId]?.displayName ?? order.itemId} for ${order.issuer}.`,
      },
      events,
    )
    return this.success(action, events, { order: cloneJson(order) }, playerId)
  }

  fulfillOrder(
    playerId: string,
    orderId: string,
    quantity?: number,
  ): EconomyActionResult<OrderActionData> {
    const action = 'fulfillOrder'
    const player = this.state.players[playerId]
    if (!player) return this.failure(action, 'unknown_player', `Unknown player "${playerId}"`, playerId)
    const order = this.state.orders.find(candidate => candidate.id === orderId)
    if (!order) return this.failure(action, 'unknown_order', `Unknown order "${orderId}"`, playerId)
    if (order.status === 'expired') return this.failure(action, 'order_expired', 'Order has expired', playerId)
    if (order.status === 'fulfilled') return this.failure(action, 'order_fulfilled', 'Order is already complete', playerId)
    if (order.status !== 'accepted' || order.acceptedBy !== playerId) {
      return this.failure(action, 'order_not_accepted', 'Accept this order before fulfilling it', playerId)
    }
    if (order.expiresAt <= this.state.time) {
      order.status = 'expired'
      order.updatedAt = this.state.time
      return this.failure(action, 'order_expired', 'Order has expired', playerId)
    }
    const count = quantity === undefined ? order.remaining : toInteger(quantity)
    if (count === null || count <= 0) {
      return this.failure(action, 'invalid_quantity', 'Quantity must be a positive integer', playerId)
    }
    if (count > order.remaining) {
      return this.failure(
        action,
        'quantity_exceeds_order',
        `Only ${order.remaining} unit(s) remain on this order`,
        playerId,
      )
    }
    if ((player.inventory[order.itemId] ?? 0) < count) {
      return this.failure(
        action,
        'insufficient_inventory',
        `Order needs ${count} ${this.config.items[order.itemId]?.displayName ?? order.itemId}; ${player.inventory[order.itemId] ?? 0} available`,
        playerId,
      )
    }

    const paid = roundMoney(order.unitReward * count, this.config)
    player.inventory[order.itemId] = Math.max(0, (player.inventory[order.itemId] ?? 0) - count)
    player.cash = roundMoney(player.cash + paid, this.config)
    order.remaining -= count
    order.updatedAt = this.state.time
    if (order.remaining === 0) {
      order.status = 'fulfilled'
      order.fulfilledAt = this.state.time
    }
    this.state.stats.ordersFulfilled += count
    this.state.stats.orderUnits += count
    this.state.stats.orderPayouts = roundMoney(this.state.stats.orderPayouts + paid, this.config)
    this.state.stats.sources.orderPayouts = roundMoney(
      this.state.stats.sources.orderPayouts + paid,
      this.config,
    )
    this.state.daily.orders.fulfilled += count
    this.state.daily.orders.units += count
    this.state.daily.orders.payouts = roundMoney(this.state.daily.orders.payouts + paid, this.config)

    const events: SequencedMarketEvent[] = []
    this.emit(
      {
        time: this.state.time,
        type: 'order.fulfilled',
        actor: { type: 'player', id: player.id, displayName: player.displayName },
        item: order.itemId,
        quantity: count,
        price: order.unitReward,
        before: {
          stock: (player.inventory[order.itemId] ?? 0) + count,
          cash: roundMoney(player.cash - paid, this.config),
          bid: null,
          ask: null,
        },
        after: {
          stock: player.inventory[order.itemId] ?? 0,
          cash: player.cash,
          bid: null,
          ask: null,
        },
        reasons: [
          {
            code: 'order',
            label: 'Order delivered',
            value: count,
            effect: paid,
            detail: `${order.remaining} unit(s) left`,
          },
        ],
        cause: 'order',
        causeId: order.id,
        message: `${player.displayName} delivered ${count} ${this.config.items[order.itemId]?.displayName ?? order.itemId} to ${order.issuer} for ${this.money(paid)}.`,
      },
      events,
    )
    this.state.stats.ordersAccepted += 0
    return this.success(action, events, { order: cloneJson(order), paid }, playerId)
  }

  /* ---------------------------------------------------------------------- */
  /* Time                                                                   */
  /* ---------------------------------------------------------------------- */

  tick(seconds?: number): EconomyActionResult<TickActionData> {
    const action = 'tick'
    const requested = roundSeconds(seconds ?? this.config.fastForward.stepSeconds)
    if (!Number.isFinite(requested) || requested <= 0) {
      return this.failure(
        action,
        'invalid_duration',
        'Tick duration must be positive at the simulation time precision',
        undefined,
      )
    }
    const maxSeconds =
      this.config.fastForward.maxSteps * this.config.fastForward.stepSeconds
    if (requested > maxSeconds) {
      return this.failure(
        action,
        'tick_too_long',
        `Tick duration ${requested}s exceeds the safe maximum ${maxSeconds}s`,
        undefined,
      )
    }

    const events: SequencedMarketEvent[] = []
    const fromTime = this.state.time
    const target = roundSeconds(this.state.time + requested)
    let steps = 0
    while (this.state.time < target - 1e-9) {
      const step = roundSeconds(
        Math.min(this.config.fastForward.stepSeconds, target - this.state.time),
      )
      this.advanceStep(step, events)
      steps += 1
    }

    return this.success(
      action,
      events,
      { fromTime, toTime: this.state.time, day: this.state.day, steps },
    )
  }

  fastForward(days?: number): EconomyFastForwardResult {
    const wallStart = Date.now()
    const requested = days ?? this.config.fastForward.days
    if (!Number.isInteger(requested) || requested <= 0) {
      return this.fastForwardFailure('fastForward', 'invalid_days', 'Days must be a positive integer', 0)
    }
    if (requested > this.config.fastForward.maxDays) {
      return this.fastForwardFailure(
        'fastForward',
        'days_exceed_limit',
        `${requested} days exceeds maxDays ${this.config.fastForward.maxDays}`,
        0,
      )
    }
    const totalSeconds = requested * 86400
    const steps = Math.ceil(totalSeconds / this.config.fastForward.stepSeconds)
    if (steps > this.config.fastForward.maxSteps) {
      return this.fastForwardFailure(
        'fastForward',
        'steps_exceed_limit',
        `${steps} steps exceeds maxSteps ${this.config.fastForward.maxSteps}`,
        0,
      )
    }

    const fromTime = this.state.time
    const startDay = this.state.day
    const startSequence = this.state.sequence
    const summaryStart = this.state.summaries.length
    const eventSample = Math.max(1, Math.floor(this.config.reporting.eventSampleSize))

    this.state.fastForwardRuns += 1
    if (this.config.fastForward.seedBehavior === 'derive-per-run') {
      const runSeed = `${this.config.meta.seed}:ff:${startDay}:${fromTime}:${this.state.fastForwardRuns}`
      this.state.rngSeed = runSeed
      this.rng = new DeterministicRng(runSeed)
      this.state.rngState = this.rng.state
      this.state.rngDraws = 0
    }

    const beforeCash = totalMerchantCash(this.state)
    const beforeStock = totalStockOf(this.state)
    const beforePlayerCash = totalPlayerCash(this.state)
    const priceHistory: FastForwardPriceSnapshot[] = []
    // Scenario shocks are recorded from the live step output rather than the
    // sampled event list: sampling may drop a shock, and the retained event
    // buffer may evict it on a long run. Annotations need exact evidence.
    const shockEvents: SequencedMarketEvent[] = []
    let lastSummaryDay = this.state.summaries.length > 0
      ? this.state.summaries[this.state.summaries.length - 1].day
      : this.state.day - 1

    let elapsed = 0
    let executedSteps = 0
    while (elapsed < totalSeconds - 1e-9) {
      const step = Math.min(this.config.fastForward.stepSeconds, totalSeconds - elapsed)
      const stepEvents: SequencedMarketEvent[] = []
      this.advanceStep(step, stepEvents)
      for (const event of stepEvents) {
        if (event.type === 'system.shock') shockEvents.push(event)
      }
      // Normally one day closes per step, but capture every new summary so a
      // larger configured step size still yields complete day coverage.
      const newSummaries = this.state.summaries.filter(
        summary => summary.day > lastSummaryDay,
      )
      for (const summary of newSummaries) {
        priceHistory.push({
          day: summary.day,
          endedAt: summary.endedAt,
          prices: this.capturePriceSnapshot(),
        })
        lastSummaryDay = summary.day
      }
      elapsed += step
      executedSteps += 1
    }

    const finalEvent = this.emit({
      time: this.state.time,
      type: 'system.fast-forward',
      actor: { type: 'system', id: 'fast-forward', displayName: 'Fast-forward' },
      item: null,
      quantity: requested,
      price: null,
      before: {
        stock: beforeStock,
        cash: beforeCash,
        bid: null,
        ask: null,
      },
      after: {
        stock: totalStockOf(this.state),
        cash: totalMerchantCash(this.state),
        bid: null,
        ask: null,
      },
      reasons: [
        {
          code: 'days',
          label: 'Simulated days',
          value: requested,
          effect: 0,
          detail: `${executedSteps} steps of ${this.config.fastForward.stepSeconds}s`,
        },
        {
          code: 'player-cash',
          label: 'Player cash change',
          value: roundMoney(totalPlayerCash(this.state) - beforePlayerCash, this.config),
          effect: 0,
        },
      ],
      cause: 'fast-forward',
      causeId: `ff-${startDay}-${requested}-${this.state.fastForwardRuns}`,
      message: `Fast-forwarded ${requested} days from day ${startDay} to day ${this.state.day}.`,
    })

    const summaries = cloneJson(this.state.summaries.slice(summaryStart))
    const series: FastForwardSeriesPoint[] = summaries.map(summary => ({
      day: summary.day,
      endedAt: summary.endedAt,
      totalMerchantCash: summary.totalMerchantCash,
      totalPlayerCash: summary.totalPlayerCash,
      tradeVolume: summary.trades.volume,
      tradeValue: summary.trades.value,
      bankruptcies: summary.bankruptcies.length,
      caravanArrivals: summary.caravan.arrivals,
      sinkTotal: summary.sinks.total,
    }))
    const windowEvents = this.state.events.filter(
      event => event.sequence > startSequence,
    )
    const events = sampleFastForwardEvents(
      windowEvents,
      eventSample,
      fromTime,
      this.state.time,
    )
    if (!events.some(event => event.sequence === finalEvent.sequence)) {
      events.splice(Math.max(0, events.length - 1), 1, finalEvent)
    }

    return {
      success: true,
      days: requested,
      fromTime,
      toTime: this.state.time,
      startDay,
      endDay: this.state.day,
      steps: executedSteps,
      seed: this.state.rngSeed,
      summaries,
      series,
      priceHistory: cloneJson(priceHistory),
      shockEvents: cloneJson(shockEvents),
      events: cloneJson(events),
      eventCount: this.state.sequence - startSequence,
      finalSequence: this.state.sequence,
      durationMs: Date.now() - wallStart,
    }
  }

  private fastForwardFailure(
    action: string,
    code: string,
    message: string,
    days: number,
  ): EconomyFastForwardResult {
    return {
      success: false,
      days,
      fromTime: this.state.time,
      toTime: this.state.time,
      startDay: this.state.day,
      endDay: this.state.day,
      steps: 0,
      seed: this.state.rngSeed,
      summaries: [],
      series: [],
      priceHistory: [],
      shockEvents: [],
      events: [],
      eventCount: 0,
      finalSequence: this.state.sequence,
      durationMs: 0,
      error: { code, message },
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Tick internals                                                         */
  /* ---------------------------------------------------------------------- */

  private advanceStep(seconds: number, events: SequencedMarketEvent[]): void {
    if (seconds <= 0) return
    this.state.time = roundSeconds(this.state.time + seconds)
    this.applyDueScenarioShocks(events)

    const demandDecay = Math.max(
      0,
      1 - seconds / this.config.pricing.demand.windowSeconds,
    )
    for (const merchant of Object.values(this.state.merchants)) {
      for (const itemId of Object.keys(merchant.demandEma)) {
        merchant.demandEma[itemId] = Math.max(0, merchant.demandEma[itemId] * demandDecay)
      }
    }

    for (const player of Object.values(this.state.players)) {
      player.stamina = Math.min(
        player.maxStamina,
        player.stamina + this.config.player.stamina.regenerationPerSecond * seconds,
      )
    }
    for (const bot of this.state.bots) {
      bot.stamina = Math.min(
        bot.maxStamina,
        bot.stamina + this.config.player.stamina.regenerationPerSecond * seconds,
      )
    }

    this.respawnResources(events)
    for (const merchant of Object.values(this.state.merchants)) {
      const config = this.config.merchants[merchant.id]
      if (!merchant.open) {
        merchant.lastRestockAt = this.state.time
        continue
      }
      if (
        this.state.time + 1e-9 >=
        merchant.lastRestockAt + config.restockRate.intervalSeconds
      ) {
        this.restockMerchant(merchant, events)
      }
    }

    for (const bot of this.state.bots) {
      if (this.state.time + 1e-9 >= bot.nextActionAt) {
        this.runBot(bot, events)
      }
    }

    if (this.state.time + 1e-9 >= this.state.caravan.nextArrivalAt) {
      this.runCaravan(events)
    }

    this.expireOrders(events)

    for (const merchant of Object.values(this.state.merchants)) {
      this.detectBankruptcy(merchant, events)
    }
    this.applyDueScenarioRescues(events)

    const currentDay = Math.floor(this.state.time / 86400) + 1
    while (this.state.day < currentDay) {
      const closingDay = this.state.day
      this.closeDay(closingDay, events)
      this.state.day = closingDay + 1
      this.startDay(this.state.day, events)
    }
  }

  private applyDueScenarioShocks(events: SequencedMarketEvent[]): void {
    const shocks = [...this.config.scenario.shocks].sort((left, right) => {
      const leftAt = (left.day - 1) * 86400 + left.atSecond
      const rightAt = (right.day - 1) * 86400 + right.atSecond
      return leftAt - rightAt || stableCompare(left.id, right.id)
    })

    for (const shock of shocks) {
      if (this.state.scenario.appliedShockIds.includes(shock.id)) continue
      const dueAt = (shock.day - 1) * 86400 + shock.atSecond
      if (this.state.time + 1e-9 < dueAt) continue
      this.state.scenario.appliedShockIds.push(shock.id)

      const merchant = this.state.merchants[shock.merchantId]
      if (!merchant) continue
      const beforeCash = merchant.cash
      const beforeStock = totalStock(merchant)
      let itemId: ItemId | null = null
      let quantity: number | null = null
      let unitPrice: number | null = null
      let spent = 0

      if (shock.kind === 'cash-drain') {
        spent = Math.min(merchant.cash, Math.max(0, shock.amount ?? 0))
        merchant.cash = roundMoney(merchant.cash - spent, this.config)
      } else {
        const item = shock.itemId ? this.config.items[shock.itemId] : undefined
        if (!item) continue
        const offered = Math.max(0, Math.floor(shock.quantity ?? 0))
        const price = shock.unitPrice ?? item.baseValue
        const fill =
          price > 0
            ? Math.min(offered, Math.floor((merchant.cash + 1e-9) / price))
            : 0
        if (fill > 0) {
          spent = roundMoney(fill * price, this.config)
          merchant.cash = roundMoney(merchant.cash - spent, this.config)
          merchant.stock[item.id] = (merchant.stock[item.id] ?? 0) + fill
          itemId = item.id
          quantity = fill
          unitPrice = price
        }
      }

      const payment =
        itemId !== null && quantity !== null && unitPrice !== null
          ? `${merchant.displayName} bought ${quantity} ${this.config.items[itemId]?.displayName ?? itemId} at ${this.money(unitPrice)} each (${this.money(spent)}),`
          : `${merchant.displayName} paid ${this.money(spent)},`
      this.recordSink('shocks', spent)
      this.emit(
        {
          time: this.state.time,
          type: 'system.shock',
          actor: { type: 'system', id: 'scenario', displayName: 'Town scenario' },
          item: itemId,
          quantity,
          price: unitPrice,
          before: { stock: beforeStock, cash: beforeCash, bid: null, ask: null },
          after: {
            stock: totalStock(merchant),
            cash: merchant.cash,
            bid: null,
            ask: null,
          },
          reasons: [
            {
              code: 'shock',
              label: 'Scenario shock',
              value: 1,
              effect: -spent,
              detail: shock.id,
            },
            {
              code: 'merchant-cash',
              label: 'Merchant cash after shock',
              value: merchant.cash,
              effect: 0,
              detail: `${merchant.displayName} reserve ${this.money(merchant.reserve)}`,
            },
          ],
          cause: 'shock',
          causeId: shock.id,
          message: `${shock.message} ${payment} leaving ${this.money(merchant.cash)} against a ${this.money(merchant.reserve)} reserve.`,
        },
        events,
      )
    }
  }

  private applyDueScenarioRescues(events: SequencedMarketEvent[]): void {
    const investor = this.config.scenario.investor
    if (!investor) return

    for (const shock of this.config.scenario.shocks) {
      const rescue = shock.rescue
      if (!rescue) continue
      if (this.state.scenario.rescues.some(record => record.shockId === shock.id)) continue

      const merchant = this.state.merchants[shock.merchantId]
      if (!merchant || !merchant.bankrupt || merchant.bankruptAt === null) continue
      if (this.state.time + 1e-9 < merchant.bankruptAt + rescue.delaySeconds) continue

      const player = this.ensureScenarioInvestor(rescue.investorId, investor.displayName, investor.cash, events)
      const amount = roundMoney(rescue.amount, this.config)
      if (amount <= 0 || player.cash + 1e-9 < amount) continue

      const investment = this.investInMerchant(player, merchant, amount, events)
      this.state.scenario.rescues.push({
        shockId: shock.id,
        investorId: player.id,
        investmentId: investment.id,
        at: this.state.time,
      })
    }
  }

  private ensureScenarioInvestor(
    playerId: string,
    displayName: string,
    cash: number,
    events: SequencedMarketEvent[],
  ): PlayerRuntimeState {
    const existing = this.state.players[playerId]
    if (existing) return existing

    const player: PlayerRuntimeState = {
      id: playerId,
      displayName,
      cash: roundMoney(cash, this.config),
      inventory: {},
      stamina: this.config.player.stamina.max,
      maxStamina: this.config.player.stamina.max,
      joinedAt: this.state.time,
    }
    this.state.players[playerId] = player
    this.emit(
      {
        time: this.state.time,
        type: 'player.join',
        actor: { type: 'player', id: player.id, displayName: player.displayName },
        item: null,
        quantity: null,
        price: null,
        before: EMPTY_SNAPSHOT(),
        after: { stock: null, cash: player.cash, bid: null, ask: null },
        reasons: [
          {
            code: 'scenario-investor',
            label: 'Scenario investor capital',
            value: player.cash,
            effect: 0,
            detail: 'Funds a scheduled rescue investment',
          },
        ],
        cause: 'configuration',
        causeId: `scenario-investor-${player.id}`,
        message: `${player.displayName} arrived with ${this.money(player.cash)} to back a closed stall.`,
      },
      events,
    )
    return player
  }

  private respawnResources(events: SequencedMarketEvent[]): void {
    for (const resource of Object.values(this.state.resources)) {
      const config = this.config.resources.nodes[resource.id]
      if (!config) continue
      if (resource.available >= config.nodeCount) {
        resource.nextRespawnAt = null
        continue
      }
      if (resource.nextRespawnAt === null) {
        resource.nextRespawnAt = roundSeconds(this.state.time + config.respawnSeconds)
        continue
      }
      let respawned = 0
      while (
        resource.available < config.nodeCount &&
        this.state.time + 1e-9 >= resource.nextRespawnAt
      ) {
        resource.available += 1
        respawned += 1
        if (resource.available < config.nodeCount) {
          resource.nextRespawnAt = roundSeconds(
            resource.nextRespawnAt + config.respawnSeconds,
          )
        } else {
          resource.nextRespawnAt = null
        }
      }
      if (respawned > 0) {
        this.emit(
          {
            time: this.state.time,
            type: 'merchant.restock',
            actor: { type: 'system', id: 'resources', displayName: 'Resource nodes' },
            item: config.itemId,
            quantity: respawned,
            price: null,
            before: {
              stock: resource.available - respawned,
              cash: null,
              bid: null,
              ask: null,
            },
            after: { stock: resource.available, cash: null, bid: null, ask: null },
            reasons: [
              {
                code: 'respawn',
                label: 'Resource respawned',
                value: respawned,
                effect: 0,
                detail: `${config.displayName} every ${config.respawnSeconds}s`,
              },
            ],
            cause: 'restock',
            causeId: `respawn-${resource.id}-${this.state.sequence + 1}`,
            message: `${config.displayName} respawned ${respawned} node(s).`,
          },
          events,
        )
      }
    }
  }

  private restockMerchant(
    merchant: MerchantRuntimeState,
    events: SequencedMarketEvent[],
  ): void {
    const config = this.config.merchants[merchant.id]
    const beforeStock = totalStock(merchant)
    const beforeCash = merchant.cash
    let added = 0
    let produced = 0

    for (const itemId of Object.keys(merchant.targetStock).sort(stableCompare)) {
      const target = Math.floor(
        merchant.targetStock[itemId] * config.restockRate.targetRatio,
      )
      const current = merchant.stock[itemId] ?? 0
      const increment = Math.min(config.restockRate.unitsPerTick, Math.max(0, target - current))
      if (increment > 0) {
        merchant.stock[itemId] = current + increment
        added += increment
      }
    }

    if (config.supplyChain) {
      const maxStock = this.config.pricing.trade.maxStockMultiple
      for (let batch = 0; batch < config.supplyChain.batchesPerRestock; batch += 1) {
        const canConsume = Object.entries(config.supplyChain.inputs).every(
          ([itemId, amount]) => (merchant.stock[itemId] ?? 0) >= amount,
        )
        if (!canConsume) break
        const canStore = Object.entries(config.supplyChain.outputs).every(
          ([itemId, amount]) => {
            const target = merchant.targetStock[itemId] ?? 0
            return (merchant.stock[itemId] ?? 0) + amount <= target * maxStock + 1e-9
          },
        )
        if (!canStore) break
        for (const [itemId, amount] of Object.entries(config.supplyChain.inputs)) {
          merchant.stock[itemId] = Math.max(0, (merchant.stock[itemId] ?? 0) - amount)
        }
        for (const [itemId, amount] of Object.entries(config.supplyChain.outputs)) {
          merchant.stock[itemId] = (merchant.stock[itemId] ?? 0) + amount
          produced += amount
        }
      }
    }

    merchant.lastRestockAt = this.state.time
    if (added === 0 && produced === 0) return
    this.state.stats.restocks += 1

    this.emit(
      {
        time: this.state.time,
        type: 'merchant.restock',
        actor: { type: 'merchant', id: merchant.id, displayName: merchant.displayName },
        item: null,
        quantity: added + produced,
        price: null,
        before: { stock: beforeStock, cash: beforeCash, bid: null, ask: null },
        after: { stock: totalStock(merchant), cash: merchant.cash, bid: null, ask: null },
        reasons: [
          {
            code: 'restock',
            label: 'Stall restocked',
            value: added,
            effect: 0,
            detail: `${config.restockRate.unitsPerTick} units per ${config.restockRate.intervalSeconds}s`,
          },
          {
            code: 'supply-chain',
            label: 'Supply chain produced',
            value: produced,
            effect: 0,
            detail: config.supplyChain ? 'Configured merchant conversion' : 'No conversion configured',
          },
        ],
        cause: 'restock',
        causeId: `restock-${merchant.id}-${this.state.sequence + 1}`,
        message: `${merchant.displayName} restocked ${added} unit(s) and produced ${produced} unit(s).`,
      },
      events,
    )
  }

  private runBot(bot: BotRuntimeState, events: SequencedMarketEvent[]): void {
    const behavior = this.config.bots.behavior
    const orderBoard = this.config.orders.botParticipation
    if (orderBoard.enabled && this.random() < orderBoard.chance) {
      if (this.tryBotOrder(bot, events)) {
        bot.lastActionAt = this.state.time
        bot.nextActionAt =
          this.state.time + behavior.cadenceSeconds + this.randomInt(0, behavior.jitterSeconds)
        return
      }
    }

    const roll = this.random()
    let side: TradeSide | null =
      roll < behavior.buyProbability
        ? 'buy'
        : roll < behavior.buyProbability + behavior.sellProbability
          ? 'sell'
          : null
    if (side === null) {
      bot.lastActionAt = this.state.time
      bot.nextActionAt =
        this.state.time + behavior.cadenceSeconds + this.randomInt(0, behavior.jitterSeconds)
      return
    }

    let traded = this.tryBotTrade(bot, side, events)
    if (!traded) {
      side = side === 'buy' ? 'sell' : 'buy'
      traded = this.tryBotTrade(bot, side, events)
    }
    // A bot with no cash and no stock takes a work shift at a resource node.
    // This keeps the market liquid for the whole week without inventing money.
    if (!traded) this.botWork(bot, events)
    bot.lastActionAt = this.state.time
    bot.nextActionAt =
      this.state.time + behavior.cadenceSeconds + this.randomInt(0, behavior.jitterSeconds)
  }

  private botWork(bot: BotRuntimeState, events: SequencedMarketEvent[]): boolean {
    if (bot.stamina < 1) return false
    const candidates = Object.values(this.state.resources)
      .filter(resource => {
        const config = this.config.resources.nodes[resource.id]
        return Boolean(config) && resource.available > 0
      })
      .sort((left, right) => stableCompare(left.id, right.id))
    if (candidates.length === 0) return false
    const resource = candidates[this.randomInt(0, candidates.length - 1)]
    const config = this.config.resources.nodes[resource.id]
    const item = this.config.items[config.itemId]
    if (!item) return false
    if (inventoryWeight(bot.inventory, this.config) + item.weight > this.config.player.carryCapacity) {
      return false
    }
    const staminaCost = config.staminaCost
    if (bot.stamina < staminaCost) return false

    const beforeNodes = resource.available
    const quantity = this.randomInt(config.yieldRange.min, config.yieldRange.max)
    resource.available -= 1
    resource.lastGatherAt = this.state.time
    if (resource.available === 0) {
      resource.nextRespawnAt = roundSeconds(this.state.time + config.respawnSeconds)
    }
    bot.inventory[config.itemId] = (bot.inventory[config.itemId] ?? 0) + quantity
    bot.stamina = Math.max(0, bot.stamina - staminaCost)
    this.state.stats.botGathers += 1
    this.state.stats.botItemsGathered += quantity

    this.emit(
      {
        time: this.state.time,
        type: 'bot.gather',
        actor: { type: 'bot', id: bot.id, displayName: bot.displayName },
        item: config.itemId,
        quantity,
        price: null,
        before: { stock: beforeNodes, cash: bot.cash, bid: null, ask: null },
        after: { stock: resource.available, cash: bot.cash, bid: null, ask: null },
        reasons: [
          {
            code: 'work',
            label: 'Bot work shift',
            value: quantity,
            effect: 0,
            detail: `${config.displayName} for ${staminaCost} stamina`,
          },
        ],
        cause: 'gather',
        causeId: `bot-work-${bot.id}-${this.state.sequence + 1}`,
        message: `${bot.displayName} worked ${config.displayName} and gathered ${quantity} ${item.displayName}.`,
      },
      events,
    )
    return true
  }

  /**
   * Bots may deliver to guild orders. This is the only automated order path:
   * player accept/fulfill remains unchanged and player-accepted orders are
   * never touched by bots.
   */
  private tryBotOrder(bot: BotRuntimeState, events: SequencedMarketEvent[]): boolean {
    const participation = this.config.orders.botParticipation
    if (!participation.enabled) return false
    const candidates = this.state.orders
      .filter(
        order =>
          order.status === 'open' &&
          order.expiresAt > this.state.time &&
          Boolean(this.config.items[order.itemId]) &&
          (bot.inventory[order.itemId] ?? 0) > 0,
      )
      .sort((left, right) => stableCompare(left.id, right.id))
    if (candidates.length === 0) return false

    const order = candidates[this.randomInt(0, candidates.length - 1)]
    const available = Math.min(
      Math.floor(bot.inventory[order.itemId] ?? 0),
      order.remaining,
      participation.maxUnitsPerDelivery,
    )
    if (available <= 0) return false
    const count = this.randomInt(1, available)
    const item = this.config.items[order.itemId]
    const paid = roundMoney(order.unitReward * count, this.config)
    const beforeStock = bot.inventory[order.itemId] ?? 0
    const beforeCash = bot.cash

    bot.inventory[order.itemId] = Math.max(0, beforeStock - count)
    bot.cash = roundMoney(bot.cash + paid, this.config)
    order.remaining -= count
    order.updatedAt = this.state.time
    if (order.remaining === 0) {
      order.status = 'fulfilled'
      order.fulfilledAt = this.state.time
    }

    this.state.stats.ordersFulfilled += count
    this.state.stats.orderUnits += count
    this.state.stats.orderPayouts = roundMoney(this.state.stats.orderPayouts + paid, this.config)
    this.state.stats.sources.orderPayouts = roundMoney(
      this.state.stats.sources.orderPayouts + paid,
      this.config,
    )
    this.state.daily.orders.fulfilled += count
    this.state.daily.orders.units += count
    this.state.daily.orders.payouts = roundMoney(
      this.state.daily.orders.payouts + paid,
      this.config,
    )

    this.emit(
      {
        time: this.state.time,
        type: 'order.fulfilled',
        actor: { type: 'bot', id: bot.id, displayName: bot.displayName },
        item: order.itemId,
        quantity: count,
        price: order.unitReward,
        before: { stock: beforeStock, cash: beforeCash, bid: null, ask: null },
        after: { stock: bot.inventory[order.itemId] ?? 0, cash: bot.cash, bid: null, ask: null },
        reasons: [
          {
            code: 'order',
            label: 'Bot order delivery',
            value: count,
            effect: paid,
            detail: `${order.remaining} unit(s) left for ${order.issuer}`,
          },
        ],
        cause: 'order',
        causeId: order.id,
        message: `${bot.displayName} delivered ${count} ${item?.displayName ?? order.itemId} to ${order.issuer} for ${this.money(paid)}.`,
      },
      events,
    )
    return true
  }

  private tryBotTrade(
    bot: BotRuntimeState,
    side: TradeSide,
    events: SequencedMarketEvent[],
  ): boolean {
    const candidates: Array<{ merchant: MerchantRuntimeState; itemId: ItemId }> = []
    for (const merchant of Object.values(this.state.merchants)) {
      if (!merchant.open) continue
      const merchantConfig = this.config.merchants[merchant.id]
      const items = side === 'buy' ? merchantConfig.sells : merchantConfig.buys
      for (const itemId of [...items].sort(stableCompare)) {
        if (side === 'sell' && (bot.inventory[itemId] ?? 0) <= 0) continue
        if (side === 'buy' && bot.cash <= 0) continue
        candidates.push({ merchant, itemId })
      }
    }
    if (candidates.length === 0) return false

    const start = this.randomInt(0, candidates.length - 1)
    const attempts = Math.min(
      this.config.bots.behavior.maxTradeAttempts,
      candidates.length,
    )
    const pseudoPlayer: PlayerEconomyState = {
      id: bot.id,
      cash: bot.cash,
      inventory: bot.inventory,
      stamina: bot.stamina,
      maxStamina: bot.maxStamina,
    }
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const candidate = candidates[(start + attempt) % candidates.length]
      const merchantConfig = this.config.merchants[candidate.merchant.id]
      const offers = side === 'buy' ? merchantConfig.sells : merchantConfig.buys
      if (!offers.includes(candidate.itemId)) continue
      const available =
        side === 'sell'
          ? Math.min(
              this.config.bots.behavior.maxTradeQuantity,
              bot.inventory[candidate.itemId] ?? 0,
            )
          : this.config.bots.behavior.maxTradeQuantity
      if (available <= 0) continue
      const requested = this.randomInt(1, available)
      const result = quote(
        candidate.merchant,
        candidate.itemId,
        side,
        requested,
        this.marketFor(pseudoPlayer),
        this.config,
      )
      if (!result.canTrade) continue

      const fill = result.fillQuantity
      const total = result.total
      const tax = this.taxFor(side, total)
      const beforeBand = this.priceBand(candidate.merchant, candidate.itemId)
      const beforeStock = candidate.merchant.stock[candidate.itemId] ?? 0
      const beforeCash = candidate.merchant.cash

      if (side === 'buy') {
        bot.cash = roundMoney(bot.cash - total, this.config)
        candidate.merchant.cash = roundMoney(candidate.merchant.cash + total - tax, this.config)
        candidate.merchant.stock[candidate.itemId] = beforeStock - fill
        bot.inventory[candidate.itemId] = (bot.inventory[candidate.itemId] ?? 0) + fill
        this.updateDemand(candidate.merchant, candidate.itemId, fill)
      } else {
        bot.cash = roundMoney(bot.cash + total, this.config)
        candidate.merchant.cash = roundMoney(candidate.merchant.cash - total, this.config)
        candidate.merchant.stock[candidate.itemId] = beforeStock + fill
        bot.inventory[candidate.itemId] = Math.max(
          0,
          (bot.inventory[candidate.itemId] ?? 0) - fill,
        )
      }
      if (tax > 0) this.recordSink('salesTax', tax)

      bot.trades += 1
      this.state.stats.botTrades += 1
      this.state.stats.tradeVolume += fill
      this.state.stats.tradeValue = roundMoney(this.state.stats.tradeValue + total, this.config)
      this.state.daily.botTrades += 1
      this.state.daily.trades.buys += side === 'buy' ? fill : 0
      this.state.daily.trades.sells += side === 'sell' ? fill : 0
      this.state.daily.trades.volume += fill
      this.state.daily.trades.value = roundMoney(
        this.state.daily.trades.value + total,
        this.config,
      )
      candidate.merchant.lastTradeAt = this.state.time
      const afterBand = this.priceBand(candidate.merchant, candidate.itemId)
      const item = this.config.items[candidate.itemId]

      this.emit(
        {
          time: this.state.time,
          type: 'bot.trade',
          actor: { type: 'bot', id: bot.id, displayName: bot.displayName },
          item: candidate.itemId,
          quantity: fill,
          price: result.unitPrice,
          before: {
            stock: beforeStock,
            cash: beforeCash,
            bid: beforeBand.bid,
            ask: beforeBand.ask,
          },
          after: {
            stock: candidate.merchant.stock[candidate.itemId] ?? 0,
            cash: candidate.merchant.cash,
            bid: afterBand.bid,
            ask: afterBand.ask,
          },
          reasons: result.reasons,
          cause: 'trade',
          causeId: `bot-${bot.id}-${this.state.sequence + 1}`,
          message:
            side === 'buy'
              ? `${bot.displayName} bought ${fill} ${item?.displayName ?? candidate.itemId} from ${candidate.merchant.displayName} for ${this.money(total)}.`
              : `${bot.displayName} sold ${fill} ${item?.displayName ?? candidate.itemId} to ${candidate.merchant.displayName} for ${this.money(total)}.`,
        },
        events,
      )
      this.detectBankruptcy(candidate.merchant, events)
      return true
    }
    return false
  }

  private runCaravan(events: SequencedMarketEvent[]): void {
    const config = this.config.caravan
    const beforeCash = totalMerchantCash(this.state)
    const beforeStock = totalStockOf(this.state)
    let unitsSold = 0
    let unitsBought = 0
    let cashIn = 0
    let cashOut = 0

    for (const good of config.goods) {
      const item = this.config.items[good.itemId]
      if (!item) continue
      const quantity = this.randomInt(good.quantityRange.min, good.quantityRange.max)
      const candidates = Object.values(this.state.merchants)
        .filter(merchant => merchant.open && this.config.merchants[merchant.id].buys.includes(good.itemId))
        .sort((left, right) => stableCompare(left.id, right.id))
      if (candidates.length === 0) continue
      const merchant = candidates[this.randomInt(0, candidates.length - 1)]
      const result = quote(
        merchant,
        good.itemId,
        'sell',
        quantity,
        this.marketFor(),
        this.config,
      )
      if (!result.canTrade) continue
      const biasedPrice = roundMoney(result.unitPrice * config.priceBias.ask, this.config)
      const budget = Math.max(0, merchant.cash - merchant.reserve)
      const maxByCash = biasedPrice > 0 ? Math.floor((budget + 1e-9) / biasedPrice) : 0
      const fill = Math.min(result.fillQuantity, maxByCash)
      if (fill <= 0) continue
      const total = roundMoney(fill * biasedPrice, this.config)
      merchant.cash = roundMoney(merchant.cash - total, this.config)
      merchant.stock[good.itemId] = (merchant.stock[good.itemId] ?? 0) + fill
      merchant.lastTradeAt = this.state.time
      unitsSold += fill
      cashIn = roundMoney(cashIn + total, this.config)
    }

    const buyGood =
      config.goods.length > 0
        ? config.goods[this.randomInt(0, config.goods.length - 1)]
        : undefined
    if (buyGood) {
      const quantity = this.randomInt(buyGood.quantityRange.min, buyGood.quantityRange.max)
      const candidates = Object.values(this.state.merchants)
        .filter(
          merchant =>
            merchant.open &&
            this.config.merchants[merchant.id].sells.includes(buyGood.itemId) &&
            (merchant.stock[buyGood.itemId] ?? 0) > 0,
        )
        .sort((left, right) => stableCompare(left.id, right.id))
      if (candidates.length > 0) {
        const merchant = candidates[this.randomInt(0, candidates.length - 1)]
        const result = quote(
          merchant,
          buyGood.itemId,
          'buy',
          quantity,
          this.marketFor(),
          this.config,
        )
        if (result.canTrade) {
          const biasedPrice = roundMoney(result.unitPrice * config.priceBias.bid, this.config)
          const fill = result.fillQuantity
          const total = roundMoney(fill * biasedPrice, this.config)
          merchant.cash = roundMoney(merchant.cash + total, this.config)
          merchant.stock[buyGood.itemId] = Math.max(
            0,
            (merchant.stock[buyGood.itemId] ?? 0) - fill,
          )
          merchant.lastTradeAt = this.state.time
          this.updateDemand(merchant, buyGood.itemId, fill)
          unitsBought += fill
          cashOut = roundMoney(cashOut + total, this.config)
        }
      }
    }

    this.state.caravan.arrivals += 1
    this.state.caravan.lastArrivalAt = this.state.time
    this.state.caravan.nextArrivalAt = roundSeconds(this.state.time + config.intervalSeconds)
    this.state.stats.caravanArrivals += 1
    this.state.stats.caravanUnitsSold += unitsSold
    this.state.stats.caravanUnitsBought += unitsBought
    this.state.stats.caravanCashIn = roundMoney(this.state.stats.caravanCashIn + cashIn, this.config)
    this.state.stats.caravanCashOut = roundMoney(this.state.stats.caravanCashOut + cashOut, this.config)
    this.state.daily.caravan.arrivals += 1
    this.state.daily.caravan.unitsSold += unitsSold
    this.state.daily.caravan.unitsBought += unitsBought
    this.state.daily.caravan.cashIn = roundMoney(this.state.daily.caravan.cashIn + cashIn, this.config)
    this.state.daily.caravan.cashOut = roundMoney(this.state.daily.caravan.cashOut + cashOut, this.config)

    this.emit(
      {
        time: this.state.time,
        type: 'caravan.arrival',
        actor: { type: 'caravan', id: 'caravan', displayName: 'External caravan' },
        item: null,
        quantity: unitsSold + unitsBought,
        price: null,
        before: { stock: beforeStock, cash: beforeCash, bid: null, ask: null },
        after: {
          stock: totalStockOf(this.state),
          cash: totalMerchantCash(this.state),
          bid: null,
          ask: null,
        },
        reasons: [
          {
            code: 'caravan-sell',
            label: 'Caravan sold into town',
            value: unitsSold,
            effect: -cashIn,
            detail: `Ask bias ${config.priceBias.ask}; merchants paid ${this.money(cashIn)}`,
          },
          {
            code: 'caravan-buy',
            label: 'Caravan bought from town',
            value: unitsBought,
            effect: cashOut,
            detail: `Bid bias ${config.priceBias.bid}; merchants received ${this.money(cashOut)}`,
          },
        ],
        cause: 'caravan',
        causeId: `caravan-${this.state.caravan.arrivals}`,
        message: `Caravan arrived: sold ${unitsSold} unit(s) into town for ${this.money(cashIn)} and bought ${unitsBought} unit(s) for ${this.money(cashOut)}.`,
      },
      events,
    )

    for (const merchant of Object.values(this.state.merchants)) {
      this.detectBankruptcy(merchant, events)
    }
  }

  private expireOrders(events: SequencedMarketEvent[]): void {
    for (const order of this.state.orders) {
      if (
        (order.status === 'open' || order.status === 'accepted') &&
        order.expiresAt <= this.state.time
      ) {
        order.status = 'expired'
        order.updatedAt = this.state.time
        this.emit(
          {
            time: this.state.time,
            type: 'order.expired',
            actor: { type: 'system', id: 'order-board', displayName: 'Order board' },
            item: order.itemId,
            quantity: order.remaining,
            price: order.unitReward,
            before: EMPTY_SNAPSHOT(),
            after: EMPTY_SNAPSHOT(),
            reasons: [
              {
                code: 'expiry',
                label: 'Order expired',
                value: this.state.time - order.expiresAt,
                effect: 0,
                detail: order.issuer,
              },
            ],
            cause: 'order',
            causeId: order.id,
            message: `${order.issuer}'s order for ${order.remaining} ${this.config.items[order.itemId]?.displayName ?? order.itemId} expired.`,
          },
          events,
        )
      }
    }
  }

  private closeDay(day: number, events: SequencedMarketEvent[]): void {
    const daily = this.state.daily
    const config = this.config

    if (day > config.sinks.stallRent.graceDays) {
      for (const merchant of Object.values(this.state.merchants).sort((a, b) =>
        stableCompare(a.id, b.id),
      )) {
        if (!merchant.open) continue
        const beforeCash = merchant.cash
        const charge = Math.min(merchant.cash, config.sinks.stallRent.amountPerDay)
        if (charge <= 0) continue
        merchant.cash = roundMoney(merchant.cash - charge, config)
        this.recordSink('rent', charge)
        this.emit(
          {
            time: this.state.time,
            type: 'sink.rent',
            actor: { type: 'merchant', id: merchant.id, displayName: merchant.displayName },
            item: null,
            quantity: null,
            price: charge,
            before: { stock: totalStock(merchant), cash: beforeCash, bid: null, ask: null },
            after: { stock: totalStock(merchant), cash: merchant.cash, bid: null, ask: null },
            reasons: [
              {
                code: 'rent',
                label: 'Daily stall rent',
                value: charge,
                effect: -charge,
                detail: `Day ${day}`,
              },
            ],
            cause: 'rent',
            causeId: `rent-${merchant.id}-${day}`,
            message: `${merchant.displayName} paid ${this.money(charge)} stall rent for day ${day}.`,
          },
          events,
        )
      }
    }

    for (const merchant of Object.values(this.state.merchants)) {
      if (!merchant.open || merchant.bankrupt) continue
      const active = this.state.investments.filter(
        investment =>
          investment.merchantId === merchant.id && investment.status === 'active',
      )
      if (active.length === 0) continue
      const profit = merchant.cash - merchant.cashAtDayStart
      if (profit <= 0) continue
      let pool = roundMoney(profit * config.investments.profitShareRate, config)
      pool = Math.min(pool, Math.max(0, merchant.cash - merchant.reserve))
      if (pool < config.investments.minDistribution) continue
      const invested = active.reduce((sum, investment) => sum + investment.amount, 0)
      if (invested <= 0) continue
      const beforeCash = merchant.cash
      merchant.cash = roundMoney(merchant.cash - pool, config)
      this.state.stats.investmentDistributions = roundMoney(
        this.state.stats.investmentDistributions + pool,
        config,
      )

      let remaining = pool
      active.forEach((investment, index) => {
        const amount =
          index === active.length - 1
            ? remaining
            : roundMoney((pool * investment.amount) / invested, config)
        remaining = roundMoney(remaining - amount, config)
        if (amount <= 0) return
        const player = this.state.players[investment.playerId]
        if (player) player.cash = roundMoney(player.cash + amount, config)
        investment.totalDistributed = roundMoney(
          investment.totalDistributed + amount,
          config,
        )
        investment.distributions.push({
          day,
          time: this.state.time,
          amount,
          receipt: `Day ${day} profit share from ${merchant.displayName}`,
        })
        this.emit(
          {
            time: this.state.time,
            type: 'merchant.distribution',
            actor: {
              type: 'player',
              id: investment.playerId,
              displayName: player?.displayName,
            },
            item: null,
            quantity: null,
            price: amount,
            before: {
              stock: totalStock(merchant),
              cash: beforeCash,
              bid: null,
              ask: null,
            },
            after: {
              stock: totalStock(merchant),
              cash: merchant.cash,
              bid: null,
              ask: null,
            },
            reasons: [
              {
                code: 'distribution',
                label: 'Investment distribution',
                value: amount,
                effect: amount,
                detail: `${merchant.displayName} paid ${config.investments.profitShareRate * 100}% of positive profit`,
              },
            ],
            cause: 'investment',
            causeId: investment.id,
            message: `${merchant.displayName} paid ${this.money(amount)} to ${player?.displayName ?? investment.playerId}.`,
          },
          events,
        )
      })
    }

    for (const merchant of Object.values(this.state.merchants)) {
      if (!merchant.open || merchant.bankrupt || merchant.cash <= merchant.reserve) continue
      const target = merchant.reserve * config.cashRecovery.targetReserveMultiple
      if (merchant.cash >= target) continue
      const credit = roundMoney(
        Math.min(
          target - merchant.cash,
          merchant.reserve * config.cashRecovery.dailyRate,
        ),
        config,
      )
      if (credit <= 0) continue
      const beforeCash = merchant.cash
      merchant.cash = roundMoney(merchant.cash + credit, config)
      this.state.stats.sources.merchantRecovery = roundMoney(
        this.state.stats.sources.merchantRecovery + credit,
        config,
      )
      this.emit(
        {
          time: this.state.time,
          type: 'merchant.recovery',
          actor: { type: 'merchant', id: merchant.id, displayName: merchant.displayName },
          item: null,
          quantity: null,
          price: credit,
          before: { stock: totalStock(merchant), cash: beforeCash, bid: null, ask: null },
          after: { stock: totalStock(merchant), cash: merchant.cash, bid: null, ask: null },
          reasons: [
            {
              code: 'cash-recovery',
              label: 'Local cash recovery',
              value: credit,
              effect: credit,
              detail: `Target ${this.money(target)}`,
            },
          ],
          cause: 'restock',
          causeId: `recovery-${merchant.id}-${day}`,
          message: `${merchant.displayName} recovered ${this.money(credit)} of local trading cash.`,
        },
        events,
      )
    }

    for (const merchant of Object.values(this.state.merchants)) {
      this.detectBankruptcy(merchant, events)
    }

    const currentPrices = this.capturePriceSnapshot()
    const movers: PriceMover[] = []
    for (const [key, open] of Object.entries(daily.priceSnapshot)) {
      const close = currentPrices[key]
      if (!close) continue
      const openPrice = open.ask ?? open.bid
      const closePrice = close.ask ?? close.bid
      if (openPrice === null || closePrice === null || openPrice <= 0) continue
      const separator = key.indexOf(':')
      const merchantId = key.slice(0, separator)
      const itemId = key.slice(separator + 1)
      movers.push({
        merchantId,
        itemId,
        open: openPrice,
        close: closePrice,
        changePct: ((closePrice - openPrice) / openPrice) * 100,
      })
    }
    movers.sort((left, right) => {
      const difference = Math.abs(right.changePct) - Math.abs(left.changePct)
      if (difference !== 0) return difference
      const merchantOrder = stableCompare(left.merchantId, right.merchantId)
      if (merchantOrder !== 0) return merchantOrder
      return stableCompare(left.itemId, right.itemId)
    })

    const summary: DaySummary = {
      day,
      startedAt: daily.startedAt,
      endedAt: this.state.time,
      merchantCash: Object.fromEntries(
        Object.entries(this.state.merchants)
          .sort(([left], [right]) => stableCompare(left, right))
          .map(([id, merchant]) => [id, merchant.cash]),
      ),
      playerCash: Object.fromEntries(
        Object.entries(this.state.players)
          .sort(([left], [right]) => stableCompare(left, right))
          .map(([id, player]) => [id, player.cash]),
      ),
      totalMerchantCash: totalMerchantCash(this.state),
      totalPlayerCash: totalPlayerCash(this.state),
      trades: cloneJson(daily.trades),
      botTrades: daily.botTrades,
      bankruptcies: [...daily.bankruptcies].sort(stableCompare),
      investments: cloneJson(daily.investments),
      caravan: cloneJson(daily.caravan),
      sinks: cloneJson(daily.sinks),
      orders: cloneJson(daily.orders),
      topMovers: movers.slice(0, Math.max(1, Math.floor(config.reporting.topMovers))),
    }
    this.state.summaries.push(summary)
    const retention = Math.max(
      1,
      Math.floor(config.reporting.summaryRetentionDays),
    )
    if (this.state.summaries.length > retention) {
      this.state.summaries.splice(0, this.state.summaries.length - retention)
    }
  }

  private startDay(day: number, events: SequencedMarketEvent[]): void {
    for (const merchant of Object.values(this.state.merchants)) {
      merchant.cashAtDayStart = merchant.cash
    }
    this.state.daily = this.buildDailyAccumulator(day, this.state.time)
    if ((day - 1) % this.config.orders.cadenceDays === 0) {
      this.generateOrders(events)
    }
  }

  private buildDailyAccumulator(day: number, startedAt: number): DailyAccumulator {
    return {
      day,
      startedAt,
      merchantCashStart: Object.fromEntries(
        Object.entries(this.state.merchants)
          .sort(([left], [right]) => stableCompare(left, right))
          .map(([id, merchant]) => [id, merchant.cash]),
      ),
      playerCashStart: Object.fromEntries(
        Object.entries(this.state.players)
          .sort(([left], [right]) => stableCompare(left, right))
          .map(([id, player]) => [id, player.cash]),
      ),
      priceSnapshot: this.capturePriceSnapshot(),
      trades: emptyTradeTotals(),
      botTrades: 0,
      bankruptcies: [],
      investments: { count: 0, amount: 0 },
      caravan: emptyCaravanTotals(),
      sinks: emptySinkTotals(),
      orders: emptyOrderTotals(),
    }
  }

  private generateOrders(events?: SequencedMarketEvent[]): void {
    const config = this.config.orders
    const active = this.state.orders.filter(
      order => order.status === 'open' || order.status === 'accepted',
    )
    let remainingSlots = Math.max(0, config.maxActive - active.length)
    if (remainingSlots === 0) return

    while (remainingSlots > 0) {
      const activeTemplateIds = new Set(
        this.state.orders
          .filter(order => order.status === 'open' || order.status === 'accepted')
          .map(order => order.templateId),
      )
      const candidates = config.templates.filter(
        template => !activeTemplateIds.has(template.id),
      )
      const pool = candidates.length > 0 ? candidates : config.templates
      const template = pool[this.randomInt(0, pool.length - 1)]
      const quantity = this.randomInt(
        template.quantityRange.min,
        template.quantityRange.max,
      )
      const item = this.config.items[template.itemId]
      if (!item) break
      const multiplier =
        this.randomInt(
          Math.ceil(config.rewardMultiplier.min * 100),
          Math.floor(config.rewardMultiplier.max * 100),
        ) / 100
      const unitReward = Math.max(
        this.config.pricing.clamps.minUnitPrice,
        roundMoney(item.baseValue * multiplier, this.config),
      )
      const id = `ord_${stableHash64(
        `${this.state.seed}:${this.state.sequence + 1}:${template.id}:${quantity}:${unitReward}`,
      )}`
      const order: OrderState = {
        id,
        templateId: template.id,
        issuer: template.issuer,
        itemId: template.itemId,
        quantity,
        remaining: quantity,
        unitReward,
        currencySymbol: this.config.currency.symbol,
        createdAt: this.state.time,
        dayCreated: this.state.day,
        expiresAt: roundSeconds(this.state.time + config.expiryDays * 86400),
        status: 'open',
        updatedAt: this.state.time,
      }
      this.state.orders.push(order)
      this.state.stats.ordersCreated += 1
      this.state.daily.orders.created += 1
      this.emit(
        {
          time: this.state.time,
          type: 'order.created',
          actor: { type: 'system', id: 'order-board', displayName: 'Order board' },
          item: order.itemId,
          quantity: order.quantity,
          price: order.unitReward,
          before: EMPTY_SNAPSHOT(),
          after: { stock: null, cash: null, bid: null, ask: null },
          reasons: [
            {
              code: 'order',
              label: 'Bulk order posted',
              value: order.quantity,
              effect: 0,
              detail: `${order.issuer} pays ${this.money(order.unitReward)} per unit`,
            },
          ],
          cause: 'order',
          causeId: order.id,
          message: `${order.issuer} posted an order for ${order.quantity} ${item.displayName} at ${this.money(order.unitReward)} each.`,
        },
        events,
      )
      remainingSlots -= 1
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Shared helpers                                                         */
  /* ---------------------------------------------------------------------- */

  private marketFor(player?: PlayerEconomyState): MarketState {
    return {
      time: this.state.time,
      day: this.state.day,
      seed: this.state.seed,
      merchants: this.state.merchants,
      ...(player ? { player } : {}),
    }
  }

  private priceBand(
    merchant: MerchantRuntimeState,
    itemId: ItemId,
  ): { bid: number | null; ask: number | null } {
    const merchantConfig = this.config.merchants[merchant.id]
    const market = this.marketFor()
    const bid = merchantConfig?.buys.includes(itemId)
      ? quote(merchant, itemId, 'sell', 1, market, this.config).unitPrice
      : null
    const ask = merchantConfig?.sells.includes(itemId)
      ? quote(merchant, itemId, 'buy', 1, market, this.config).unitPrice
      : null
    return { bid, ask }
  }

  private capturePriceSnapshot(): Record<string, { bid: number | null; ask: number | null }> {
    const snapshot: Record<string, { bid: number | null; ask: number | null }> = {}
    // Sort merchants and items so the key order is stable regardless of how a
    // loaded snapshot happened to order merchant object keys.
    const merchants = Object.values(this.state.merchants).sort((left, right) =>
      stableCompare(left.id, right.id),
    )
    for (const merchant of merchants) {
      const merchantConfig = this.config.merchants[merchant.id]
      if (!merchantConfig) continue
      const itemIds = Array.from(
        new Set([...merchantConfig.buys, ...merchantConfig.sells]),
      ).sort(stableCompare)
      for (const itemId of itemIds) {
        snapshot[`${merchant.id}:${itemId}`] = this.priceBand(merchant, itemId)
      }
    }
    return snapshot
  }

  private updateDemand(
    merchant: MerchantRuntimeState,
    itemId: ItemId,
    units: number,
  ): void {
    const alpha = this.config.pricing.demand.emaAlpha
    const previous = merchant.demandEma[itemId] ?? 0
    merchant.demandEma[itemId] = previous + alpha * (units - previous)
  }

  private detectBankruptcy(
    merchant: MerchantRuntimeState,
    events: SequencedMarketEvent[],
  ): void {
    if (!merchant.open) return
    if (!isMerchantBankrupt(merchant, this.config)) return
    const beforeCash = merchant.cash
    const beforeStock = totalStock(merchant)
    const beforeBand = this.priceBand(merchant, Object.keys(merchant.targetStock)[0] ?? '')
    merchant.open = false
    merchant.bankrupt = true
    merchant.bankruptAt = this.state.time
    this.state.stats.bankruptcies += 1
    if (!this.state.daily.bankruptcies.includes(merchant.id)) {
      this.state.daily.bankruptcies.push(merchant.id)
    }
    this.emit(
      {
        time: this.state.time,
        type: 'merchant.bankrupt',
        actor: { type: 'merchant', id: merchant.id, displayName: merchant.displayName },
        item: null,
        quantity: null,
        price: null,
        before: {
          stock: beforeStock,
          cash: beforeCash,
          bid: beforeBand.bid,
          ask: beforeBand.ask,
        },
        after: {
          stock: totalStock(merchant),
          cash: merchant.cash,
          bid: beforeBand.bid,
          ask: beforeBand.ask,
        },
        reasons: [
          {
            code: 'cash',
            label: 'Cash below reserve',
            value: merchant.cash,
            effect: 0,
            detail: `Reserve ${this.money(merchant.reserve)}, threshold ${this.money(
              merchant.reserve * this.config.pricing.cash.bankruptcyRatio,
            )}`,
          },
        ],
        cause: 'bankruptcy',
        causeId: `bankrupt-${merchant.id}-${this.state.sequence + 1}`,
        message: `${merchant.displayName} ran out of cash and closed the stall until invested.`,
      },
      events,
    )
  }

  private taxFor(side: TradeSide, total: number): number {
    const tax = this.config.sinks.salesTax
    if (tax.rate <= 0) return 0
    if (side === 'buy' && tax.appliesTo === 'merchant') {
      return roundMoney(total * tax.rate, this.config)
    }
    if (side === 'sell' && tax.appliesTo === 'player') {
      return roundMoney(total * tax.rate, this.config)
    }
    return 0
  }

  private recordSink(kind: 'rent' | 'salesTax' | 'repairs' | 'shocks', amount: number): void {
    if (amount <= 0) return
    this.state.stats.sinks[kind] = roundMoney(this.state.stats.sinks[kind] + amount, this.config)
    this.state.stats.sinks.total = roundMoney(
      this.state.stats.sinks.total + amount,
      this.config,
    )
    this.state.daily.sinks[kind] = roundMoney(
      this.state.daily.sinks[kind] + amount,
      this.config,
    )
    this.state.daily.sinks.total = roundMoney(
      this.state.daily.sinks.total + amount,
      this.config,
    )
  }

  private carryFree(player: PlayerRuntimeState): number {
    return Math.max(
      0,
      this.config.player.carryCapacity - inventoryWeight(player.inventory, this.config),
    )
  }

  private tradeBlockedMessage(quoteResult: Quote, side: TradeSide): string {
    const reason = quoteResult.blockedReason ?? 'trade_blocked'
    const descriptions: Record<string, string> = {
      merchant_closed: 'Merchant is closed',
      merchant_below_reserve: 'Merchant is below its reserve',
      out_of_stock: 'Merchant is out of stock',
      merchant_cash_exhausted: 'Merchant cannot afford this purchase',
      insufficient_player_cash: 'Player does not have enough cash',
      insufficient_player_inventory: 'Player does not have enough inventory',
      carry_capacity_exceeded: 'Player carry capacity is full',
      quantity_must_be_positive: 'Quantity must be positive',
      quantity_exceeds_fill_limit: 'Quantity exceeds the fill limit',
      merchant_does_not_sell_item: 'Merchant does not sell that item',
      merchant_does_not_buy_item: 'Merchant does not buy that item',
      unknown_item: 'Unknown item',
      unknown_merchant: 'Unknown merchant',
      fill_unavailable: 'No fill is available',
    }
    return descriptions[reason] ?? `${side} blocked: ${reason}`
  }

  private random(): number {
    const value = this.rng.next()
    this.state.rngState = this.rng.state
    this.state.rngDraws += 1
    return value
  }

  private randomInt(min: number, max: number): number {
    const value = this.rng.int(min, max)
    this.state.rngState = this.rng.state
    this.state.rngDraws += 1
    return value
  }

  private money(value: number): string {
    const decimals = this.config.currency.decimals
    return `${this.config.currency.symbol}${value.toFixed(decimals)}`
  }

  private emit(
    input: Omit<CreateMarketEventInput, 'id'>,
    sink?: SequencedMarketEvent[],
  ): SequencedMarketEvent {
    const sequence = this.state.sequence + 1
    this.state.sequence = sequence
    const event = createMarketEvent({
      ...input,
      id: `evt_${stableHash64(`${this.state.configHash}:${sequence}`)}`,
    })
    const sequenced: SequencedMarketEvent = { ...event, sequence }
    this.state.events.push(sequenced)
    const retention = Math.max(1, Math.floor(this.config.reporting.eventRetention))
    if (this.state.events.length > retention) {
      this.state.events.splice(0, this.state.events.length - retention)
    }
    if (sink) sink.push(sequenced)
    return sequenced
  }

  private success<T>(
    action: string,
    events: SequencedMarketEvent[],
    data?: T,
    playerId?: string,
  ): EconomyActionResult<T> {
    return {
      success: true,
      action,
      playerId,
      data,
      events,
      sequence: this.state.sequence,
    }
  }

  private failure(
    action: string,
    code: string,
    message: string,
    playerId?: string,
  ): EconomyActionResult<never> {
    const error: EconomyActionError = { code, message }
    return {
      success: false,
      action,
      playerId,
      error,
      events: [],
      sequence: this.state.sequence,
    }
  }
}

const roundSeconds = (value: number): number => Math.round(value * 1e6) / 1e6

const roundMoney = (value: number, config: EconomyConfig): number =>
  round(value, config.currency.decimals, config.pricing.rounding.mode)

const totalStockOf = (state: EconomyWorldState): number =>
  Object.values(state.merchants).reduce(
    (sum, merchant) => sum + totalStock(merchant),
    0,
  )

export default EconomyEngine
