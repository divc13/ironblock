/**
 * Public authentication DTOs shared by the browser client and the server.
 *
 * These types intentionally contain no secrets and no private-key material.
 */

/** Which identity provider issued the Ironblock game session. */
export type AuthMode = "near" | "auth0";

/** How the session's NEAR payout account was obtained. */
export type NearAccountSource = "mpc" | "player";

/** Public view of an authenticated player. */
export interface PlayerIdentity {
  /** Stable RPGJS player id derived from the Auth0 subject (not the raw subject). */
  id: string;
  /** Safe display label shown in game. */
  displayName: string;
  /**
   * MPC-derived ed25519 public key, e.g. `ed25519:...`.
   * Present only for local `AUTH_MODE=near` sessions.
   */
  nearPublicKey?: string;
  /**
   * NEAR account that receives withdrawals.
   *
   * In `near` mode this is the MPC-derived implicit account. In `auth0` mode
   * it is the player-supplied payout account and may be absent until the
   * player sets one.
   */
  nearAccountId?: string;
  /** Whether the payout account came from MPC derivation or the player. */
  nearAccountSource?: NearAccountSource;
  /** Short hash of the Auth0 subject, kept public instead of the raw subject. */
  auth0SubjectHash: string;
}

/** Response returned by `POST /api/auth/near` or `POST /api/auth/auth0`. */
export interface AuthSessionResponse {
  /** Server-issued, HMAC-signed game session token. Never an Auth0 token. */
  sessionToken: string;
  /** ISO timestamp for the session expiry. */
  expiresAt: string;
  player: PlayerIdentity;
  /** Which login path produced this session. */
  authMode: AuthMode;
}

/** Response returned by `GET /api/auth/session`. */
export interface AuthSessionInfo {
  expiresAt: string;
  player: PlayerIdentity;
  authMode: AuthMode;
}

/** Backwards-compatible aliases for existing NEAR Auth imports. */
export type NearPlayerIdentity = PlayerIdentity;
export type NearAuthSessionResponse = AuthSessionResponse;
export type NearAuthSessionInfo = AuthSessionInfo;
