import type { Plugin } from "vite";
import {
  createNearAuthHttpHandler,
  type NearAuthHttpOptions,
} from "./http";

/**
 * Mount the Phase 1 NEAR Auth API on the Vite development server.
 *
 * SPIKE: production hosting is out of scope. The same handler can be mounted
 * on a Node HTTP server by the settlement phase.
 */
export function nearAuthApiPlugin(options: NearAuthHttpOptions = {}): Plugin {
  return {
    name: "ironblock:near-auth-api",
    configureServer(server) {
      server.middlewares.use("/api/auth", createNearAuthHttpHandler(options));
    },
  };
}
