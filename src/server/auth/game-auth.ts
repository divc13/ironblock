import type { RpgServerAuthSocket } from "@rpgjs/server";
import { loadServerAuthConfig } from "./config";
import { verifyGameSessionToken } from "./session";

/** Ephemeral, server-only identity data passed to RPGJS player hooks. */
export interface GameAuthData {
  sessionId: string;
  nearPublicKey: string;
  nearAccountId: string;
  auth0SubjectHash: string;
  displayName: string;
}

/**
 * RPGJS engine `auth()` implementation.
 *
 * The browser sends the server-issued game session token as the `token` query
 * parameter. The Auth0 JWT itself is never used as the long-lived game token.
 */
export async function authenticateGameSocket(
  socket: RpgServerAuthSocket,
): Promise<{ id: string; data: GameAuthData }> {
  const token = socket.handshake.query.token;
  if (!token) {
    throw new Error("Authentication required: missing game session");
  }

  try {
    const claims = await verifyGameSessionToken(
      token,
      loadServerAuthConfig(),
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
