import type {
  AuthSessionInfo,
  AuthSessionResponse,
} from "../../shared/auth/types";
import { clientAuthConfig } from "./config";
import {
  createAuthSessionCache,
  isAuthSessionResponse,
} from "./session-cache";

/**
 * The server-issued game session is the only credential kept in the browser.
 * Auth0 tokens stay in the Auth0 SDK's in-memory cache and are never persisted.
 */
const sessionCache = createAuthSessionCache(
  clientAuthConfig.sessionStorageKey,
);

export function saveAuthSession(session: AuthSessionResponse): void {
  sessionCache.save(session);
}

export function readAuthSession(): AuthSessionResponse | null {
  return sessionCache.read() ?? null;
}

export function clearAuthSession(): void {
  sessionCache.clear();
}

/** Restore and re-validate a game session after a reload. */
export async function restoreAuthSession(): Promise<AuthSessionResponse | null> {
  const stored = readAuthSession();
  if (!stored) return null;

  try {
    const response = await fetch(`${clientAuthConfig.loginApiPath}/session`, {
      headers: { authorization: `Bearer ${stored.sessionToken}` },
      credentials: "same-origin",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      clearAuthSession();
      return null;
    }
    const info = (await response.json()) as AuthSessionInfo;
    if (
      !info?.player?.id ||
      !info.expiresAt ||
      (info.authMode !== "near" && info.authMode !== "auth0")
    ) {
      clearAuthSession();
      return null;
    }
    const restored: AuthSessionResponse = {
      sessionToken: stored.sessionToken,
      expiresAt: info.expiresAt,
      player: info.player,
      authMode: info.authMode,
    };
    if (!isAuthSessionResponse(restored)) {
      clearAuthSession();
      return null;
    }
    saveAuthSession(restored);
    return restored;
  } catch {
    clearAuthSession();
    return null;
  }
}

/**
 * Revoke the current game session on the server and clear the local cache.
 * The Auth0 session itself is not persisted by Ironblock.
 */
export async function logoutAuthSession(): Promise<void> {
  const session = readAuthSession();
  clearAuthSession();
  if (!session) return;

  try {
    await fetch(`${clientAuthConfig.loginApiPath}/logout`, {
      method: "POST",
      headers: { authorization: `Bearer ${session.sessionToken}` },
      credentials: "same-origin",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Local sign-out still succeeds if the server is unreachable.
  }
}
