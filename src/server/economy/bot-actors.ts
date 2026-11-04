import type { RpgEvent } from '@rpgjs/server'
import type { CharacterConfig } from '../../config/characters'
import { characters } from '../../config/characters'
import { economy } from '../../config/economy'
import {
  merchantStallPosition,
  resourceArea,
  world,
} from '../../config/world'
import type { MerchantConfig } from '../../shared/types'
import type { SequencedMarketEvent } from '../../shared/economy'

export type BotActivityKind = 'gather' | 'trade' | 'order'
export type BotPhase = 'idle' | 'toActivity' | 'working' | 'returning' | 'patrolling'

export interface BotActivityTarget {
  kind: BotActivityKind
  x: number
  y: number
  /** Human-readable destination used by diagnostics and tests. */
  label: string
}

type Point = { x: number; y: number }

interface BotActorState {
  id: string
  index: number
  event: RpgEvent
  home: Point
  phase: BotPhase
  target: Point
  deadline: number
  nextAt: number
  patrolIndex: number
  activity: BotActivityKind | null
}

const MOVEMENT_SPEED = 10
/**
 * RPGJS's `moveTo` uses `SeekAvoid` with an arrival radius of 48 map pixels.
 * Keep the director's check slightly wider so arrival is detected before the
 * activity deadline can treat a successful walk as a timeout.
 */
const ARRIVAL_RADIUS = 52
/**
 * Order deliveries stand on either side of the Guild Orders sign rather than
 * under it. The sign is up to 250px wide and the nameplated bot sprite is 96px
 * wide; 180px of horizontal separation leaves room for a bot to stop within
 * RPGJS's 52px arrival radius without covering the sign text.
 */
const ORDER_APPROACH_X = 180
const ORDER_APPROACH_Y = 24
const TICK_MS = 100
const WORK_MS = 1_400
const ACTIVITY_TIMEOUT_MS = 15_000
const RETURN_TIMEOUT_MS = 15_000
const PATROL_TIMEOUT_MS = 8_000
const PATROL_OFFSETS: readonly Point[] = [
  { x: 96, y: 0 },
  { x: 96, y: 64 },
  { x: 0, y: 64 },
  { x: -96, y: 64 },
  { x: -96, y: 0 },
  { x: -96, y: -64 },
  { x: 0, y: -64 },
  { x: 96, y: -64 },
]

const merchantByName = new Map(
  Object.values(economy.merchants).map(merchant => [merchant.displayName, merchant]),
)
const merchantPatterns = [/\bfrom (.+?) for\b/, /\bto (.+?) for\b/]
const actors = new Map<string, BotActorState>()

let ticker: ReturnType<typeof setInterval> | null = null

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

const clampPoint = (point: Point): Point => ({
  x: clamp(Math.round(point.x), 32, world.map.widthPx - 32),
  y: clamp(Math.round(point.y), 32, world.map.heightPx - 32),
})

const distanceTo = (actor: RpgEvent, point: Point): number | null => {
  try {
    const x = actor.x()
    const y = actor.y()
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null
    return Math.hypot(x - point.x, y - point.y)
  } catch {
    // Map events disappear on map teardown/HMR. Treat an unreadable position
    // as stale so the ticker can unregister the actor instead of throwing.
    return null
  }
}

function merchantForEventMessage(message: string): MerchantConfig | null {
  for (const pattern of merchantPatterns) {
    const match = pattern.exec(message)
    if (!match) continue
    const merchant = merchantByName.get(match[1].trim())
    if (merchant) return merchant
  }
  return null
}

function resourceIdForItem(itemId: string): string | null {
  for (const [resourceId, node] of Object.entries(economy.resources.nodes)) {
    if (node.itemId === itemId) return resourceId
  }
  return null
}

/**
 * Translates one authoritative bot event into a visible destination.
 *
 * This is intentionally a presentation-only mapping: it never mutates the
 * economy and it tolerates events arriving before a player has loaded the map.
 */
