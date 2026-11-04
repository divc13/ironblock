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
import { readNearAuthSession } from "./client/auth/near-auth";

/**
 * Ironblock starts in MMORPG mode so the authoritative Node server performs
 * Auth0 JWT verification and issues the game session.
 *
 * `deferConnection` keeps the WebSocket closed until the login overlay has a
 * server-issued session. The game canvas and GUI are still booted underneath.
 */
async function boot(): Promise<void> {
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

  showLoginScreen({
    onAuthenticated: async () => {
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
