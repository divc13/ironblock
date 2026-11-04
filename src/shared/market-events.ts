import { stableHash64, stableStringify } from './stable-hash'
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
  before: MarketEventSnapshot
  after: MarketEventSnapshot
  reasons?: PriceReason[]
  cause: EventCauseType
  causeId: string
  message?: string
}

const snapshotFields = ['stock', 'cash', 'bid', 'ask'] as const

/**
 * Snapshots are required in full. Missing fields are a caller bug: silently
 * replacing them with zero would corrupt event history and id hashing.
 */
const normalizeSnapshot = (
  value: MarketEventSnapshot,
  label: 'before' | 'after',
): MarketEventSnapshot => {
  if (value === null || typeof value !== 'object') {
    throw new Error(`${label} snapshot is required`)
  }

  const result = {} as MarketEventSnapshot
  for (const field of snapshotFields) {
    const fieldValue = value[field]
    if (fieldValue === undefined) {
      throw new Error(
        `${label}.${field} is required; use null when the field is not applicable`,
      )
    }
    if (fieldValue !== null && !Number.isFinite(fieldValue)) {
      throw new Error(`${label}.${field} must be finite or null`)
    }
    result[field] = fieldValue
  }
  return result
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
 * Otherwise the id is derived deterministically from the complete event
 * contents, including reasons and message, using a 64-bit hash.
 */
export function createMarketEvent(input: CreateMarketEventInput): MarketEvent {
  const item = input.item ?? null
  const quantity = input.quantity ?? null
  const price = input.price ?? null
  const before = normalizeSnapshot(input.before, 'before')
  const after = normalizeSnapshot(input.after, 'after')
  const reasons = input.reasons ?? []
  const message = input.message ?? defaultMessage(input)
  const id =
    input.id ??
    `evt_${stableHash64(
      stableStringify({
        time: input.time,
        type: input.type,
        actor: input.actor,
        item,
        quantity,
        price,
        before,
        after,
        reasons,
        cause: input.cause,
        causeId: input.causeId,
        message,
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
    reasons,
    cause: input.cause,
    causeId: input.causeId,
    message,
  }
}

export default createMarketEvent
