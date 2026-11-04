import { defineModule } from '@rpgjs/common'
import type { RpgPlayer, RpgServer, RpgServerEngine } from '@rpgjs/server'
import { startLiveEconomy } from './live'
import type { EconomyService } from './service'
import { getEconomyServiceOrNull, startEconomyService } from './runtime'

/** Property attached to the RPGJS server engine for module-to-module access. */
export const ECONOMY_SERVER_PROPERTY = 'economy'

type EconomyServer = RpgServerEngine & {
  [ECONOMY_SERVER_PROPERTY]?: EconomyService
}

/**
 * Server-only RPGJS module.
 *
 * It starts the persisted world when the engine starts and exposes it on the
 * server instance. The live loop (shared with the production/Vite hosts) then
 * advances `service.tick()` every real second; explicit `tick()` and
 * `fastForward()` calls remain serialized through the same service queue.
 */
export const economyServerModule = defineModule<RpgServer>({
  engine: {
    async onStart(server: RpgServerEngine) {
      // The standalone RPGJS build reuses the server module in the browser. The
      // economy service owns a Node filesystem store, so only start it in the
      // authoritative Node process.
      if (typeof process === 'undefined' || !process.versions?.node) return

      const service = await startEconomyService()
      startLiveEconomy(service)
      ;(server as EconomyServer)[ECONOMY_SERVER_PROPERTY] = service
    },
    onStep() {
      // Economy time is owned by the live timer, not the render frame. Keeping
      // this empty means frame rate can never change simulation speed.
    },
  },
  player: {
    async onConnected(player: RpgPlayer) {
      const service = getEconomyServiceOrNull()
      if (!service) return

      // `player.id` is the stable id returned by the verified NEAR Auth game
      // session (Phase 1), never a client-supplied id. Ensuring here links the
      // authoritative economy player to the authenticated socket identity.
      await service.ensurePlayer(player.id, player.name)
    },
  },
})

export function economyServiceForServer(
  server: RpgServerEngine,
): EconomyService | null {
  return (server as EconomyServer)[ECONOMY_SERVER_PROPERTY] ?? null
}
