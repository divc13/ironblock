import type { Plugin } from "vite";
import {
  createNearAuthHttpHandler,
  type NearAuthHttpOptions,
} from "./http";

/**
 * Mount the NEAR Auth API on the Vite dev and preview servers.
 *
 * `vite preview` is useful for validating built assets and the auth HTTP routes.
 * It does NOT start RPGJS's authoritative WebSocket transport; use
 * `npm start` (scripts/start-production.mjs) for a playable built server.
 */
export function nearAuthApiPlugin(options: NearAuthHttpOptions = {}): Plugin {
  return {
    name: "ironblock:near-auth-api",
    configureServer(server) {
      // Mount at the middleware root: Vite may strip a configured base before
      // reaching our handler. The handler itself accepts `/api/auth/*` both at
      // the origin root and below a deployment subpath.
      server.middlewares.use(createNearAuthHttpHandler(options));
    },
    configurePreviewServer(server) {
      server.middlewares.use(createNearAuthHttpHandler(options));
    },
  };
}
