import type { Plugin } from "vite";
import {
  createSettlementHttpHandler,
  type SettlementHttpOptions,
} from "./http";

/**
 * Mount the settlement API on the Vite dev and preview servers (same pattern
 * as the NEAR Auth plugin).
 *
 * `vite preview` validates the built assets plus the auth/settlement HTTP
 * routes but not the RPGJS WebSocket transport; use `npm start` to play.
 */
export function settlementApiPlugin(options: SettlementHttpOptions = {}): Plugin {
  const handler = createSettlementHttpHandler(options);
  return {
    name: "ironblock:settlement-api",
    configureServer(server) {
      // Mounted after the auth plugin; both accept origin-root and subpath forms.
      server.middlewares.use((req, res, next) => handler(req, res, next));
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => handler(req, res, next));
    },
  };
}