export function botActivityTargetForEvent(
  event: SequencedMarketEvent,
  botIndex: number,
): BotActivityTarget | null {
  const index = Number.isFinite(botIndex) ? Math.max(0, Math.floor(botIndex)) : 0

  if (event.type === 'bot.gather' && event.item) {
    const resourceId = resourceIdForItem(event.item)
    if (!resourceId) return null
    const area = resourceArea(resourceId)
    if (!area) return null
    const target = clampPoint({
      x: area.x + ((index % 3) - 1) * 24,
      y: area.y + 20 + (index % 2) * 12,
    })
    return { kind: 'gather', ...target, label: area.label }
  }

  if (event.type === 'bot.trade') {
    const merchant = merchantForEventMessage(event.message)
    if (!merchant) return null
    const stall = merchantStallPosition(merchant)
    const target = clampPoint({
      x: stall.x + (index % 2 === 0 ? 52 : -52),
      y: stall.y + 86,
    })
    return { kind: 'trade', ...target, label: merchant.displayName }
  }

  if (event.type === 'order.fulfilled') {
    const target = clampPoint({
      x: world.orderBoard.x + (index % 2 === 0 ? -ORDER_APPROACH_X : ORDER_APPROACH_X),
      y: world.orderBoard.y + ORDER_APPROACH_Y + (Math.floor(index / 2) % 3) * 8,
    })
    return { kind: 'order', ...target, label: 'Guild Orders' }
  }

  return null
}

function startPatrol(actor: BotActorState, now: number): void {
  const offset = PATROL_OFFSETS[(actor.index + actor.patrolIndex) % PATROL_OFFSETS.length]
  actor.patrolIndex += 1
  actor.target = clampPoint({
    x: actor.home.x + offset.x,
    y: actor.home.y + offset.y,
  })
  actor.phase = 'patrolling'
  actor.deadline = now + PATROL_TIMEOUT_MS
  actor.activity = null
  try {
    actor.event.stopMoveTo()
    actor.event.moveTo(actor.target)
  } catch {
    actor.phase = 'idle'
    actor.nextAt = now + 2_000
  }
}

function beginReturn(actor: BotActorState, now: number): void {
  actor.phase = 'returning'
  actor.target = actor.home
  actor.deadline = now + RETURN_TIMEOUT_MS
  try {
    actor.event.stopMoveTo()
    actor.event.moveTo(actor.home)
  } catch {
    actor.phase = 'idle'
    actor.nextAt = now + 2_000
  }
}

function beginActivity(
  actor: BotActorState,
  target: BotActivityTarget,
  now: number,
): void {
  actor.phase = 'toActivity'
  actor.target = { x: target.x, y: target.y }
  actor.deadline = now + ACTIVITY_TIMEOUT_MS
  actor.activity = target.kind
  try {
    actor.event.stopMoveTo()
    actor.event.moveTo(actor.target)
  } catch {
    actor.phase = 'idle'
    actor.nextAt = now + 2_000
  }
}

/**
 * Advances every registered visible bot. Exported separately so unit tests can
 * drive movement without waiting for real timers.
 *
 * Each actor is isolated: an event can be removed during map teardown or HMR,
 * and `x()`/`y()`/`stopMoveTo()` can then throw. A stale actor is unregistered
 * without aborting the rest of the tick.
 */
export function tickBotActors(now = Date.now()): void {
  for (const actor of [...actors.values()]) {
    try {
      tickBotActor(actor, now)
    } catch {
      removeBotActorState(actor)
    }
  }
}

