import type { ItemId, MerchantId, Quote, TradeSide } from '../types'
import type {
  EconomyFastForwardResult,
  EconomyWorldState,
  MerchantRuntimeState,
  PlayerRuntimeState,
  SequencedMarketEvent,
} from './types'

/**
 * DTOs shared by the authoritative economy HTTP handler and the browser client.
 *
 * These are plain JSON shapes; no server-only module may be imported here.
 */

/** `GET /api/economy/snapshot` */
export interface EconomySnapshotResponse {
  /** Raw authoritative world state. */
  state: EconomyWorldState
  /** The authenticated player's runtime view, or null before the first ensure. */
  player: PlayerRuntimeState | null
  /** Merchant runtime states in config stall order. */
  merchants: MerchantRuntimeState[]
  /** Aggregate cash held by every traveler, without exposing per-player state. */
  totalPlayerCash: number
  /** Recent retained events, oldest first. */
  events: SequencedMarketEvent[]
  /** Latest world event sequence. */
  sequence: number
  /** Oldest event sequence still retained (for gap detection). */
  firstRetainedSequence: number
  configHash: string
  configVersion: string
}

/** `POST /api/economy/trade` */
export interface EconomyTradeResponse {
  ok: true
  message: string
  quote: Quote
  fillQuantity: number
  total: number
  events: SequencedMarketEvent[]
  sequence: number
}

/** `POST /api/economy/gather` */
export interface EconomyGatherResponse {
  ok: true
  message: string
  itemId: ItemId
  quantity: number
  staminaSpent: number
  stamina: number
  durability: number | null
  remainingNodes: number
}

/** `POST /api/economy/craft` */
export interface EconomyCraftResponse {
  ok: true
  message: string
  recipeId: string
  outputs: Record<ItemId, number>
  staminaSpent: number
}

/** `POST /api/economy/invest` */
export interface EconomyInvestResponse {
  ok: true
  message: string
  merchantId: MerchantId
  amount: number
  merchantCash: number
  reopened: boolean
}

/** `POST /api/economy/repair` */
export interface EconomyRepairResponse {
  ok: true
  message: string
  toolItemId: ItemId | null
  cost: number
  durability: number | null
}

/** `POST /api/economy/eat` */
export interface EconomyEatResponse {
  ok: true
  message: string
  itemId: ItemId
  staminaRestored: number
}

/** `GET /api/economy/events?since=<sequence>` */
export interface EconomyEventsResponse {
  events: SequencedMarketEvent[]
  sequence: number
  firstRetainedSequence: number
}

/** `GET /api/economy/orders` */
export interface EconomyOrderBoardEntryResponse {
  id: string
  side: TradeSide
  merchantId: MerchantId
  merchantName: string
  itemId: ItemId
  itemName: string
  quantity: number
  unitPrice: number
}

/** `POST /api/economy/fast-forward` */
export type EconomyFastForwardResponse = EconomyFastForwardResult

/** Error envelope used by every economy endpoint. */
export interface EconomyErrorResponse {
  error: {
    code: string
    message: string
  }
}
