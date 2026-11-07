import type {
  AuthSessionInfo,
  AuthSessionResponse,
  PlayerIdentity,
} from "../../shared/auth/types";
import { isValidNearAccountId } from "../../shared/auth/near-account";
import { AuthError } from "./errors";
import { verifyAuth0Token } from "./jwt";
import {
  displayNameForEmail,
  playerIdForSubject,
  subjectHashForSubject,
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
  /** Per-subject rate/concurrency guard, applied around the MPC lookup. */
  withSubjectLimit?: <T>(
    subject: string,
    task: () => Promise<T>,
  ) => Promise<T>;
}

export interface AuthenticateAuth0LoginInput {
  /** Raw Auth0 OIDC ID token. The server verifies it before trusting `sub`. */
  idToken: string;
  /** Optional player-supplied NEAR testnet payout account. */
  nearAccountId?: string;
}

export interface AuthenticateAuth0LoginDeps {
  jwks?: JWTVerifyGetKey;
  store?: InMemoryAuthStore;
}

/**
 * Verify an Auth0 access token, prove that the NEAR key belongs to its subject,
 * then issue an Ironblock game session. This is the local `near` mode path.
 */
export async function authenticateNearLogin(
  input: AuthenticateNearLoginInput,
  config: ServerAuthConfig,
  deps: AuthenticateNearLoginDeps = {},
): Promise<AuthSessionResponse> {
  if (config.mode !== "near") {
    throw new AuthError(
      "CONFIGURATION",
      500,
      "NEAR Auth login is not enabled on this server",
    );
  }

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
  const verifyIdentity = () =>
    verifyNearIdentityForSubject(
      {
        subject: claims.sub,
        email: claims.email,
        clientPublicKey: input.nearPublicKey,
      },
      config,
      deps.lookupDerivedPublicKey,
    );
  const identity = deps.withSubjectLimit
    ? await deps.withSubjectLimit(claims.sub, verifyIdentity)
    : await verifyIdentity();

  const player: PlayerIdentity = {
    id: identity.playerId,
    displayName: identity.displayName,
    nearPublicKey: identity.nearPublicKey,
    nearAccountId: identity.nearAccountId,
    nearAccountSource: "mpc",
    auth0SubjectHash: identity.auth0SubjectHash,
  };

  const store = deps.store ?? defaultAuthStore;
  store.upsertPlayer({
    identity: player,
    auth0Subject: identity.auth0Subject,
    email: claims.email,
  });

  const session = await issueGameSession(
    { ...player, playerId: player.id, authMode: "near" },
    config,
  );
  store.createSession(session.claims);
  store.prune();

  return {
    sessionToken: session.token,
    expiresAt: session.expiresAt,
    player,
    authMode: "near",
  };
}

/**
 * Authenticate an Auth0 ID token without MPC or a NEAR wallet.
 *
 * The player-supplied account is a payout destination, not a verified identity.
 * It may be absent at login and added later before the first withdrawal.
 */
export async function authenticateAuth0Login(
  input: AuthenticateAuth0LoginInput,
  config: ServerAuthConfig,
  deps: AuthenticateAuth0LoginDeps = {},
): Promise<AuthSessionResponse> {
  if (config.mode !== "auth0") {
    throw new AuthError(
      "CONFIGURATION",
      500,
      "Auth0 login is not enabled on this server",
    );
  }

  if (
    typeof input.idToken !== "string" ||
    input.idToken.length < 20 ||
    input.idToken.length > 16_384
  ) {
    throw new AuthError(
      "INVALID_REQUEST",
      400,
      "Expected an Auth0 ID token",
    );
  }

  const claims = await verifyAuth0Token(input.idToken, config, deps.jwks);
  const subjectHash = subjectHashForSubject(claims.sub);
  const playerId = playerIdForSubject(claims.sub);
  const store = deps.store ?? defaultAuthStore;
  const existing = store.getPlayer(playerId);

  const suppliedAddress = input.nearAccountId?.trim();
  const nearAccountId = suppliedAddress
    ? normalizePayoutAddress(suppliedAddress)
    : existing?.nearAccountId;

  const player: PlayerIdentity = {
    id: playerId,
    displayName: displayNameForEmail(claims.email, subjectHash),
    ...(nearAccountId
      ? { nearAccountId, nearAccountSource: "player" as const }
      : {}),
    auth0SubjectHash: subjectHash,
  };

  store.upsertPlayer({
    identity: player,
    auth0Subject: claims.sub,
    email: claims.email,
  });

  const session = await issueGameSession(
    { ...player, playerId: player.id, authMode: "auth0" },
    config,
  );
  store.createSession(session.claims);
  store.prune();

  return {
    sessionToken: session.token,
    expiresAt: session.expiresAt,
    player,
    authMode: "auth0",
  };
}

