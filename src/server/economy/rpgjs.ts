import { defineModule } from '@rpgjs/common'
import type { RpgPlayer, RpgServer, RpgServerEngine } from '@rpgjs/server'
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
 * server instance. It deliberately does not advance economy time from the
 * realtime frame hook: the world/time owner should call `service.tick(seconds)`
 * at the cadence it wants, which keeps fast-forward and live play deterministic.
 */
export const economyServerModule = defineModule<RpgServer>({
  engine: {
    async onStart(server: RpgServerEngine) {
      // The standalone RPGJS build reuses the server module in the browser. The
      // economy service owns a Node filesystem store, so only start it in the
      // authoritative Node process.
      if (typeof process === 'undefined' || !process.versions?.node) return

      const service = await startEconomyService()
      ;(server as EconomyServer)[ECONOMY_SERVER_PROPERTY] = service
    },
    onStep() {
      // Intentionally empty. Economy simulation time is advanced explicitly via
      // EconomyService.tick() or EconomyService.fastForward(), not per render frame.
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
