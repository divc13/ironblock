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
  clearAuthSession,
  readAuthSession,
  restoreAuthSession,
} from "./client/auth/session";

/**
 * Ironblock starts in MMORPG mode so the authoritative Node server performs
 * Auth0 token verification and issues the game session.
 *
 * The game is not started until a session exists. This is deliberate: there is
 * no guest path and no local mock economy behind the login screen.
 */
let gamePromise: Promise<RpgClientEngine> | undefined;

async function ensureGame(): Promise<RpgClientEngine> {
  gamePromise ??= startGame(
    mergeConfig(configClient, {
      providers: [
        provideMmorpg({
          deferConnection: true,
          query: () => {
            const session = readAuthSession();
            return session ? { token: session.sessionToken } : {};
          },
        }),
      ],
    }),
  )
    .then(() => inject(RpgClientEngine))
    .catch((error: unknown) => {
      // Let a later retry attempt a clean start instead of caching a rejected
      // promise forever.
      gamePromise = undefined;
      throw error;
    });
  return gamePromise;
}

async function connectGame(): Promise<void> {
  const engine = await ensureGame();
  await engine.connect();
}

async function boot(): Promise<void> {
  const storedSession = readAuthSession();

  if (storedSession) {
    const restored = await restoreAuthSession();
    if (restored) {
      try {
        await connectGame();
        return;
      } catch (error) {
        console.warn(
          "[ironblock] stored session could not connect; asking for a fresh login",
          error instanceof Error ? error.message : error,
        );
        clearAuthSession();
      }
    }
  }

  showLoginScreen({
    onAuthenticated: async () => {
      await connectGame();
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
