import type { Plugin } from "vite";
import {
  createEconomyHttpHandler,
  type EconomyHttpOptions,
} from "./http";

/**
 * Mount the authenticated economy API on the Vite dev and preview servers.
 *
 * The handler shares the NEAR Auth store with the socket and `/api/auth/*`
 * routes, and shares the economy service singleton with the game server.
 */
export function economyApiPlugin(options: EconomyHttpOptions = {}): Plugin {
  return {
    name: "ironblock:economy-api",
    configureServer(server) {
      server.middlewares.use(createEconomyHttpHandler(options));
    },
    configurePreviewServer(server) {
      server.middlewares.use(createEconomyHttpHandler(options));
    },
  };
}
