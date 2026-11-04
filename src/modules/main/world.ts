import type { EventDefinition, RpgPlayer } from '@rpgjs/server'
import { economy } from '../../config/economy'
import { defineModule } from '@rpgjs/common'
import type { RpgServer } from '@rpgjs/server'
import {
  merchantEventName,
  merchantStallPosition,
  merchantsInStallOrder,
  resourceArea,
  resourceNodeEventName,
  resourceNodePositions,
  world,
} from '../../config/world'
import type { MerchantId, ResourceId } from '../../shared/types'

/**
 * Server-side binding surface for world interactions.
 *
 * The playable demo drives the mock economy entirely on the client (the client
 * bridge opens the overlay when the player is near an event). This interface is
 * the seam the integration agent uses when the authoritative economy service is
 * connected: it can be injected with `setWorldEconomyActions` and the Tiled
 * events will call it for every action keypress.
 */
export interface WorldEconomyActions {
  talkToMerchant(player: RpgPlayer, merchantId: MerchantId): void | Promise<void>
  gather(player: RpgPlayer, resourceId: ResourceId): void | Promise<void>
}

const defaultActions: WorldEconomyActions = {
  talkToMerchant() {
    // Intentionally empty. The client overlay handles the demo interaction so
    // the server does not need to duplicate economy rules. Replace this binding
    // when the real service owns merchant sessions.
  },
  gather() {
    // See talkToMerchant.
  },
}

let actions: WorldEconomyActions = defaultActions

export function setWorldEconomyActions(next: WorldEconomyActions): void {
  actions = next
}

export function getWorldEconomyActions(): WorldEconomyActions {
  return actions
}

interface ServerEventPlacement {
  id: string
  x: number
  y: number
  event: EventDefinition
}

function merchantEvent(merchantId: MerchantId, index: number): EventDefinition {
  return {
    name: merchantEventName(merchantId),
    onInit() {
      // Existing character sheets are reused; stalls and signs are generated
      // client-side by the spritesheet resolver.
      this.setGraphic(index % 2 === 0 ? 'hero' : 'female')
    },
    onAction(player: RpgPlayer) {
      return actions.talkToMerchant(player, merchantId)
    },
  }
}

function resourceEvent(resourceId: ResourceId, index: number): EventDefinition {
  return {
    name: resourceNodeEventName(resourceId, index),
    onInit() {
      this.setGraphic(`ironblock:node:${resourceId}`)
    },
    onAction(player: RpgPlayer) {
      return actions.gather(player, resourceId)
    },
  }
}

function stallPropEvent(merchantId: MerchantId): EventDefinition {
  return {
    onInit() {
      this.setGraphic(`ironblock:stall:${merchantId}`)
    },
  }
}

function signEvent(graphic: string): EventDefinition {
  return {
    onInit() {
      this.setGraphic(graphic)
    },
  }
}

/**
 * Builds the market-square map contents from config. Merchant count, stall
 * slots and node counts are all derived; adding a merchant or node to the
 * economy config automatically adds the corresponding event.
 */
export function buildWorldEvents(): ServerEventPlacement[] {
  const events: ServerEventPlacement[] = []

  merchantsInStallOrder().forEach((merchant, index) => {
    const stall = merchantStallPosition(merchant)

    events.push({
      id: `stall:${merchant.id}`,
      x: stall.x,
      y: stall.y,
      event: stallPropEvent(merchant.id),
    })
    events.push({
      id: `sign:stall:${merchant.id}`,
      x: stall.x,
      y: Math.max(32, stall.y - 74),
      event: signEvent(`ironblock:sign:stall:${merchant.id}`),
    })
    events.push({
      id: merchantEventName(merchant.id),
      x: stall.x,
      y: stall.y + 42,
      event: merchantEvent(merchant.id, index),
    })
  })

  for (const resourceId of Object.keys(economy.resources.nodes) as ResourceId[]) {
    const area = resourceArea(resourceId)
    if (!area) continue

    events.push({
      id: `sign:area:${resourceId}`,
      x: area.x,
      y: Math.max(32, area.y - area.radius + 12),
      event: signEvent(`ironblock:sign:area:${resourceId}`),
    })

    resourceNodePositions(resourceId).forEach((point, index) => {
      events.push({
        id: resourceNodeEventName(resourceId, index),
        x: point.x,
        y: point.y,
        event: resourceEvent(resourceId, index),
      })
    })
  }

  return events
}

export const worldModule = defineModule<RpgServer>({
  maps: [
    {
      id: world.mapId,
      events: buildWorldEvents(),
    },
  ],
})

export default worldModule
