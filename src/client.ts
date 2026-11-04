import "./client/polyfills";
import {
  RpgClientEngine,
  inject,
  provideMmorpg,
  startGame,
} from "@rpgjs/client";
import configClient from "./config/config.client";
import { mergeConfig } from "@signe/di";
import { showLoginScreen } from "./client/auth/login-screen";
import {
  clearNearAuthSession,
  readNearAuthSession,
  restoreNearAuthSession,
} from "./client/auth/near-auth";

/**
 * One-shot reload marker.
 *
 * The world client module builds its economy client during `startGame()`, before
 * the login popup resolves. On the first successful login we reload once so the
 * module can see the stored session and mount the authoritative HTTP client.
 * The marker prevents a reload loop if the session cannot be restored again.
 */
const SESSION_RELOAD_KEY = "ironblock.auth-reloaded-for-session";

function canUseStorage(): boolean {
  try {
    return typeof window !== "undefined" && Boolean(window.sessionStorage);
  } catch {
    return false;
  }
}

function hasReloadedForSession(): boolean {
  if (!canUseStorage()) return false;
  try {
    return window.sessionStorage.getItem(SESSION_RELOAD_KEY) === "1";
  } catch {
    return false;
  }
}

function markReloadedForSession(): void {
  if (!canUseStorage()) return;
  try {
    window.sessionStorage.setItem(SESSION_RELOAD_KEY, "1");
  } catch {
    // If storage is unavailable the in-place connect fallback still works.
  }
}

function clearReloadMarker(): void {
  if (!canUseStorage()) return;
  try {
    window.sessionStorage.removeItem(SESSION_RELOAD_KEY);
  } catch {
    // Ignore unavailable storage.
  }
}

/**
 * Ironblock starts in MMORPG mode so the authoritative Node server performs
 * Auth0 JWT verification and issues the game session.
 *
 * `deferConnection` keeps the WebSocket closed until a stored session is
 * validated or the login overlay obtains a new one.
 */
async function boot(): Promise<void> {
  const storedSession = readNearAuthSession();

  await startGame(
    mergeConfig(configClient, {
      providers: [
        provideMmorpg({
          deferConnection: true,
          query: () => {
            const session = readNearAuthSession();
            return session ? { token: session.sessionToken } : {};
          },
        }),
      ],
    }),
  );

  const engine = inject(RpgClientEngine);

  if (storedSession) {
    const restored = await restoreNearAuthSession();
    if (restored) {
      try {
        clearReloadMarker();
        await engine.connect();
        return;
      } catch (error) {
        console.warn(
          "[ironblock] stored session could not connect; asking for a fresh login",
          error instanceof Error ? error.message : error,
        );
        clearNearAuthSession();
      }
    }
    // The stored session could not be validated. Let the next successful
    // login reload once so the world module is rebuilt with the fresh token.
    clearReloadMarker();
  }

  showLoginScreen({
    onAuthenticated: async () => {
      if (!hasReloadedForSession()) {
        markReloadedForSession();
        window.location.reload();
        return;
      }

      // We already reloaded once for this login. Connect in place instead of
      // looping; the HUD explicitly reports the mock fallback if the module
      // could not see a session at boot.
      clearReloadMarker();
      await engine.connect();
    },
  });
}

void boot().catch((error: unknown) => {
  console.error("[ironblock] client startup failed", error);
  const failure = document.createElement("div");
  failure.setAttribute("role", "alert");
  failure.style.cssText =
    "position:fixed;inset:0;z-index:10001;display:grid;place-items:center;padding:24px;background:#0b1020;color:#fca5a5;font:16px system-ui,sans-serif;text-align:center;";
  failure.textContent =
    "Ironblock could not start. Check the browser console and the dev server logs.";
  document.body.appendChild(failure);
});
