import { randomUUID } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import { SESSION_AUDIENCE, SESSION_ISSUER, type ServerAuthConfig } from "./config";
import { AuthError } from "./errors";
import type { VerifiedNearIdentity } from "./near-identity";

/**
 * Ironblock game session. This is deliberately separate from the Auth0 JWT:
 * the browser sends this short-lived token on the RPGJS WebSocket, and the
 * server verifies it without contacting Auth0 again.
 */
export interface GameSessionClaims {
  /** Unique session id (`jti`). */
  sessionId: string;
  playerId: string;
  displayName: string;
  nearPublicKey: string;
  nearAccountId: string;
  auth0SubjectHash: string;
  /** Unix seconds. */
  issuedAt: number;
  /** Unix seconds. */
  expiresAt: number;
}

export interface IssuedGameSession {
  token: string;
  claims: GameSessionClaims;
  expiresAt: string;
}

/** Sign a game-session token after the Auth0 JWT and NEAR key are verified. */
export async function issueGameSession(
  identity: VerifiedNearIdentity,
  config: ServerAuthConfig,
): Promise<IssuedGameSession> {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + config.sessionTtlSeconds;
  const sessionId = randomUUID();
  const key = new TextEncoder().encode(config.sessionSecret);

  const token = await new SignJWT({
    displayName: identity.displayName,
    nearPublicKey: identity.nearPublicKey,
    nearAccountId: identity.nearAccountId,
    auth0SubjectHash: identity.auth0SubjectHash,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(SESSION_ISSUER)
    .setAudience(SESSION_AUDIENCE)
    .setSubject(identity.playerId)
    .setJti(sessionId)
    .setIssuedAt(now)
    .setExpirationTime(expiresAt)
    .sign(key);

  return {
    token,
    claims: {
      sessionId,
      playerId: identity.playerId,
      displayName: identity.displayName,
      nearPublicKey: identity.nearPublicKey,
      nearAccountId: identity.nearAccountId,
      auth0SubjectHash: identity.auth0SubjectHash,
      issuedAt: now,
      expiresAt,
    },
    expiresAt: new Date(expiresAt * 1000).toISOString(),
  };
}

/** Verify a game-session token from the WebSocket query or HTTP header. */
export async function verifyGameSessionToken(
  token: string,
  config: ServerAuthConfig,
): Promise<GameSessionClaims> {
  if (typeof token !== "string" || token.length < 40 || token.length > 8_192) {
    throw new AuthError("SESSION_INVALID", 401, "Missing or malformed game session");
  }

  let payload: Record<string, unknown>;
  try {
    const verified = await jwtVerify(
      token,
      new TextEncoder().encode(config.sessionSecret),
      {
        issuer: SESSION_ISSUER,
        audience: SESSION_AUDIENCE,
        algorithms: ["HS256"],
        clockTolerance: 5,
        requiredClaims: ["sub", "jti", "exp", "iat"],
      },
    );
    payload = verified.payload as Record<string, unknown>;
  } catch {
    throw new AuthError(
      "SESSION_INVALID",
      401,
      "Game session is invalid or expired",
    );
  }

  const playerId = payload.sub;
  const sessionId = payload.jti;
  if (
    typeof playerId !== "string" ||
    typeof sessionId !== "string" ||
    typeof payload.nearPublicKey !== "string" ||
    typeof payload.nearAccountId !== "string" ||
    typeof payload.auth0SubjectHash !== "string" ||
    typeof payload.displayName !== "string" ||
    typeof payload.iat !== "number" ||
    typeof payload.exp !== "number"
  ) {
    throw new AuthError("SESSION_INVALID", 401, "Game session claims are incomplete");
  }

  return {
    sessionId,
    playerId,
    displayName: payload.displayName,
    nearPublicKey: payload.nearPublicKey,
    nearAccountId: payload.nearAccountId,
    auth0SubjectHash: payload.auth0SubjectHash,
    issuedAt: payload.iat,
    expiresAt: payload.exp,
  };
}
