import { economy } from '../config/economy'
import { world } from '../config/world'
import type { EventActorType, ItemId, MerchantId, ResourceId } from '../shared/types'
import { formatMoney, percentOf } from './format'

/**
 * Pure first-day objective selection.
 *
 * The guide is a reading of the same snapshot, inventory and merchant quotes the
 * rest of the HUD uses. It never prices anything itself: the buyer suggestion is
 * supplied by `src/ui/market-board.ts`, which asks the economy client for quotes.
 */

const FIRST_DAY_INGOTS = 3
const FIRST_DAY_ORE: ItemId = 'iron_ore'
const FIRST_DAY_INGOT: ItemId = 'iron_ingot'
const FIRST_DAY_DAYS = economy.fastForward.days

export type GuidePanel = 'bag' | 'market' | 'week'

export type GuideTarget =
  | { kind: 'merchant'; id: MerchantId; label: string }
  | { kind: 'resource'; id: ResourceId; label: string }

export interface GuideWaypoint {
  targetId: string
  label: string
  /** Eight-wind bearing, e.g. `NW`. Kept in sync by the game client. */
  direction: string
  /** Rough distance in world tiles ("paces"). */
  distance: number
  arrived: boolean
}

export interface GuideInventoryLine {
  itemId: ItemId
  quantity: number
}

export interface GuideEventLike {
  type: string
  actor: { type: EventActorType | string }
  item: string | null
  quantity: number | null
}

export interface GuideBuyer {
  merchantId: MerchantId
  displayName: string
  unitPrice: number
}

export interface FirstDayGuideInput {
  day: number
  cash: number
  inventory: readonly GuideInventoryLine[]
  /** Recent snapshot events; used to count ingots the player has already sold. */
  events?: readonly GuideEventLike[]
  /** Best live bid for the first-day item, when the UI has loaded quotes. */
  bestIngotBuyer?: GuideBuyer | null
}

export interface GuideProgress {
  current: number
  target: number
  label: string
}

export interface FirstDayStep {
  id: 'gather' | 'smelt' | 'sell' | 'week' | 'done'
  /** 1-based step number for the "1 / 4" label. */
  index: number
  total: number
  title: string
  detail: string
  progress: GuideProgress
  actionLabel: string
  target?: GuideTarget
  panel?: GuidePanel
  completed: boolean
}

export interface FirstDayGuide {
  step: FirstDayStep
  intro: string
  soldIngots: number
}

const itemName = (itemId: ItemId): string =>
  (economy.items as Record<string, { displayName?: string } | undefined>)[itemId]?.displayName ??
  itemId

const quantityOf = (inventory: readonly GuideInventoryLine[], itemId: ItemId): number =>
  inventory.find(line => line.itemId === itemId)?.quantity ?? 0

const soldIngotsFrom = (events: readonly GuideEventLike[] = []): number =>
  events.reduce((total, event) => {
    if (
      event.type === 'trade.sell' &&
      event.actor.type === 'player' &&
      event.item === FIRST_DAY_INGOT
    ) {
      return total + Math.max(0, event.quantity ?? 0)
    }
    return total
  }, 0)

const smeltRecipe = (): (typeof economy.recipes)[keyof typeof economy.recipes] | undefined =>
  Object.values(economy.recipes).find(recipe => (recipe.outputs[FIRST_DAY_INGOT] ?? 0) > 0)

const orePerIngot = (): number => {
  const recipe = smeltRecipe()
  const orePerCraft = Math.max(1, recipe?.inputs[FIRST_DAY_ORE] ?? 2)
  const ingotsPerCraft = Math.max(1, recipe?.outputs[FIRST_DAY_INGOT] ?? 1)
  return Math.max(1, Math.ceil(orePerCraft / ingotsPerCraft))
}

const oreToIngotRule = (): string => {
  const perIngot = orePerIngot()
  return `${perIngot} ore ${perIngot === 1 ? 'makes' : 'make'} one ingot`
}

const ironVeinLabel = (): string => {
  const area = (world.resourceAreas as Record<string, { label?: string } | undefined>)[
    'iron_vein'
  ]
  return area?.label ?? 'Iron Veins'
}

