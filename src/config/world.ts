import { economy } from './economy'
import type { MerchantConfig, MerchantId, ResourceId } from '../shared/types'

/**
 * Ironblock world layout.
 *
 * Data only. The market square is a new 40x40 Tiled map ("marketsquare") that
 * reuses the starter's base tileset. Stall slots, resource areas and labels are
 * derived from the economy config so adding a merchant or resource node does not
 * require touching world execution code.
 */

export type WorldPoint = { x: number; y: number }

export interface ResourceAreaConfig {
  /** Human-readable area name shown on the sign. */
  label: string
  /** Area centre in map pixels. */
  x: number
  y: number
  /** Radius of the node cluster in map pixels. */
  radius: number
}

export interface MerchantStallConfig {
  x: number
  y: number
  /** Hex colour used by the generated stall sprite. */
  color: string
}

export const world = {
  mapId: 'marketsquare',
  map: {
    widthPx: 1280,
    heightPx: 1280,
    tileSize: 32,
  },
  /** Player spawn near the south gate, facing the square. */
  spawn: { x: 640, y: 1056 },

  /**
   * Guild Orders board used by visible bot order deliveries. It sits on the
   * open walkway between the south stalls and the player spawn so its sign is
   * not hidden by the taller, name-plated bot sprites around the centre.
   */
  orderBoard: { x: 640, y: 960 },

  /** Interact with merchants/nodes when within this pixel distance. */
  interactionRadius: 72,

  /**
   * Explicit stall positions keyed by `merchant.stallSlot`. Slots beyond these
   * fall back to a derived ring position, so the merchant count stays data-driven.
   */
  stallSlots: {
    1: { x: 232, y: 416, color: '#c85d4a' },
    2: { x: 640, y: 416, color: '#d09a3c' },
    3: { x: 1048, y: 416, color: '#4f8f6a' },
    4: { x: 232, y: 688, color: '#7b6fb0' },
    5: { x: 640, y: 688, color: '#4d7fa8' },
    6: { x: 1048, y: 688, color: '#a2577e' },
    7: { x: 384, y: 944, color: '#3f7f7a' },
    8: { x: 896, y: 944, color: '#b3653f' },
  } satisfies Record<number, MerchantStallConfig>,

  /** Fallback grid used for any stall slot not listed above. */
  stallOverflow: {
    columns: 4,
    startX: 176,
    startY: 944,
    gapX: 256,
    gapY: 240,
  },

  resourceAreas: {
    iron_vein: {
      label: 'Iron Veins',
      x: 176,
      y: 208,
      radius: 112,
    },
    wheat_field: {
      label: 'Wheat Fields',
      x: 192,
      y: 1088,
      radius: 120,
    },
    timber_grove: {
      label: 'Timber Grove',
      x: 1104,
      y: 208,
      radius: 112,
    },
    wool_pasture: {
      label: 'Wool Pasture',
      x: 1088,
      y: 1088,
      radius: 112,
    },
  } satisfies Record<ResourceId, ResourceAreaConfig>,

  palette: ['#c85d4a', '#d09a3c', '#4f8f6a', '#7b6fb0', '#4d7fa8', '#a2577e'],
} as const

/** Merchant configs in stable slot order. */
export function merchantsInStallOrder(): MerchantConfig[] {
  return Object.values(economy.merchants).sort(
    (left, right) => left.stallSlot - right.stallSlot || left.id.localeCompare(right.id),
  )
}

/** Resolve a stall position for any `stallSlot`, including slots beyond the explicit table. */
export function stallPositionForSlot(slot: number): MerchantStallConfig {
  const explicit = (world.stallSlots as Record<number, MerchantStallConfig | undefined>)[slot]
  if (explicit) return explicit

  const explicitSlots = Object.keys(world.stallSlots).map(Number)
  const overflowIndex = Math.max(0, slot - 1 - Math.max(0, ...explicitSlots))
  const grid = world.stallOverflow
  const column = overflowIndex % grid.columns
  const row = Math.floor(overflowIndex / grid.columns)
  return {
    x: grid.startX + column * grid.gapX,
    y: grid.startY + row * grid.gapY,
    color: world.palette[overflowIndex % world.palette.length],
  }
}

export function merchantStallPosition(merchant: MerchantConfig): MerchantStallConfig {
  return stallPositionForSlot(merchant.stallSlot)
}

export function resourceArea(resourceId: ResourceId): ResourceAreaConfig | undefined {
  return (world.resourceAreas as Record<string, ResourceAreaConfig | undefined>)[resourceId]
}

/**
 * Deterministic node positions for a resource area. The count comes from the
 * economy config, never from this file.
 */
export function resourceNodePositions(resourceId: ResourceId): WorldPoint[] {
  const area = resourceArea(resourceId)
  const node = (economy.resources.nodes as Record<string, (typeof economy.resources.nodes)[keyof typeof economy.resources.nodes] | undefined>)[resourceId]
  if (!area || !node) return []

  const goldenAngle = Math.PI * (3 - Math.sqrt(5))
  const positions: WorldPoint[] = []
  for (let index = 0; index < node.nodeCount; index += 1) {
    if (index === 0) {
      positions.push({ x: area.x, y: area.y })
      continue
    }
    const radius = area.radius * (0.45 + (0.55 * index) / Math.max(1, node.nodeCount - 1))
    const angle = index * goldenAngle
    positions.push({
      x: Math.round(area.x + Math.cos(angle) * radius),
      y: Math.round(area.y + Math.sin(angle) * radius),
    })
  }
  return positions
}

/** Merchant event id used by both the server placement and the client bridge. */
export function merchantEventName(merchantId: MerchantId): string {
  return `merchant:${merchantId}`
}

/** Visible economy-bot event id, keyed by the stable character id. */
export function townsfolkEventName(characterId: string): string {
  return `townsfolk:${characterId}`
}

export function resourceNodeEventName(resourceId: ResourceId, index: number): string {
  return `node:${resourceId}:${index}`
}

export function isMerchantEventName(name: string): boolean {
  return name.startsWith('merchant:')
}

export function isResourceEventName(name: string): boolean {
  return name.startsWith('node:')
}

export function merchantIdFromEventName(name: string): MerchantId | null {
  return isMerchantEventName(name) ? name.slice('merchant:'.length) : null
}

export function resourceSpecFromEventName(name: string): { resourceId: ResourceId; index: number } | null {
  if (!isResourceEventName(name)) return null
  const [, resourceId, index] = name.split(':')
  if (!resourceId || index === undefined) return null
  return { resourceId, index: Number(index) }
}

export default world
