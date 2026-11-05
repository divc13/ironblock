import { economy } from '../../config/economy'
import type {
  EconomyConfig,
  ItemId,
  MarketEvent,
  MarketState,
  MerchantId,
  Quote,
  RecipeId,
  ResourceId,
  TradeSide,
} from '../../shared/types'
import { isMerchantBankrupt, quote as sharedQuote } from '../../shared/pricing'
import type {
  EconomyWorldState,
  MerchantRuntimeState,
  PlayerRuntimeState,
  SequencedMarketEvent,
} from '../../shared/economy/types'
import type {
  EconomyCraftResponse,
  EconomyEatResponse,
  EconomyErrorResponse,
  EconomyEventsResponse,
  EconomyFastForwardResponse,
  EconomyGatherResponse,
  EconomyInvestResponse,
  EconomyOrderBoardEntryResponse,
  EconomyRepairResponse,
  EconomySnapshotResponse,
  EconomyTradeResponse,
} from '../../shared/economy/api'
import { NEAR_AUTH_SESSION_STORAGE_KEY } from '../../shared/auth/defaults'
import { FAST_FORWARD_PLAYBACK_MS } from '../../shared/economy/fast-forward'
import { describeEvent, formatDayClock } from '../../ui/format'
import type {
  CraftResult,
  EatResult,
  EconomyClient,
  EconomyMode,
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

/**
 * Server-backed economy client.
 *
 * Every read and action goes through the authenticated `/api/economy` HTTP API.
 * The player id is never sent by this client: the server derives it from the
 * NEAR Auth game session in the `Authorization: Bearer` header.
 */

const DEFAULT_DAY_SECONDS = 86_400
const SNAPSHOT_EVENT_LIMIT = 25

export interface HttpEconomyClientOptions {
  config?: EconomyConfig
  /** Session token captured by the world module at boot. */
  sessionToken?: string | null
  /** Override for tests/hosts. Defaults to the stored NEAR Auth session. */
  tokenProvider?: () => string | null | undefined
  /** Override for tests. Defaults to the app base path. */
  apiBase?: string
  fetchImpl?: typeof fetch
}

export class EconomyApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'EconomyApiError'
  }
}

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value))

const roundMoney = (config: EconomyConfig, value: number): number => {
  const scale = 10 ** config.currency.decimals
  return Math.round(value * scale) / scale
}

/** Build the economy API prefix for the deployed base path. */
export function economyApiPathForBase(baseUrl: string | undefined): string {
  const base = (baseUrl || '/').trim()
  if (!base || base === '.' || base === './') return '/api/economy'
  const normalized = `/${base.replace(/^\/+|\/+$/g, '')}`
  return normalized === '/' ? '/api/economy' : `${normalized}/api/economy`
}

function defaultApiBase(): string {
  const env = (import.meta as ImportMeta & {
    env?: Record<string, string | undefined>
  }).env
  return economyApiPathForBase(env?.BASE_URL)
}

function readStoredSessionToken(): string | undefined {
  if (typeof window === 'undefined') return undefined
  try {
    const raw = window.sessionStorage.getItem(NEAR_AUTH_SESSION_STORAGE_KEY)
    if (!raw) return undefined
    const parsed = JSON.parse(raw) as {
      sessionToken?: unknown
      expiresAt?: unknown
    }
    if (
      typeof parsed.sessionToken !== 'string' ||
      parsed.sessionToken.length <= 40
    ) {
      return undefined
    }
    if (
      typeof parsed.expiresAt !== 'string' ||
      !(Date.parse(parsed.expiresAt) > Date.now())
    ) {
      return undefined
    }
    return parsed.sessionToken
  } catch {
    return undefined
  }
}

function readableError(error: unknown): string {
  if (error instanceof EconomyApiError) return error.message
  if (error instanceof Error) {
    if (/abort|timeout/i.test(error.message)) {
      return 'The market server did not answer in time. Try again.'
    }
    return error.message || 'The market request failed.'
  }
  return 'The market request failed.'
}