export function selectFirstDayGuide(input: FirstDayGuideInput): FirstDayGuide {
  const ore = quantityOf(input.inventory, FIRST_DAY_ORE)
  const ingots = quantityOf(input.inventory, FIRST_DAY_INGOT)
  const soldIngots = soldIngotsFrom(input.events)
  const remainingIngots = Math.max(0, FIRST_DAY_INGOTS - ingots - soldIngots)
  const oreForRemaining = remainingIngots * orePerIngot()
  const intro = `Buy low, sell high. You have ${formatMoney(
    input.cash,
    economy.currency.symbol,
  )}.`

  const base = {
    index: 1,
    total: 4,
    intro,
    soldIngots,
  }

  if (input.day > FIRST_DAY_DAYS) {
    return {
      ...base,
      step: {
        id: 'done',
        index: 4,
        total: 4,
        title: 'First week complete',
        detail: `The town has traded for ${FIRST_DAY_DAYS} days. Keep an eye on the board — prices have moved.`,
        progress: { current: 1, target: 1, label: 'Goal complete' },
        actionLabel: 'Open market',
        panel: 'market',
        completed: true,
      },
    }
  }

  if (soldIngots >= FIRST_DAY_INGOTS) {
    const weekProgress = Math.min(FIRST_DAY_DAYS, Math.max(0, input.day - 1))
    return {
      ...base,
      step: {
        id: 'week',
        index: 4,
        total: 4,
        title: 'Run your first week',
        detail: `Press F or open Week. ${FIRST_DAY_DAYS} days pass while the townsfolk trade around you.`,
        progress: {
          current: weekProgress,
          target: FIRST_DAY_DAYS,
          label: input.day > 1 ? `Day ${input.day} of ${FIRST_DAY_DAYS}` : 'Ready to run',
        },
        actionLabel: 'Run the week',
        panel: 'week',
        completed: false,
      },
    }
  }

  if (soldIngots > 0 || ingots >= FIRST_DAY_INGOTS) {
    const buyer = input.bestIngotBuyer
    const detail = buyer
      ? `Best bid in town: ${formatMoney(buyer.unitPrice, economy.currency.symbol)} each.`
      : 'Open the Market board to see who is paying the most today.'
    return {
      ...base,
      step: {
        id: 'sell',
        index: 3,
        total: 4,
        title: buyer
          ? `Sell ${FIRST_DAY_INGOTS} Iron Ingots to ${buyer.displayName}`
          : `Sell ${FIRST_DAY_INGOTS} Iron Ingots to the best bidder`,
        detail,
        progress: {
          current: Math.min(soldIngots, FIRST_DAY_INGOTS),
          target: FIRST_DAY_INGOTS,
          label: `${Math.min(soldIngots, FIRST_DAY_INGOTS)} / ${FIRST_DAY_INGOTS} sold`,
        },
        actionLabel: buyer ? `Go to ${buyer.displayName}` : 'Find a buyer',
        target: buyer
          ? { kind: 'merchant', id: buyer.merchantId, label: buyer.displayName }
          : undefined,
        panel: buyer ? undefined : 'market',
        completed: false,
      },
    }
  }

  if (ore >= oreForRemaining || (remainingIngots === 0 && ingots > 0)) {
    return {
      ...base,
      step: {
        id: 'smelt',
        index: 2,
        total: 4,
        title:
          ingots === 0
            ? `Smelt ${FIRST_DAY_INGOTS} Iron Ingots in your Bag`
            : `Smelt ${remainingIngots} more Iron Ingot${remainingIngots === 1 ? '' : 's'}`,
        detail: `Open your Bag and use ${
          smeltRecipe()?.displayName ?? 'the smelting recipe'
        }. ${oreToIngotRule()}.`,
        progress: {
          current: Math.min(ingots, FIRST_DAY_INGOTS),
          target: FIRST_DAY_INGOTS,
          label: `${Math.min(ingots, FIRST_DAY_INGOTS)} / ${FIRST_DAY_INGOTS} ingots`,
        },
        actionLabel: 'Open Bag',
        panel: 'bag',
        completed: false,
      },
    }
  }

  const gatherTarget = Math.max(1, oreForRemaining)
  return {
    ...base,
    step: {
      id: 'gather',
      index: 1,
      total: 4,
      title: `Gather ${gatherTarget} Iron Ore at the ${ironVeinLabel()}`,
      detail:
        ingots > 0
          ? `You have ${ingots} ingot${ingots === 1 ? '' : 's'}. ${oreToIngotRule()}.`
          : `Follow the waypoint to the ${ironVeinLabel()}. ${oreToIngotRule()}.`,
      progress: {
        current: Math.min(ore, gatherTarget),
        target: gatherTarget,
        label: `${Math.min(ore, gatherTarget)} / ${gatherTarget} ore`,
      },
      actionLabel: 'Show me',
      target: { kind: 'resource', id: 'iron_vein', label: ironVeinLabel() },
      completed: false,
    },
  }
}

/** Progress percentage for the thin guide bar. */
export const guidePercent = (progress: GuideProgress): number =>
  percentOf(progress.current, progress.target)

/** Eight-wind direction from map-space deltas (y grows downward on screen). */
export function compassDirection(dx: number, dy: number): string {
  if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) return 'here'
  const labels = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const
  const angle = Math.atan2(dx, -dy)
  const sector = Math.round(angle / (Math.PI / 4))
  return labels[((sector % 8) + 8) % 8]
}

/** Map pixels per tile, used for a plain "paces" hint. */
export const distanceInPaces = (distancePx: number): number =>
  Math.max(0, Math.round(distancePx / world.map.tileSize))
