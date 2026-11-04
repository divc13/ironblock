/**
 * Public authentication DTOs shared by the browser client and the server.
 *
 * SPIKE: these types intentionally cover only what the Phase 1 login spike
 * needs. They contain no secrets and no private-key material.
 */

/** Public view of an authenticated player. */
export interface NearPlayerIdentity {
  /** Stable RPGJS player id derived from the Auth0 subject (not the raw subject). */
  id: string;
  /** Safe display label shown in game. */
  displayName: string;
  /** MPC-derived ed25519 public key, e.g. `ed25519:...`. */
  nearPublicKey: string;
  /** NEAR implicit account id (hex of the 32-byte public key). */
  nearAccountId: string;
  /** Short hash of the Auth0 subject, kept public instead of the raw subject. */
  auth0SubjectHash: string;
}

/** Response returned by `POST /api/auth/near`. */
export interface NearAuthSessionResponse {
  /** Server-issued, HMAC-signed game session token. Never an Auth0 token. */
  sessionToken: string;
  /** ISO timestamp for the session expiry. */
  expiresAt: string;
  player: NearPlayerIdentity;
}

/** Response returned by `GET /api/auth/session`. */
export interface NearAuthSessionInfo {
  expiresAt: string;
  player: NearPlayerIdentity;
}
