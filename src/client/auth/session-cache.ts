import type { NearAuthSessionResponse } from "../../shared/auth/types";

/**
 * Per-tab session cache with an in-memory fallback.
 *
 * `sessionStorage` is normally available. Private browsing, embedded webviews
 * and storage policies can make it throw; in that case the current page can
 * still connect to the game, but a reload requires signing in again.
 */
export interface NearAuthSessionCache {
  save(session: NearAuthSessionResponse): void;
  read(): NearAuthSessionResponse | undefined;
  clear(): void;
}

export function createNearAuthSessionCache(
  storageKey: string,
): NearAuthSessionCache {
  let memorySession: NearAuthSessionResponse | undefined;

  return {
    save(session) {
      if (!isNearAuthSessionResponse(session)) return;
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

export function isNearAuthSessionResponse(
  value: unknown,
): value is NearAuthSessionResponse {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<NearAuthSessionResponse>;
  return (
    typeof candidate.sessionToken === "string" &&
    candidate.sessionToken.length > 40 &&
    typeof candidate.expiresAt === "string" &&
    Number.isFinite(Date.parse(candidate.expiresAt)) &&
    typeof candidate.player?.id === "string" &&
    typeof candidate.player?.nearPublicKey === "string" &&
    typeof candidate.player?.nearAccountId === "string"
  );
}

function isUsableSession(value: unknown): value is NearAuthSessionResponse {
  return (
    isNearAuthSessionResponse(value) &&
    Date.parse(value.expiresAt) > Date.now()
  );
}