function tickBotActor(actor: BotActorState, now: number): void {
  const distance = distanceTo(actor.event, actor.target)
  if (distance === null) {
    removeBotActorState(actor)
    return
  }

  if (actor.phase === 'toActivity') {
    if (distance <= ARRIVAL_RADIUS) {
      actor.event.stopMoveTo()
      actor.phase = 'working'
      actor.nextAt = now + WORK_MS
    } else if (now >= actor.deadline) {
      beginReturn(actor, now)
    }
    return
  }

  if (actor.phase === 'working') {
    if (now >= actor.nextAt) beginReturn(actor, now)
    return
  }

  if (actor.phase === 'returning') {
    if (distance <= ARRIVAL_RADIUS) {
      actor.event.stopMoveTo()
      actor.phase = 'idle'
      actor.nextAt = now + 1_200 + (actor.index % 3) * 250
      actor.activity = null
    } else if (now >= actor.deadline) {
      actor.phase = 'idle'
      actor.nextAt = now + 1_200
      actor.activity = null
    }
    return
  }

  if (actor.phase === 'patrolling') {
    if (distance <= ARRIVAL_RADIUS) {
      actor.event.stopMoveTo()
      actor.phase = 'idle'
      actor.nextAt = now + 1_400 + (actor.index % 3) * 250
    } else if (now >= actor.deadline) {
      beginReturn(actor, now)
    }
    return
  }

  if (now >= actor.nextAt) startPatrol(actor, now)
}

function removeBotActorState(actor: BotActorState): void {
  actors.delete(actor.id)
  try {
    actor.event.stopMoveTo()
  } catch {
    // Already removed from the map.
  }
  stopTickerIfEmpty()
}

function stopTickerIfEmpty(): void {
  if (actors.size > 0 || !ticker) return
  clearInterval(ticker)
  ticker = null
}

function ensureTicker(): void {
  if (ticker) return
  ticker = setInterval(() => tickBotActors(), TICK_MS)
  ;(ticker as { unref?: () => void }).unref?.()
}

/** Register a visible town event as the body for a named economy bot. */
export function registerBotActor(character: CharacterConfig, event: RpgEvent): void {
  if (!character.map) return

  const index = Math.max(
    0,
    characters.findIndex(candidate => candidate.id === character.id),
  )
  const existing = actors.get(character.id)
  if (existing) {
    existing.event = event
    existing.event.speed = MOVEMENT_SPEED
    return
  }

  const home = { x: character.map.x, y: character.map.y }
  const state: BotActorState = {
    id: character.id,
    index,
    event,
    home,
    phase: 'idle',
    target: home,
    deadline: 0,
    nextAt: Date.now() + 500 + index * 220,
    patrolIndex: 0,
    activity: null,
  }
  event.speed = MOVEMENT_SPEED
  actors.set(character.id, state)
  ensureTicker()
}

export function unregisterBotActor(botId: string): void {
  const actor = actors.get(botId)
  if (actor) removeBotActorState(actor)
}

export function registeredBotActorIds(): string[] {
  return [...actors.keys()]
}

export function clearBotActors(): void {
  for (const actor of actors.values()) {
    try {
      actor.event.stopMoveTo()
    } catch {
      // The map may already be gone during shutdown.
    }
  }
  actors.clear()
  if (ticker) clearInterval(ticker)
  ticker = null
}

/** Feed the live bot events into the visible actors. Fast-forward is not here. */
export function applyBotActivityEvents(
  events: readonly SequencedMarketEvent[],
  now = Date.now(),
): void {
  for (const event of events) {
    if (event.actor.type !== 'bot') continue
    const actor = actors.get(event.actor.id)
    if (!actor) continue
    const target = botActivityTargetForEvent(event, actor.index)
    if (!target) continue
    beginActivity(actor, target, now)
  }
}

/** A diagnostic snapshot used by tests and the demo health endpoint. */
export function botActorSnapshot(): Array<{
  id: string
  phase: BotPhase
  x: number
  y: number
  activity: BotActivityKind | null
}> {
  return [...actors.values()].map(actor => ({
    id: actor.id,
    phase: actor.phase,
    x: Math.round(actor.event.x()),
    y: Math.round(actor.event.y()),
    activity: actor.activity,
  }))
}
