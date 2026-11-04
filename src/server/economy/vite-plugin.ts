import type { Plugin, PreviewServer, ViteDevServer } from "vite";
import {
  createEconomyHttpHandler,
  type EconomyHttpOptions,
} from "./http";
import { stopLiveEconomy } from "./live";
import { ensureLiveEconomy, type StartEconomyOptions } from "./runtime";

export interface EconomyApiPluginOptions extends EconomyHttpOptions {
  /** Overrides for the lazily started economy service (save path, autoSave). */
  economy?: StartEconomyOptions;
}

/**
 * Mount the authenticated economy API on the Vite dev and preview servers.
 *
 * The handler shares the NEAR Auth store with the socket and `/api/auth/*`
 * routes, and shares the economy service singleton with the game server. The
 * same host boot also starts the process-wide live NPC loop; the observability
 * plugin calls the same idempotent starter, so only one loop can exist.
 */
export function economyApiPlugin(options: EconomyApiPluginOptions = {}): Plugin {
  const { economy, ...handlerOptions } = options;

  const mount = (server: ViteDevServer | PreviewServer): void => {
    server.middlewares.use(createEconomyHttpHandler(handlerOptions));

    // Booting is fire-and-forget: a slow disk read must not delay Vite.
    void ensureLiveEconomy(economy ?? {}).catch((error) => {
      console.warn(
        "[ironblock] live economy failed to start:",
        error instanceof Error ? error.message : String(error),
      );
    });

    server.httpServer?.once("close", () => {
      void stopLiveEconomy();
    });
  };

  return {
    name: "ironblock:economy-api",
    configureServer(server) {
      mount(server);
    },
    configurePreviewServer(server) {
      mount(server);
    },
  };
}