function emptyQuote(
  config: EconomyConfig,
  merchantId: MerchantId,
  itemId: ItemId,
  side: TradeSide,
  quantity: number,
): Quote {
  return {
    merchantId,
    itemId,
    side,
    quantity,
    basePrice: config.items[itemId]?.baseValue ?? 0,
    unitPrice: 0,
    total: 0,
    currencySymbol: config.currency.symbol,
    reasons: [],
    canTrade: false,
    fillQuantity: 0,
    maxQuantity: 0,
    partialFill: false,
    merchantOpen: false,
    merchantBankrupt: false,
    constraints: {
      stock: 0,
      merchantCash: 0,
      merchantReserve: 0,
      playerCash: null,
      playerInventory: null,
      playerCarryFree: null,
      maxByStock: 0,
      maxByMerchantCash: null,
      maxByPlayerCash: null,
      maxByPlayerInventory: null,
      maxByCarry: null,
      maxByTradeLimit: 0,
      maxFill: 0,
    },
    blockedReason: 'market_unavailable',
  }
}

export class HttpEconomyClient implements EconomyClient {
  readonly mode: EconomyMode = 'server'
  readonly fastForward: HttpFastForwardClient
  readonly config: EconomyConfig

  private readonly apiBase: string
  private readonly tokenProvider: () => string | null | undefined
  private readonly fetchImpl: typeof fetch
  private readonly listeners = new Set<() => void>()

  private snapshotResponse: EconomySnapshotResponse | null = null
  private snapshotView: EconomySnapshot | null = null
  private lastEvents: SequencedMarketEvent[] = []

