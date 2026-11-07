import { randomUUID } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import type {
  AuthMode,
  NearAccountSource,
} from "../../shared/auth/types";
import { SESSION_AUDIENCE, SESSION_ISSUER, type ServerAuthConfig } from "./config";
import { AuthError } from "./errors";

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
  /** Which login path produced this session. */
  authMode: AuthMode;
  /** MPC-derived key, present only in local NEAR Auth mode. */
  nearPublicKey?: string;
  /** Payout account; optional in Auth0 mode until the player sets one. */
  nearAccountId?: string;
  nearAccountSource?: NearAccountSource;
  auth0SubjectHash: string;
  /** Unix seconds. */
  issuedAt: number;
  /** Unix seconds. */
  expiresAt: number;
}

/** Minimal identity accepted by the session issuer. */
export interface SessionIdentity {
  playerId: string;
  displayName: string;
  authMode?: AuthMode;
  nearPublicKey?: string;
  nearAccountId?: string;
  nearAccountSource?: NearAccountSource;
  auth0SubjectHash: string;
}

export interface IssuedGameSession {
  token: string;
  claims: GameSessionClaims;
  expiresAt: string;
}

/** Sign a game-session token after the identity provider has been verified. */
export async function issueGameSession(
  identity: SessionIdentity,
  config: ServerAuthConfig,
): Promise<IssuedGameSession> {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + config.sessionTtlSeconds;
  const sessionId = randomUUID();
  const key = new TextEncoder().encode(config.sessionSecret);
  const authMode = identity.authMode ?? "near";
  const nearAccountSource =
    identity.nearAccountSource ??
    (identity.nearPublicKey ? "mpc" : identity.nearAccountId ? "player" : undefined);

  const claims: GameSessionClaims = {
    sessionId,
    playerId: identity.playerId,
    displayName: identity.displayName,
    authMode,
    auth0SubjectHash: identity.auth0SubjectHash,
    issuedAt: now,
    expiresAt,
    ...(identity.nearPublicKey
      ? { nearPublicKey: identity.nearPublicKey }
      : {}),
    ...(identity.nearAccountId
      ? { nearAccountId: identity.nearAccountId }
      : {}),
    ...(nearAccountSource ? { nearAccountSource } : {}),
  };

  const token = await new SignJWT({
    displayName: claims.displayName,
    authMode: claims.authMode,
    auth0SubjectHash: claims.auth0SubjectHash,
    ...(claims.nearPublicKey ? { nearPublicKey: claims.nearPublicKey } : {}),
    ...(claims.nearAccountId ? { nearAccountId: claims.nearAccountId } : {}),
    ...(claims.nearAccountSource
      ? { nearAccountSource: claims.nearAccountSource }
      : {}),
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
    claims,
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
  const authMode = readAuthMode(payload, config.mode);
  const nearPublicKey =
    typeof payload.nearPublicKey === "string" ? payload.nearPublicKey : undefined;
  const nearAccountId =
    typeof payload.nearAccountId === "string" ? payload.nearAccountId : undefined;
  const nearAccountSource =
    payload.nearAccountSource === "mpc" || payload.nearAccountSource === "player"
      ? payload.nearAccountSource
      : nearPublicKey
        ? "mpc"
        : nearAccountId
          ? "player"
          : undefined;

  if (
    typeof playerId !== "string" ||
    typeof sessionId !== "string" ||
    typeof payload.auth0SubjectHash !== "string" ||
    typeof payload.displayName !== "string" ||
    typeof payload.iat !== "number" ||
    typeof payload.exp !== "number"
  ) {
    throw new AuthError("SESSION_INVALID", 401, "Game session claims are incomplete");
  }

  if (authMode !== config.mode) {
    throw new AuthError(
      "SESSION_INVALID",
      401,
      "Game session was issued for a different authentication mode",
    );
  }

  if (
    authMode === "near" &&
    (!nearPublicKey || !nearAccountId)
  ) {
    throw new AuthError("SESSION_INVALID", 401, "Game session claims are incomplete");
  }

  return {
    sessionId,
    playerId,
    displayName: payload.displayName,
    authMode,
    nearPublicKey,
    nearAccountId,
    nearAccountSource,
    auth0SubjectHash: payload.auth0SubjectHash,
    issuedAt: payload.iat,
    expiresAt: payload.exp,
  };
}

function readAuthMode(
  payload: Record<string, unknown>,
  configured: AuthMode,
): AuthMode {
  if (payload.authMode === "auth0" || payload.authMode === "near") {
    return payload.authMode;
  }
  // Sessions issued before auth modes existed were NEAR Auth sessions.
  return typeof payload.nearPublicKey === "string" ? "near" : configured;
}
