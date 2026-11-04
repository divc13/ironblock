import type {
  EventActor,
  EventCauseType,
  ItemId,
  MarketEvent,
  MarketEventSnapshot,
  MarketEventType,
  PriceReason,
} from './types'

export interface CreateMarketEventInput {
  id?: string
  time: number
  type: MarketEventType
  actor: EventActor
  item?: ItemId | null
  quantity?: number | null
  price?: number | null
  before?: Partial<MarketEventSnapshot>
  after?: Partial<MarketEventSnapshot>
  reasons?: PriceReason[]
  cause: EventCauseType
  causeId: string
  message?: string
}

const snapshot = (value: Partial<MarketEventSnapshot> | undefined): MarketEventSnapshot => ({
  stock: value?.stock ?? 0,
  cash: value?.cash ?? 0,
  bid: value?.bid ?? 0,
  ask: value?.ask ?? 0,
})

/** Small stable hash so event ids are deterministic for a deterministic sim. */
const stableHash = (value: string): string => {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

const defaultMessage = (input: CreateMarketEventInput): string => {
  const actor = input.actor.displayName ?? input.actor.id
  const subject = input.item ?? 'market'
  const quantity = input.quantity !== undefined && input.quantity !== null ? ` x${input.quantity}` : ''
  const price = input.price !== undefined && input.price !== null ? ` at ${input.price}` : ''
  return `${actor} ${input.type.replace(/[._]/g, ' ')} ${subject}${quantity}${price}`
}

/**
 * Creates the shared event envelope used by trades, restocks, bankruptcies,
 * sinks, caravan arrivals and fast-forward snapshots.
 *
 * Callers may pass an explicit id when they already have a durable event id.
 * Otherwise the id is derived deterministically from the event contents.
 */
export function createMarketEvent(input: CreateMarketEventInput): MarketEvent {
  const item = input.item ?? null
  const quantity = input.quantity ?? null
  const price = input.price ?? null
  const before = snapshot(input.before)
  const after = snapshot(input.after)
  const id =
    input.id ??
    `evt_${stableHash(
      JSON.stringify({
        time: input.time,
        type: input.type,
        actor: input.actor,
        item,
        quantity,
        price,
        before,
        after,
        cause: input.cause,
        causeId: input.causeId,
      }),
    )}`

  return {
    id,
    time: input.time,
    type: input.type,
    actor: input.actor,
    item,
    quantity,
    price,
    before,
    after,
    reasons: input.reasons ?? [],
    cause: input.cause,
    causeId: input.causeId,
    message: input.message ?? defaultMessage(input),
  }
}

export default createMarketEvent
