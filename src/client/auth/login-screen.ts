import type { NearAuthSessionResponse } from "../../shared/auth/types";
import {
  clearNearAuthSession,
  loginWithNearAuth,
  NearAuthFlowError,
  readNearAuthSession,
  restoreNearAuthSession,
} from "./near-auth";

export interface LoginScreenOptions {
  /** Called after the server has issued a session; connect the game here. */
  onAuthenticated: (session: NearAuthSessionResponse) => Promise<void>;
}

export interface LoginScreen {
  readonly element: HTMLElement;
  setBusy(message: string): void;
  showError(message: string): void;
  remove(): void;
}

const STYLES = `
.ib-auth {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: grid;
  place-items: center;
  padding: 24px;
  background:
    radial-gradient(circle at 20% 15%, rgba(245, 158, 11, 0.18), transparent 35%),
    radial-gradient(circle at 80% 85%, rgba(56, 189, 248, 0.14), transparent 40%),
    linear-gradient(145deg, #0b1020 0%, #111827 55%, #1b1208 100%);
  color: #f8fafc;
  font-family: Fredoka, system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
}
.ib-auth *, .ib-auth *::before, .ib-auth *::after { box-sizing: border-box; }
.ib-auth__panel {
  width: min(430px, 100%);
  padding: 34px 32px 28px;
  border: 1px solid rgba(251, 191, 36, 0.28);
  border-radius: 22px;
  background: linear-gradient(180deg, rgba(17, 24, 39, 0.96), rgba(10, 15, 28, 0.98));
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.06);
}
.ib-auth__brand {
  margin: 0 0 18px;
  color: #fbbf24;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.28em;
  text-transform: uppercase;
}
.ib-auth__title {
  margin: 0 0 10px;
  font-size: clamp(26px, 5vw, 34px);
  line-height: 1.1;
  letter-spacing: -0.02em;
}
.ib-auth__copy {
  margin: 0 0 24px;
  color: #cbd5e1;
  font-size: 15px;
  line-height: 1.55;
}
.ib-auth__button {
  width: 100%;
  margin: 0 0 12px;
  padding: 14px 18px;
  border: 1px solid rgba(148, 163, 184, 0.28);
  border-radius: 12px;
  background: rgba(30, 41, 59, 0.88);
  color: #f8fafc;
  font: inherit;
  font-size: 16px;
  font-weight: 600;
  cursor: pointer;
  transition: transform 120ms ease, border-color 120ms ease, background 120ms ease;
}
.ib-auth__button:hover:not(:disabled) {
  transform: translateY(-1px);
  border-color: rgba(251, 191, 36, 0.65);
  background: rgba(51, 65, 85, 0.95);
}
.ib-auth__button:focus-visible {
  outline: 2px solid #fbbf24;
  outline-offset: 2px;
}
.ib-auth__button--primary {
  border-color: #f59e0b;
  background: linear-gradient(180deg, #fbbf24, #f59e0b);
  color: #1c1204;
}
.ib-auth__button--primary:hover:not(:disabled) {
  background: linear-gradient(180deg, #fcd34d, #f59e0b);
  border-color: #fcd34d;
}
.ib-auth__button:disabled { cursor: progress; opacity: 0.55; }
.ib-auth__status {
  min-height: 24px;
  margin: 8px 0 4px;
  color: #cbd5e1;
  font-size: 14px;
  line-height: 1.45;
}
.ib-auth__status[data-kind="error"] { color: #fca5a5; }
.ib-auth__status[data-kind="busy"]::before {
  content: "";
  display: inline-block;
  width: 10px;
  height: 10px;
  margin-right: 8px;
  border: 2px solid rgba(251, 191, 36, 0.3);
  border-top-color: #fbbf24;
  border-radius: 50%;
  animation: ib-auth-spin 700ms linear infinite;
  vertical-align: -1px;
}
.ib-auth__fine {
  margin: 16px 0 0;
  padding-top: 16px;
  border-top: 1px solid rgba(148, 163, 184, 0.16);
  color: #94a3b8;
  font-size: 12px;
  line-height: 1.5;
}
@keyframes ib-auth-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .ib-auth__status[data-kind="busy"]::before { animation: none; }
  .ib-auth__button { transition: none; }
}
@media (max-width: 480px) {
  .ib-auth__panel { padding: 28px 22px 22px; }
}
`;

