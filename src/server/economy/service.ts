import { EconomyEngine, fingerprintConfig } from '../../shared/economy'
import type {
  EconomyActionResult,
  EconomyFastForwardResult,
  EconomyServiceOptions,
  EconomyStore,
  EconomyWorldState,
  PlayerRuntimeState,
  SequencedMarketEvent,
  SpectatorSnapshot,
  TickActionData,
  TradeActionData,
  WithdrawActionData,
} from '../../shared/economy'
import type { EconomyConfig, ItemId, MerchantId, Quote, TradeSide } from '../../shared/types'
import { JsonEconomyStore } from './persistence'

export type EconomyLoadStatus =
  | 'new'
  | 'loaded'
  | 'reset_config_mismatch'
  | 'reset_corrupt'
  | 'reset_manual'

/**
 * Server-facing owner of one authoritative world.
 *
 * Every mutation is queued, so a caller can fire actions without awaiting the
 * previous save and still get deterministic ordering. The engine itself is
 * synchronous; persistence is the only asynchronous part.
 */
export class EconomyService {
  readonly config: EconomyConfig
  readonly store: EconomyStore
  readonly autoSave: boolean
  loadStatus: EconomyLoadStatus = 'new'

  private current: EconomyEngine
  private queue: Promise<unknown> = Promise.resolve()

  private constructor(
    config: EconomyConfig,
    store: EconomyStore,
    engine: EconomyEngine,
    autoSave: boolean,
  ) {
    this.config = config
    this.store = store
    this.current = engine
    this.autoSave = autoSave
  }

  static async create(options: EconomyServiceOptions): Promise<EconomyService> {
    const { config, store } = options
    const autoSave = options.autoSave ?? true
    const fingerprint = fingerprintConfig(config)
    let engine: EconomyEngine | null = null
    let loadStatus: EconomyLoadStatus = 'new'

    let envelope = null
    try {
      envelope = await store.load()
    } catch {
      await store.reset()
      loadStatus = 'reset_corrupt'
    }

    if (envelope) {
      const matchesFingerprint =
        envelope.fingerprint?.hash === fingerprint.hash &&
        envelope.fingerprint?.version === fingerprint.version &&
        envelope.fingerprint?.schemaVersion === fingerprint.schemaVersion
      if (matchesFingerprint) {
        try {
          engine = new EconomyEngine(config, { state: envelope.state })
          loadStatus = 'loaded'
        } catch {
          await store.reset()
          loadStatus = 'reset_config_mismatch'
        }
      } else {
        await store.reset()
        loadStatus = 'reset_config_mismatch'
      }
    }

    if (!engine) engine = new EconomyEngine(config)
    const service = new EconomyService(config, store, engine, autoSave)
    service.loadStatus = loadStatus
    if (autoSave && loadStatus !== 'loaded') await service.persist()
    return service
  }

  get engine(): EconomyEngine {
    return this.current
  }

