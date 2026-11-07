import type { AuthSessionResponse } from "../../shared/auth/types";

/**
 * Per-tab session cache with an in-memory fallback.
 *
 * `sessionStorage` is normally available. Private browsing, embedded webviews
 * and storage policies can make it throw; in that case the current page can
 * still connect to the game, but a reload requires signing in again.
 */
export interface AuthSessionCache {
  save(session: AuthSessionResponse): void;
  read(): AuthSessionResponse | undefined;
  clear(): void;
}

/** Backwards-compatible alias for existing NEAR Auth imports. */
export type NearAuthSessionCache = AuthSessionCache;

export function createAuthSessionCache(
  storageKey: string,
): AuthSessionCache {
  let memorySession: AuthSessionResponse | undefined;

  return {
    save(session) {
      if (!isAuthSessionResponse(session)) return;
      memorySession = session;
      try {
        window.sessionStorage.setItem(storageKey, JSON.stringify(session));
      } catch {
        // Keep the in-memory copy for this page.
      }
    },

    read() {
      try {
        const raw = window.sessionStorage.getItem(storageKey);
        if (raw) {
          const parsed: unknown = JSON.parse(raw);
          if (isUsableSession(parsed)) {
            memorySession = parsed;
            return parsed;
          }
          window.sessionStorage.removeItem(storageKey);
        }
      } catch {
        // Fall through to the in-memory copy.
      }

      if (isUsableSession(memorySession)) return memorySession;
      memorySession = undefined;
      return undefined;
    },

    clear() {
      memorySession = undefined;
      try {
        window.sessionStorage.removeItem(storageKey);
      } catch {
        // Storage was already unavailable.
      }
    },
  };
}

/** Backwards-compatible alias for existing NEAR Auth imports. */
export const createNearAuthSessionCache = createAuthSessionCache;

export function isAuthSessionResponse(
  value: unknown,
): value is AuthSessionResponse {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<AuthSessionResponse>;
  const player = candidate.player as
    | Partial<AuthSessionResponse["player"]>
    | undefined;
  if (
    candidate.authMode !== "near" &&
    candidate.authMode !== "auth0"
  ) {
    return false;
  }
  if (
    typeof candidate.sessionToken !== "string" ||
    candidate.sessionToken.length <= 40 ||
    typeof candidate.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(candidate.expiresAt)) ||
    typeof player?.id !== "string" ||
    typeof player.displayName !== "string" ||
    typeof player.auth0SubjectHash !== "string"
  ) {
    return false;
  }
  if (
    player.nearPublicKey !== undefined &&
    typeof player.nearPublicKey !== "string"
  ) {
    return false;
  }
  if (
    player.nearAccountId !== undefined &&
    typeof player.nearAccountId !== "string"
  ) {
    return false;
  }
  if (
    player.nearAccountSource !== undefined &&
    player.nearAccountSource !== "mpc" &&
    player.nearAccountSource !== "player"
  ) {
    return false;
  }
  return true;
}

/** Backwards-compatible alias for existing NEAR Auth imports. */
export const isNearAuthSessionResponse = isAuthSessionResponse;

function isUsableSession(value: unknown): value is AuthSessionResponse {
  return (
    isAuthSessionResponse(value) &&
    Date.parse(value.expiresAt) > Date.now()
  );
}
