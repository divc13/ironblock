import type {
  NearAuthSessionInfo,
  NearAuthSessionResponse,
  NearPlayerIdentity,
} from "../../shared/auth/types";
import { AuthError } from "./errors";
import { verifyAuth0Token } from "./jwt";
import {
  verifyNearIdentityForSubject,
  type DerivedPublicKeyLookup,
} from "./near-identity";
import type { JWTVerifyGetKey } from "jose";
import type { ServerAuthConfig } from "./config";
import {
  issueGameSession,
  verifyGameSessionToken,
  type GameSessionClaims,
} from "./session";
import { InMemoryAuthStore } from "./store";

/** SPIKE: process-local records only. Replace with durable storage later. */
export const defaultAuthStore = new InMemoryAuthStore();

export interface AuthenticateNearLoginInput {
  accessToken: string;
  nearPublicKey: string;
}

export interface AuthenticateNearLoginDeps {
  jwks?: JWTVerifyGetKey;
  lookupDerivedPublicKey?: DerivedPublicKeyLookup;
  store?: InMemoryAuthStore;
}

/**
 * Verify an Auth0 access token, prove that the NEAR key belongs to its subject,
 * then issue an Ironblock game session.
 */
export async function authenticateNearLogin(
  input: AuthenticateNearLoginInput,
  config: ServerAuthConfig,
  deps: AuthenticateNearLoginDeps = {},
): Promise<NearAuthSessionResponse> {
  if (
    typeof input.accessToken !== "string" ||
    input.accessToken.length < 20 ||
    input.accessToken.length > 16_384 ||
    typeof input.nearPublicKey !== "string" ||
    input.nearPublicKey.length < 20 ||
    input.nearPublicKey.length > 128
  ) {
    throw new AuthError(
      "INVALID_REQUEST",
      400,
      "Expected an Auth0 access token and an MPC-derived NEAR public key",
    );
  }

  const claims = await verifyAuth0Token(input.accessToken, config, deps.jwks);
  const identity = await verifyNearIdentityForSubject(
    {
      subject: claims.sub,
      email: claims.email,
      clientPublicKey: input.nearPublicKey,
    },
    config,
    deps.lookupDerivedPublicKey,
  );

  const player: NearPlayerIdentity = {
    id: identity.playerId,
    displayName: identity.displayName,
    nearPublicKey: identity.nearPublicKey,
    nearAccountId: identity.nearAccountId,
    auth0SubjectHash: identity.auth0SubjectHash,
  };

  const store = deps.store ?? defaultAuthStore;
  store.upsertPlayer({
    identity: player,
    auth0Subject: identity.auth0Subject,
    email: claims.email,
  });

  const session = await issueGameSession(identity, config);
  store.createSession(session.claims);
  store.prune();

  return {
    sessionToken: session.token,
    expiresAt: session.expiresAt,
    player,
  };
}

/** Validate a game session for the restore-session endpoint. */
export async function describeGameSession(
  token: string,
  config: ServerAuthConfig,
  store: InMemoryAuthStore = defaultAuthStore,
): Promise<NearAuthSessionInfo> {
  const claims: GameSessionClaims = await verifyGameSessionToken(token, config);
  // If this process has issued sessions, use its record to reject revoked or
  // expired ones. A fresh process (before any login) falls back to the signed
  // token itself; the token remains the source of truth across restarts.
  if (store.hasRecordedSessions && !store.getSession(claims.sessionId)) {
    throw new AuthError("SESSION_INVALID", 401, "Game session has been revoked");
  }

  return {
    expiresAt: new Date(claims.expiresAt * 1000).toISOString(),
    player: {
      id: claims.playerId,
      displayName: claims.displayName,
      nearPublicKey: claims.nearPublicKey,
      nearAccountId: claims.nearAccountId,
      auth0SubjectHash: claims.auth0SubjectHash,
    },
  };
}