  constructor(options: HttpEconomyClientOptions = {}) {
    this.config = options.config ?? economy
    this.apiBase = options.apiBase ?? defaultApiBase()
    const capturedToken = options.sessionToken
    this.tokenProvider =
      options.tokenProvider ??
      (() => readStoredSessionToken() ?? capturedToken ?? undefined)
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis)
    this.fastForward = new HttpFastForwardClient(this)
  }

  /* ----------------------------- transport ------------------------------- */

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = this.tokenProvider()
    if (!token) {
      throw new EconomyApiError(
        401,
        'UNAUTHORIZED',
        'Sign in with NEAR Auth to trade on the live market.',
      )
    }

    const headers: Record<string, string> = {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      ...(init.headers as Record<string, string> | undefined),
    }
    if (init.body !== undefined) headers['content-type'] = 'application/json'

    const response = await this.fetchImpl(`${this.apiBase}${path}`, {
      ...init,
      headers,
      credentials: 'same-origin',
      signal: AbortSignal.timeout(20_000),
    })

    const body = (await response.json().catch(() => undefined)) as unknown
    if (!response.ok) {
      const error = (body as EconomyErrorResponse | undefined)?.error
      throw new EconomyApiError(
        response.status,
        error?.code ?? 'REQUEST_FAILED',
        error?.message ?? `The market request failed (${response.status}).`,
      )
    }
    return body as T
  }

  /* ------------------------------ state ---------------------------------- */

  private notify(): void {
    for (const listener of this.listeners) listener()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Clear cached views. The next read refetches the authoritative world. */
  reset(): void {
    this.snapshotResponse = null
    this.snapshotView = null
    this.lastEvents = []
    this.fastForward.reset()
    this.notify()
  }

  /** Refetch after a mutation and fan out to HUD subscribers. */
  async sync(): Promise<void> {
    try {
      await this.getSnapshot()
    } catch (error) {
      console.warn('[ironblock] economy refresh failed:', readableError(error))
    }
    this.notify()
  }

  /* ------------------------------ reading -------------------------------- */

  async getSnapshot(): Promise<EconomySnapshot> {
    try {
      const response = await this.request<EconomySnapshotResponse>('/snapshot')
      this.snapshotResponse = response
      this.lastEvents = response.events
      this.snapshotView = this.buildSnapshot(response)
      return this.snapshotView
    } catch (error) {
      if (this.snapshotView) {
        console.warn(
          '[ironblock] economy snapshot unavailable; showing last known state:',
          readableError(error),
        )
        return this.snapshotView
      }
      throw error
    }
  }

  private buildSnapshot(response: EconomySnapshotResponse): EconomySnapshot {
    const state = response.state
    const merchants = response.merchants.map(merchant =>
      this.merchantSummary(merchant),
    )
    const openMerchants = merchants.filter(
      merchant => merchant.open && !merchant.bankrupt,
    ).length
    const bankruptcies = merchants.filter(merchant => merchant.bankrupt).length

    return {
      day: state.day,
      time: state.time,
      clock: formatDayClock(state.day, state.time),
      player: this.playerView(response.player),
      merchants,
      openMerchants,
      bankruptcies,
      townHealth: this.townHealth(openMerchants, merchants.length),
      recentEvents: response.events.slice(-SNAPSHOT_EVENT_LIMIT).reverse(),
      orderBoardSupported: true,
    }
  }

  private playerView(player: PlayerRuntimeState | null): PlayerView {
    const fallback: PlayerRuntimeState = {
      id: 'unknown',
      cash: 0,
      inventory: {},
      stamina: this.config.player.stamina.max,
      maxStamina: this.config.player.stamina.max,
      equippedTool: this.config.player.startingTool,
      toolDurability: {},
    }
    const current = player ?? fallback
    const inventory: InventoryLine[] = []

    for (const [itemId, quantity] of Object.entries(current.inventory)) {
      if (quantity <= 0) continue
      const item = this.config.items[itemId]
      if (!item) continue
      const tool: ToolView | undefined = item.tool
        ? {
            itemId,
            displayName: item.displayName,
            durability:
              current.toolDurability?.[itemId] ?? item.tool.maxDurability,
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
        equipped: current.equippedTool === itemId,
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
      cash: current.cash,
      inventory,
      stamina: current.stamina,
      maxStamina: current.maxStamina,
      weight: Math.round(weight * 100) / 100,
      carryCapacity: this.config.player.carryCapacity,
      equippedTool: current.equippedTool ?? null,
      toolDurability: { ...(current.toolDurability ?? {}) },
    }
  }

  private merchantSummary(merchant: MerchantRuntimeState): MerchantSummary {
    const stockEntries = Object.entries(merchant.stock)
    return {
      id: merchant.id,
      displayName: merchant.displayName,
      personality: merchant.personality,
      cash: merchant.cash,
      reserve: merchant.reserve,
      open: merchant.open,
      bankrupt:
        merchant.bankrupt || isMerchantBankrupt(merchant, this.config),
      requiredInvestment: Math.max(
        0,
        Math.ceil(merchant.reserve * 2 - merchant.cash),
      ),
      stockUnits: stockEntries.reduce(
        (sum, [, quantity]) => sum + quantity,
        0,
      ),
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

  private townHealth(open: number, total: number): TownHealth {
    const ratio = open / Math.max(1, total)
    if (ratio >= 1) return 'thriving'
    if (ratio >= 0.75) return 'stable'
    if (ratio >= 0.4) return 'strained'
    return 'critical'
  }

  async getMerchant(id: MerchantId): Promise<MerchantView | null> {
    if (!this.snapshotResponse) {
      await this.getSnapshot().catch(() => undefined)
    }
    const state = this.snapshotResponse?.state.merchants[id]
    const config = this.config.merchants[id]
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
    const params = new URLSearchParams({
      merchantId,
      itemId,
      side,
      quantity: String(Math.max(1, Math.floor(quantity))),
    })

    try {
      return await this.request<Quote>(`/quote?${params.toString()}`)
    } catch (error) {
      const local = this.localQuote(merchantId, itemId, side, quantity)
      if (local) {
        console.warn(
          '[ironblock] quote unavailable; using the last known market state:',
          readableError(error),
        )
        return local
      }
      console.warn(
        '[ironblock] quote unavailable and no market snapshot is cached:',
        readableError(error),
      )
      return emptyQuote(this.config, merchantId, itemId, side, quantity)
    }
  }

  private localQuote(
    merchantId: MerchantId,
    itemId: ItemId,
    side: TradeSide,
    quantity: number,
  ): Quote | null {
    const response = this.snapshotResponse
    const merchant = response?.state.merchants[merchantId]
    const item = this.config.items[itemId]
    if (!response || !merchant || !item) return null

    const market: MarketState = {
      time: response.state.time,
      day: response.state.day,
      seed: response.state.seed,
      merchants: response.state.merchants,
      player: response.player ?? undefined,
    }
    return sharedQuote(
      merchant,
      item,
      side,
      Math.max(0, Math.floor(quantity)),
      market,
      this.config,
    )
  }

  /* ------------------------------ actions -------------------------------- */

  buy(request: TradeRequest): Promise<TradeResult> {
    return this.trade('buy', request)
  }

  sell(request: TradeRequest): Promise<TradeResult> {
    return this.trade('sell', request)
  }

  private async trade(
    side: TradeSide,
    request: TradeRequest,
  ): Promise<TradeResult> {
    const quantity = Math.max(1, Math.floor(request.quantity))
    const quote =
      (await this.getQuote(
        request.merchantId,
        request.itemId,
        side,
        quantity,
      ).catch(() => null)) ??
      emptyQuote(
        this.config,
        request.merchantId,
        request.itemId,
        side,
        quantity,
      )

    try {
      const response = await this.request<EconomyTradeResponse>('/trade', {
        method: 'POST',
        body: JSON.stringify({
          merchantId: request.merchantId,
          itemId: request.itemId,
          side,
          quantity,
        }),
      })
      await this.sync()
      return {
        ok: true,
        message: response.message,
        quote: response.quote,
        fillQuantity: response.fillQuantity,
        total: response.total,
      }
    } catch (error) {
      return {
        ok: false,
        message: readableError(error),
        quote,
        fillQuantity: 0,
        total: 0,
      }
    }
  }

  async gather(resourceId: ResourceId): Promise<GatherResult> {
    const resource = this.config.resources.nodes[resourceId]
    try {
      const response = await this.request<EconomyGatherResponse>('/gather', {
        method: 'POST',
        body: JSON.stringify({ resourceId }),
      })
      await this.sync()
      return {
        ok: true,
        message: response.message,
        itemId: response.itemId,
        quantity: response.quantity,
        staminaSpent: response.staminaSpent,
        durabilityLeft: response.durability,
      }
    } catch (error) {
      return {
        ok: false,
        message: readableError(error),
        itemId: resource?.itemId ?? '',
        quantity: 0,
        staminaSpent: 0,
        durabilityLeft: null,
      }
    }
  }

  async craft(recipeId: RecipeId): Promise<CraftResult> {
    try {
      const response = await this.request<EconomyCraftResponse>('/craft', {
        method: 'POST',
        body: JSON.stringify({ recipeId, quantity: 1 }),
      })
      await this.sync()
      return {
        ok: true,
        message: response.message,
        recipeId,
        outputs: response.outputs,
        staminaSpent: response.staminaSpent,
      }
    } catch (error) {
      return {
        ok: false,
        message: readableError(error),
        recipeId,
        outputs: {},
        staminaSpent: 0,
      }
    }
  }

  async invest(merchantId: MerchantId, amount?: number): Promise<InvestResult> {
    const cached = this.snapshotResponse?.state.merchants[merchantId]
    try {
      const response = await this.request<EconomyInvestResponse>('/invest', {
        method: 'POST',
        body: JSON.stringify({ merchantId, amount }),
      })
      await this.sync()
      return {
        ok: true,
        message: response.message,
        merchantId,
        amount: response.amount,
        merchantCash: response.merchantCash,
        reopened: response.reopened,
      }
    } catch (error) {
      return {
        ok: false,
        message: readableError(error),
        merchantId,
        amount: amount ?? 0,
        merchantCash: cached?.cash ?? 0,
        reopened: false,
      }
    }
  }

  async repair(toolItemId?: ItemId): Promise<RepairResult> {
    try {
      const response = await this.request<EconomyRepairResponse>('/repair', {
        method: 'POST',
        body: JSON.stringify(toolItemId ? { toolItemId } : {}),
      })
      await this.sync()
      return {
        ok: true,
        message: response.message,
        toolItemId: response.toolItemId,
        cost: response.cost,
        durability: response.durability,
      }
    } catch (error) {
      return {
        ok: false,
        message: readableError(error),
        toolItemId: toolItemId ?? null,
        cost: 0,
        durability: null,
      }
    }
  }

  async eat(itemId: ItemId): Promise<EatResult> {
    try {
      const response = await this.request<EconomyEatResponse>('/eat', {
        method: 'POST',
        body: JSON.stringify({ itemId }),
      })
      await this.sync()
      return {
        ok: true,
        message: response.message,
        itemId: response.itemId,
        staminaRestored: response.staminaRestored,
      }
    } catch (error) {
      return {
        ok: false,
        message: readableError(error),
        itemId,
        staminaRestored: 0,
      }
    }
  }

  /* ------------------------------- events -------------------------------- */

  private sequenceForSince(since?: string): number {
    if (!since) return 0
    if (/^\d+$/.test(since)) return Number(since)
    const candidates = [
      ...this.lastEvents,
      ...(this.snapshotView?.recentEvents ?? []),
    ]
    const match = candidates.find(event => event.id === since)
    return match?.sequence ?? 0
  }

  async getEvents(since?: string): Promise<MarketEvent[]> {
    const sequence = this.sequenceForSince(since)
    try {
      const response = await this.request<EconomyEventsResponse>(
        `/events?since=${sequence}`,
      )
      this.lastEvents = response.events
      return response.events
    } catch (error) {
      console.warn(
        '[ironblock] event stream unavailable; using cached events:',
        readableError(error),
      )
      return this.lastEvents
    }
  }

  /* ------------------------- server fast-forward -------------------------- */

  /** @internal used by the fast-forward controller. */
  requestFastForward(days: number): Promise<EconomyFastForwardResponse> {
    return this.request<EconomyFastForwardResponse>('/fast-forward', {
      method: 'POST',
      body: JSON.stringify({ days }),
    })
  }

  async fastForwardDays(days: number): Promise<FastForwardState> {
    return this.fastForward.start(days)
  }

  /* -------------------------------- recap -------------------------------- */

  async getRecap(): Promise<SessionRecap> {
    try {
      return await this.request<SessionRecap>('/recap')
    } catch (error) {
      console.warn(
        '[ironblock] recap unavailable; deriving from cached state:',
        readableError(error),
      )
      return this.fallbackRecap()
    }
  }

  private fallbackRecap(): SessionRecap {
    const snapshot = this.snapshotView
    const merchants = snapshot?.merchants ?? []
    const open = merchants.filter(
      merchant => merchant.open && !merchant.bankrupt,
    ).length
    const bankrupt = merchants.filter(merchant => merchant.bankrupt)
    return {
      headline: snapshot
        ? snapshot.townHealth === 'critical'
          ? 'Market square in crisis as stalls close'
          : snapshot.townHealth === 'strained'
            ? 'Trading thins as cash runs short'
            : 'Ironblock holds a steady market'
        : 'Waiting for the market server',
      standfirst: snapshot
        ? `Last known state: ${open}/${merchants.length} stalls are open and ${bankrupt.length} closed below reserve.`
        : 'The live recap is unavailable until the market server answers.',
      generatedAtDay: snapshot?.day ?? 1,
      topMovers: [],
      trades: { count: 0, buyCount: 0, sellCount: 0, volume: 0, value: 0 },
      bankruptcies: bankrupt.map(merchant => merchant.displayName),
      investments: [],
      caravan: {
        arrivals: 0,
        note: 'Live caravan data is unavailable.',
      },
      sinks: { rent: 0, tax: 0, repairs: 0, total: 0 },
      merchants: {
        open,
        total: merchants.length,
        health: snapshot?.townHealth ?? 'stable',
      },
    }
  }

  /* ------------------------------ order board ----------------------------- */

  async getOrderBoard(): Promise<OrderBoardEntry[]> {
    try {
      const entries = await this.request<EconomyOrderBoardEntryResponse[]>(
        '/orders',
      )
      return entries.map(entry => ({
        id: entry.id,
        side: entry.side,
        merchantId: entry.merchantId,
        merchantName: entry.merchantName,
        itemId: entry.itemId,
        itemName: entry.itemName,
        quantity: entry.quantity,
        unitPrice: entry.unitPrice,
      }))
    } catch (error) {
      console.warn(
        '[ironblock] order board unavailable:',
        readableError(error),
      )
      return []
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Fast-forward                                                               */
/* -------------------------------------------------------------------------- */

const idleFastForwardState = (): FastForwardState => ({
  status: 'idle',
  day: 0,
  totalDays: 0,
  progress: 0,
  days: [],
  events: [],
  recap: null,
  message: 'Ready to simulate a week of town trade on the server.',
  fromTime: 0,
  toTime: 0,
  startDay: 0,
  endDay: 0,
  revealDurationMs: FAST_FORWARD_PLAYBACK_MS,
  worldPlayback: 'server',
})

export interface HttpFastForwardTimingOptions {
  /** Wall-clock reveal length. Defaults to the server playback window. */
  revealDurationMs?: number
  /** Test seams for the reveal clock. */
  now?: () => number
  scheduleInterval?: (callback: () => void, milliseconds: number) => unknown
  cancelInterval?: (handle: unknown) => void
}

interface PendingReveal {
  token: number
  runStart: number
  durationMs: number
  totalDays: number
  fromTime: number
  toTime: number
  startDay: number
  endDay: number
  dayCards: FastForwardDay[]
  events: FastForwardEvent[]
  resolve: (() => void) | null
}

export class HttpFastForwardClient implements FastForwardClient {
  private state: FastForwardState = idleFastForwardState()
  private readonly listeners = new Set<(state: FastForwardState) => void>()
  private running = false
  private runToken = 0
  private pending: PendingReveal | null = null
  private timer: unknown = null

  private readonly revealDurationMs: number
  private readonly now: () => number
  private readonly scheduleInterval: (callback: () => void, milliseconds: number) => unknown
  private readonly cancelInterval: (handle: unknown) => void

  constructor(
    private readonly owner: HttpEconomyClient,
    options: HttpFastForwardTimingOptions = {},
  ) {
    this.revealDurationMs = Math.max(
      1,
      Math.floor(options.revealDurationMs ?? FAST_FORWARD_PLAYBACK_MS),
    )
    this.now = options.now ?? (() => Date.now())
    this.scheduleInterval =
      options.scheduleInterval ??
      ((callback, milliseconds) => setInterval(callback, milliseconds))
    this.cancelInterval =
      options.cancelInterval ??
      (handle => clearInterval(handle as ReturnType<typeof setInterval>))
  }

  onChange(listener: (state: FastForwardState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getState(): FastForwardState {
    return {
      ...this.state,
      days: [...this.state.days],
      events: [...this.state.events],
    }
  }

  reset(): void {
    this.runToken += 1
    this.running = false
    this.cancelReveal()
    this.update(idleFastForwardState())
  }

  private update(state: FastForwardState): void {
    this.state = state
    const snapshot = this.getState()
    for (const listener of this.listeners) listener(snapshot)
  }

  async start(days?: number): Promise<FastForwardState> {
    if (this.running) return this.getState()

    const totalDays = clamp(
      Math.floor(days ?? this.owner.config.fastForward.days),
      1,
      Math.max(1, Math.floor(this.owner.config.fastForward.maxDays)),
    )
    const token = ++this.runToken
    this.running = true
    this.cancelReveal()
    this.update({
      ...idleFastForwardState(),
      status: 'running',
      totalDays,
      recap: this.state.recap,
      message: `Simulating ${totalDays} days on the authoritative server…`,
      revealDurationMs: this.revealDurationMs,
    })

    try {
      const result = await this.owner.requestFastForward(totalDays)
      if (token !== this.runToken) return this.getState()

      const dayCards = this.buildDays(result)
      const events = this.mapEvents(result.events)
      const revealedDays = Math.max(
        1,
        dayCards.length || result.days || totalDays,
      )
      const reveal: PendingReveal = {
        token,
        runStart: this.now(),
        durationMs: this.revealDurationMs,
        totalDays: revealedDays,
        fromTime: result.fromTime,
        toTime: result.toTime,
        startDay: result.startDay,
        endDay:
          result.endDay ??
          result.startDay + revealedDays,
        dayCards,
        events,
        resolve: null,
      }
      this.pending = reveal
      this.publishReveal(reveal, 0)
      await new Promise<void>(resolve => {
        reveal.resolve = resolve
        this.startRevealTimer(reveal)
      })
      if (token !== this.runToken) return this.getState()

      this.pending = null
      // One reconciliation read after the whole reveal, never while the world
      // playback is still in progress.
      await this.owner.sync()
      if (token !== this.runToken) return this.getState()
      const recap = await this.owner.getRecap()
      if (token !== this.runToken) return this.getState()

      this.update({
        status: 'done',
        day: reveal.totalDays,
        totalDays: reveal.totalDays,
        progress: 1,
        days: reveal.dayCards,
        events: reveal.events,
        recap,
        message: `Week complete — ${recap.headline}.`,
        fromTime: reveal.fromTime,
        toTime: reveal.toTime,
        startDay: reveal.startDay,
        endDay: reveal.endDay,
        revealDurationMs: this.revealDurationMs,
        worldPlayback: 'server',
      })
      return this.getState()
    } catch (error) {
      if (token !== this.runToken) return this.getState()
      this.cancelReveal()
      this.update({
        ...idleFastForwardState(),
        recap: this.state.recap,
        totalDays,
        message: readableError(error),
        revealDurationMs: this.revealDurationMs,
      })
      // The POST may have failed after the server committed; reconcile once.
      try {
        await this.owner.sync()
      } catch {
        // Keep the actionable error message from the failed request.
      }
      return this.getState()
    } finally {
      if (token === this.runToken) this.running = false
    }
  }

  private startRevealTimer(reveal: PendingReveal): void {
    this.clearTimer()
    const interval = Math.max(
      10,
      Math.min(100, Math.round(this.revealDurationMs / 40)),
    )
    this.timer = this.scheduleInterval(() => {
      if (this.pending !== reveal || reveal.token !== this.runToken) return
      const elapsed = Math.max(0, this.now() - reveal.runStart)
      const fraction = Math.min(1, elapsed / reveal.durationMs)
      this.publishReveal(reveal, fraction)
      if (fraction >= 1) {
        this.clearTimer()
        const resolve = reveal.resolve
        reveal.resolve = null
        resolve?.()
      }
    }, interval)
  }

  private publishReveal(reveal: PendingReveal, fraction: number): void {
    const completedDays = Math.min(
      reveal.totalDays,
      Math.floor(fraction * reveal.totalDays + 1e-9),
    )
    const revealTime =
      reveal.fromTime + fraction * (reveal.toTime - reveal.fromTime)
    const events =
      fraction >= 1
        ? reveal.events
        : reveal.events.filter(entry => entry.event.time <= revealTime)
    this.update({
      status: 'running',
      day: completedDays,
      totalDays: reveal.totalDays,
      progress: fraction,
      days: reveal.dayCards.slice(0, completedDays),
      events,
      recap: this.state.recap,
      message:
        completedDays >= reveal.totalDays
          ? 'Week complete — updating the live market…'
          : `Fast-forwarding — day ${Math.min(
              reveal.endDay,
              reveal.startDay + completedDays,
            )} of ${reveal.endDay}`,
      fromTime: reveal.fromTime,
      toTime: reveal.toTime,
      startDay: reveal.startDay,
      endDay: reveal.endDay,
      revealDurationMs: this.revealDurationMs,
      worldPlayback: 'server',
    })
  }

  private clearTimer(): void {
    if (this.timer === null) return
    this.cancelInterval(this.timer)
    this.timer = null
  }

  private cancelReveal(): void {
    this.clearTimer()
    const pending = this.pending
    this.pending = null
    if (!pending) return
    const resolve = pending.resolve
    pending.resolve = null
    resolve?.()
  }

  private mapEvents(
    events: readonly SequencedMarketEvent[],
  ): FastForwardEvent[] {
    const seen = new Set<string>()
    const mapped: FastForwardEvent[] = []
    for (const event of events) {
      const key = event.id || String(event.sequence)
      if (seen.has(key)) continue
      seen.add(key)
      mapped.push({
        event,
        day: Math.floor(event.time / DEFAULT_DAY_SECONDS) + 1,
        annotation: describeEvent(event).headline,
      })
    }
    return mapped.sort(
      (left, right) =>
        left.event.time - right.event.time ||
        left.event.sequence - right.event.sequence,
    )
  }

  private buildDays(result: EconomyFastForwardResponse): FastForwardDay[] {
    const totalMerchants = Object.keys(this.owner.config.merchants).length
    let closed = 0
    return result.series.map(point => {
      closed += point.bankruptcies
      const merchantsOpen = Math.max(0, totalMerchants - closed)
      return {
        day: point.day,
        merchantsOpen,
        bankruptcies: point.bankruptcies,
        tradeVolume: point.tradeVolume,
        headline:
          point.bankruptcies > 0
            ? `Day ${point.day}: ${point.bankruptcies} stall${
                point.bankruptcies === 1 ? '' : 's'
              } closed below reserve`
            : `Day ${point.day}: ${merchantsOpen} stalls trading`,
      }
    })
  }

  pause(): void {
    if (this.state.status !== 'running') return
    this.update({
      ...this.state,
      message:
        'The server simulates the requested days in one pass; pause is not available.',
    })
  }

  async resume(): Promise<FastForwardState> {
    return this.getState()
  }

  async step(): Promise<FastForwardState> {
    if (this.state.status === 'running') return this.getState()
    return this.start(1)
  }

  skip(): void {
    const reveal = this.pending
    if (!reveal) return
    this.clearTimer()
    this.publishReveal(reveal, 1)
    const resolve = reveal.resolve
    reveal.resolve = null
    resolve?.()
  }
}