/**
 * Login screen for the RPGJS client. It renders as a DOM overlay above the
 * deferred game canvas, so no map connection or wallet exists before login.
 */
export function showLoginScreen(options: LoginScreenOptions): LoginScreen {
  installStyles();

  const root = document.createElement("div");
  root.className = "ib-auth";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-labelledby", "ib-auth-title");
  root.innerHTML = `
    <div class="ib-auth__panel">
      <p class="ib-auth__brand">Ironblock · NEAR testnet</p>
      <h1 class="ib-auth__title" id="ib-auth-title">Enter the market town</h1>
      <p class="ib-auth__copy">
        Sign in with NEAR Auth to create your player identity.
        No wallet extension, seed phrase or gas prompt.
      </p>
      <button class="ib-auth__button ib-auth__button--primary" type="button" data-method="google">
        Continue with Google
      </button>
      <button class="ib-auth__button" type="button" data-method="email">
        Continue with email
      </button>
      <div class="ib-auth__status" role="status" aria-live="polite"></div>
      <p class="ib-auth__fine">
        Testnet only. Your NEAR key is derived by the MPC network; this app
        never receives a private key.
      </p>
    </div>
  `;

  document.body.appendChild(root);

  const status = root.querySelector<HTMLElement>(".ib-auth__status")!;
  const buttons = Array.from(
    root.querySelectorAll<HTMLButtonElement>("button[data-method]"),
  );

  const setIdle = (message = "") => {
    root.setAttribute("aria-busy", "false");
    status.dataset.kind = "idle";
    status.textContent = message;
    buttons.forEach((button) => (button.disabled = false));
  };

  const setBusy = (message: string) => {
    root.setAttribute("aria-busy", "true");
    status.dataset.kind = "busy";
    status.textContent = message;
    buttons.forEach((button) => (button.disabled = true));
  };

  const showError = (message: string) => {
    root.setAttribute("aria-busy", "false");
    status.dataset.kind = "error";
    status.textContent = message;
    buttons.forEach((button) => (button.disabled = false));
  };

  const screen: LoginScreen = {
    element: root,
    setBusy,
    showError,
    remove: () => root.remove(),
  };

  const finish = async (session: NearAuthSessionResponse) => {
    setBusy("Session verified. Entering the town…");
    try {
      await options.onAuthenticated(session);
      screen.remove();
    } catch (error) {
      clearNearAuthSession();
      showError(
        error instanceof Error && error.message
          ? `The game connection failed: ${error.message}`
          : "The game connection failed. Please try again.",
      );
    }
  };

  for (const button of buttons) {
    button.addEventListener("click", () => {
      const method = button.dataset.method === "google" ? "google" : "email";
      setBusy(
        method === "google"
          ? "Opening Google sign-in…"
          : "Opening the Auth0 email sign-in…",
      );
      void loginWithNearAuth(method)
        .then(finish)
        .catch((error: unknown) => {
          showError(
            error instanceof NearAuthFlowError
              ? error.message
              : "Sign-in failed. Please try again.",
          );
        });
    });
  }

  // Restore a session from this tab before asking the player to sign in again.
  if (readNearAuthSession()) {
    setBusy("Checking your last session…");
    void restoreNearAuthSession()
      .then((session) => {
        if (!session) {
          setIdle();
          return;
        }
        void finish(session);
      })
      .catch(() => setIdle());
  } else {
    setIdle();
  }

  return screen;
}

let stylesInstalled = false;

function installStyles(): void {
  if (stylesInstalled) return;
  const style = document.createElement("style");
  style.dataset.ironblockAuth = "true";
  style.textContent = STYLES;
  document.head.appendChild(style);
  stylesInstalled = true;
}