/**
 * Set or replace the player-supplied payout account and issue a fresh session.
 * The old session is revoked so a copied old token cannot keep using a stale
 * payout address.
 */
export async function updatePayoutAddress(
  token: string,
  nearAccountId: string,
  config: ServerAuthConfig,
  store: InMemoryAuthStore = defaultAuthStore,
): Promise<AuthSessionResponse> {
  const claims = await verifyActiveGameSession(token, config, store);
  if (claims.authMode !== "auth0") {
    throw new AuthError(
      "ADDRESS_NOT_EDITABLE",
      400,
      "The MPC-derived account cannot be replaced in NEAR Auth mode",
    );
  }

  const address = normalizePayoutAddress(nearAccountId);
  const existing = store.getPlayer(claims.playerId);
  const player: PlayerIdentity = {
    id: claims.playerId,
    displayName: claims.displayName,
    nearAccountId: address,
    nearAccountSource: "player",
    auth0SubjectHash: claims.auth0SubjectHash,
  };

  store.upsertPlayer({
    identity: player,
    auth0Subject: existing?.auth0Subject ?? `session:${claims.playerId}`,
    email: existing?.email,
  });

  const session = await issueGameSession(
    { ...player, playerId: player.id, authMode: "auth0" },
    config,
  );
  store.createSession(session.claims);
  store.revokeSession(claims.sessionId);
  store.prune();

  return {
    sessionToken: session.token,
    expiresAt: session.expiresAt,
    player,
    authMode: "auth0",
  };
}

/**
 * Verify the signed session and, when this process has session records, ensure
 * that record still exists. A fresh process (before any login) falls back to the
 * signed token itself; the token remains the source of truth across restarts.
 */
export async function verifyActiveGameSession(
  token: string,
  config: ServerAuthConfig,
  store: InMemoryAuthStore = defaultAuthStore,
): Promise<GameSessionClaims> {
  const claims = await verifyGameSessionToken(token, config);
  if (store.hasRecordedSessions) {
    const stored = store.getSession(claims.sessionId);
    if (!stored || stored.playerId !== claims.playerId) {
      throw new AuthError("SESSION_INVALID", 401, "Game session has been revoked");
    }
  }
  return claims;
}

/** Validate a game session for the restore-session endpoint. */
export async function describeGameSession(
  token: string,
  config: ServerAuthConfig,
  store: InMemoryAuthStore = defaultAuthStore,
): Promise<AuthSessionInfo> {
  const claims = await verifyActiveGameSession(token, config, store);

  return {
    expiresAt: new Date(claims.expiresAt * 1000).toISOString(),
    player: {
      id: claims.playerId,
      displayName: claims.displayName,
      ...(claims.nearPublicKey
        ? { nearPublicKey: claims.nearPublicKey }
        : {}),
      ...(claims.nearAccountId
        ? { nearAccountId: claims.nearAccountId }
        : {}),
      ...(claims.nearAccountSource
        ? { nearAccountSource: claims.nearAccountSource }
        : {}),
      auth0SubjectHash: claims.auth0SubjectHash,
    },
    authMode: claims.authMode,
  };
}

/**
 * Revoke a signed session. Logout is idempotent for a still-valid signature so
 * repeated sign-out clicks do not surface a misleading error.
 */
export async function revokeGameSession(
  token: string,
  config: ServerAuthConfig,
  store: InMemoryAuthStore = defaultAuthStore,
): Promise<void> {
  const claims = await verifyGameSessionToken(token, config);
  store.revokeSession(claims.sessionId);
}

function normalizePayoutAddress(value: string): string {
  const address = value.trim();
  if (!isValidNearAccountId(address)) {
    throw new AuthError(
      "INVALID_NEAR_ACCOUNT",
      400,
      "Enter a valid NEAR testnet account id, such as example.testnet",
    );
  }
  return address;
}