  private enqueue<T>(task: () => T | Promise<T>): Promise<T> {
    const run = this.queue.then(task, task)
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async persist(): Promise<void> {
    await this.store.save({
      savedAt: Date.now(),
      fingerprint: this.current.fingerprint,
      state: this.current.snapshot(),
    })
  }

  private runAction<T>(
    action: () => EconomyActionResult<T>,
  ): Promise<EconomyActionResult<T>> {
    return this.enqueue(async () => {
      const result = action()
      if (result.success && this.autoSave) await this.persist()
      return result
    })
  }

  ensurePlayer(
    playerId: string,
    displayName?: string,
  ): Promise<EconomyActionResult<PlayerRuntimeState>> {
    return this.enqueue(async () => {
      if (this.current.hasPlayer(playerId)) {
        const player = this.current.getPlayer(playerId) as PlayerRuntimeState
        return {
          success: true,
          action: 'ensurePlayer',
          playerId,
          data: player,
          events: [],
          sequence: this.current.sequence,
        }
      }
      const result = this.current.createPlayer(playerId, displayName)
      if (result.success && this.autoSave) await this.persist()
      return { ...result, action: 'ensurePlayer' }
    })
  }

  gather(
    playerId: string,
    resourceId: string,
    duration?: number,
  ): Promise<EconomyActionResult> {
    return this.runAction(() => this.current.gather(playerId, resourceId, duration))
  }

  buy(
    playerId: string,
    merchantId: MerchantId,
    itemId: ItemId,
    quantity: number,
  ): Promise<EconomyActionResult<TradeActionData>> {
    return this.runAction(() => this.current.buy(playerId, merchantId, itemId, quantity))
  }

  sell(
    playerId: string,
    merchantId: MerchantId,
    itemId: ItemId,
    quantity: number,
  ): Promise<EconomyActionResult<TradeActionData>> {
    return this.runAction(() => this.current.sell(playerId, merchantId, itemId, quantity))
  }

  craft(playerId: string, recipeId: string, quantity: number): Promise<EconomyActionResult> {
    return this.runAction(() => this.current.craft(playerId, recipeId, quantity))
  }

  eat(playerId: string, itemId: ItemId): Promise<EconomyActionResult> {
    return this.runAction(() => this.current.eat(playerId, itemId))
  }

  /**
   * Debits inventory units and emits a `player.withdraw` market event.
   *
   * The callback runs through the serialized action queue and the resulting
   * world is persisted exactly like every other mutating action.
   */
  withdrawItem(
    playerId: string,
    itemId: ItemId,
    amount: number,
  ): Promise<EconomyActionResult<WithdrawActionData>> {
    return this.runAction(() => this.current.withdrawItem(playerId, itemId, amount))
  }

  repair(playerId: string): Promise<EconomyActionResult> {
    return this.runAction(() => this.current.repair(playerId))
  }

  invest(
    playerId: string,
    merchantId: MerchantId,
    amount: number,
  ): Promise<EconomyActionResult> {
    return this.runAction(() => this.current.invest(playerId, merchantId, amount))
  }

  acceptOrder(playerId: string, orderId: string): Promise<EconomyActionResult> {
    return this.runAction(() => this.current.acceptOrder(playerId, orderId))
  }

  fulfillOrder(
    playerId: string,
    orderId: string,
    quantity?: number,
  ): Promise<EconomyActionResult> {
    return this.runAction(() => this.current.fulfillOrder(playerId, orderId, quantity))
  }

  tick(seconds?: number): Promise<EconomyActionResult<TickActionData>> {
    return this.runAction(() => this.current.tick(seconds))
  }

  fastForward(days?: number): Promise<EconomyFastForwardResult> {
    return this.enqueue(async () => {
      const result = this.current.fastForward(days)
      if (result.success && this.autoSave) await this.persist()
      return result
    })
  }

  preview(
    playerId: string,
    merchantId: string,
    itemId: string,
    side: TradeSide,
    quantity: number,
  ): Quote | null {
    return this.current.preview(playerId, merchantId, itemId, side, quantity)
  }

  snapshot(): EconomyWorldState {
    return this.current.snapshot()
  }

  spectatorSnapshot(): SpectatorSnapshot {
    return this.current.spectatorSnapshot()
  }

  eventsSince(sequence: number): SequencedMarketEvent[] {
    return this.current.eventsSince(sequence)
  }

  async flush(): Promise<void> {
    await this.enqueue(() => this.persist())
  }

  async reset(): Promise<EconomyWorldState> {
    return this.enqueue(async () => {
      await this.store.reset()
      this.current = new EconomyEngine(this.config)
      this.loadStatus = 'reset_manual'
      if (this.autoSave) await this.persist()
      return this.current.snapshot()
    })
  }
}

export function createJsonEconomyService(
  config: EconomyConfig,
  filePath?: string,
  autoSave = true,
): Promise<EconomyService> {
  return EconomyService.create({
    config,
    store: new JsonEconomyStore(filePath),
    autoSave,
  })
}
