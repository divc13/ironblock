import type { RpgServerAuthSocket } from "@rpgjs/server";
import {
  loadServerAuthConfig,
  type ServerAuthConfig,
} from "./config";
import { defaultAuthStore, verifyActiveGameSession } from "./service";
import { InMemoryAuthStore } from "./store";

/** Ephemeral, server-only identity data passed to RPGJS player hooks. */
export interface GameAuthData {
  sessionId: string;
  nearPublicKey: string;
  nearAccountId: string;
  auth0SubjectHash: string;
  displayName: string;
}

export interface GameAuthDeps {
  config?: ServerAuthConfig;
  store?: InMemoryAuthStore;
}

/**
 * RPGJS engine `auth()` implementation.
 *
 * The browser sends the server-issued game session token as the `token` query
 * parameter. The Auth0 JWT itself is never used as the long-lived game token.
 *
 * Expiry is enforced at connect time. This spike does not forcibly disconnect a
 * socket that is already connected when its token TTL elapses; use a short TTL
 * and reconnect-on-expiry for stronger guarantees.
 */
export async function authenticateGameSocket(
  socket: RpgServerAuthSocket,
  deps: GameAuthDeps = {},
): Promise<{ id: string; data: GameAuthData }> {
  const token = socket.handshake.query.token;
  if (typeof token !== "string" || !token) {
    throw new Error("Authentication required: missing game session");
  }

  try {
    const claims = await verifyActiveGameSession(
      token,
      deps.config ?? loadServerAuthConfig(),
      deps.store ?? defaultAuthStore,
    );
    return {
      id: claims.playerId,
      data: {
        sessionId: claims.sessionId,
        nearPublicKey: claims.nearPublicKey,
        nearAccountId: claims.nearAccountId,
        auth0SubjectHash: claims.auth0SubjectHash,
        displayName: claims.displayName,
      },
    };
  } catch {
    // Deliberately do not include token details in the connection error.
    throw new Error("Authentication failed: invalid or expired game session");
  }
}
