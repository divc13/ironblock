import type {
  ItemInfo,
  OnchainAccountView,
  WithdrawRequest,
  WithdrawalView,
} from "../../shared/settlement/types";

/**
 * Withdrawal proof panel (browser; testnet only).
 *
 * A small vanilla-DOM module the world UI can mount later:
 *
 *   import { mountWithdrawPanel } from './settlement/withdraw-panel';
 *   const panel = mountWithdrawPanel({
 *     container: document.getElementById('withdraw-panel')!,
 *     apiBase: '/',                       // subpath builds pass e.g. '/quest/'
 *     // session discovery: same cache the login screen writes
 *     getSessionToken: () => window.sessionStorage.getItem('ironblock_session') ?? undefined,
 *   });
 *   // later: panel.destroy();
 *
 * Failure surfaces pending/confirmed/failed with the tx hash + explorer url of
 * the NEP-245 transfer. There is no wallet extension, seed phrase, gas prompt
 * or client-side signing: the authority server transfers from its treasury.
 */

export interface WithdrawPanelOptions {
  container: HTMLElement;
  /** Same guard as the login screen: the server-issued game-session token. */
  getSessionToken?: () => string | undefined;
  /** Settlement API prefix, default `/api/settlement` under the base. */
  apiBase?: string;
  /** Called when the player presses the reauth prompt. */
  onSessionNeeded?: () => void;
}

export interface WithdrawPanel {
  destroy(): void;
  refresh(): Promise<void>;
}

const MAX_POLL_INTERVAL_MS = 4_000;

export function mountWithdrawPanel(options: WithdrawPanelOptions): WithdrawPanel {
  const root = document.createElement("div");
  root.className = "ironblock-withdraw-panel";
  root.innerHTML = `
    <style>
      .ironblock-withdraw-panel { font: 13px/1.45 system-ui, sans-serif; }
      .ironblock-withdraw-panel fieldset { border: 1px solid #cbd5e1; border-radius: 10px; padding: 12px; }
      .ironblock-withdraw-panel .wb-row { display: flex; gap: 8px; align-items: center; margin: 8px 0; }
      .ironblock-withdraw-panel .wb-token { flex: 1; }
      .ironblock-withdraw-panel .wb-account { word-break: break-all; opacity: .8; }
      .ironblock-withdraw-panel .wb-warn { color: #b45309; font-weight: 600; }
      .ironblock-withdraw-panel .wb-tx a { font-family: ui-monospace, monospace; }
      .ironblock-withdraw-panel button { cursor: pointer; }
      .ironblock-withdraw-panel button:disabled { cursor: not-allowed; opacity: .5; }
    </style>
    <fieldset>
      <legend>Withdraw items (NEAR testnet)</legend>
      <div class="wb-warn">Testnet only: withdrawing sends a real NEP-245 test-testnet token from the game treasury to your account.</div>
      <div class="wb-account" data-role="account">Loading session…</div>
      <div class="wb-copy">Your game items live in the server ledger until you withdraw them on testnet.</div>
      <div class="wb-row">
        <select class="wb-token" data-role="token" title="Item"></select>
        <input data-role="amount" type="number" min="1" step="1" value="1" title="Amount"/>
        <button data-role="withdraw" disabled>Withdraw</button>
      </div>
      <div class="wb-balances" data-role="balances"></div>
      <div class="wb-status" data-role="status"></div>
      <div class="wb-tx" data-role="tx"></div>
    </fieldset>
  `;

  const el = (role: string): HTMLElement => root.querySelector(`[data-role="${role}"]`) as HTMLElement;
  const tokenSelect = el("token") as unknown as HTMLSelectElement;
  const amountInput = el("amount") as unknown as HTMLInputElement;
  const withdrawButton = el("withdraw") as HTMLButtonElement;
  const accountEl = el("account");
  const balancesEl = el("balances");
  const statusEl = el("status");
  const txEl = el("tx");

  options.container.appendChild(root);

  const apiBase = normalizeBase(options.apiBase ?? "/");
  const controller = new AbortController();
  let items: ItemInfo[] = [];
  let balances: Record<string, string> = {};
  let latest: WithdrawalView | undefined;

  let sessionToken = options.getSessionToken?.();
  let accountId = "";

  function setBusy(busy: boolean, label?: string): void {
    withdrawButton.disabled = busy;
    if (label) statusEl.textContent = label;
  }

  async function loadOnchain(): Promise<void> {
    if (!accountId) return;
    const response = await fetchApi(`${apiBase}/api/settlement/onchain/${accountId}`, undefined, controller.signal);
    if (!response.ok) return;
    const view = (await response.json()) as OnchainAccountView;
    balances = view.balances;
    items = view.items;
    renderItems();
    renderBalances();
  }

  function renderItems(): void {
    tokenSelect.innerHTML = "";
    const listed = items.filter(() => true);
    for (const item of listed) {
      const option = document.createElement("option");
      option.value = item.tokenId;
      option.textContent = `${item.tokenId}`;
      tokenSelect.appendChild(option);
    }
  }

  function renderBalances(): void {
    balancesEl.textContent = items.length
      ? `On-chain: ${items.map((i) => `${i.tokenId} ${balances[i.tokenId] ?? "0"}`).join(", ")}`
      : "No on-chain balances yet.";
  }

  async function withdraw(): Promise<void> {
    if (!sessionToken) {
      statusEl.textContent = "Sign in with NEAR Auth first.";
      options.onSessionNeeded?.();
      return;
    }
    const requestId = `wd${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    const body: WithdrawRequest = {
      requestId,
      tokenId: tokenSelect.value,
      amount: Math.max(1, Math.floor(Number(amountInput.value) || 0)),
    };
    setBusy(true, "Submitting withdrawal…");
    try {
      const response = await fetchApi(`${apiBase}/api/settlement/withdraw`, body, controller.signal, sessionToken);
      const record = (await response.json()) as WithdrawalView | { error: { message: string } };
      if (response.status >= 400) {
        statusEl.textContent = (record as { error: { message: string } }).error?.message ?? "Withdrawal failed.";
        return;
      }
      latest = record as WithdrawalView;
      renderWithdrawal();
      await loadOnchain();
    } catch {
      statusEl.textContent = "Network error while submitting withdrawal.";
    } finally {
      setBusy(false);
    }
  }

  withdrawButton.addEventListener("click", () => void withdraw());
  const poll = setInterval(() => {
    if (latest && (latest.status === "pending" || latest.status === "submitted")) {
      void refresh(latest.id);
    }
  }, 4_000);

  async function refresh(id: string): Promise<void> {
    try {
      const response = await fetchApi(
        `${apiBase}/api/settlement/withdrawals/${id}`,
        undefined,
        controller.signal,
        sessionToken,
      );
      if (!response.ok) return;
      latest = (await response.json()) as WithdrawalView;
      renderWithdrawal();
      await loadOnchain();
    } catch {
      // transient; poll continues
    }
  }

  function renderWithdrawal(): void {
    const record = latest;
    if (!record) return;
    switch (record.status) {
      case "pending":
      case "submitted":
        statusEl.textContent = "Withdrawal in flight — waiting for NEAR testnet FINAL?";
        break;
      case "confirmed":
        statusEl.textContent = "Confirmed: the transfer reached FINAL on testnet and your ledger balance was charged.";
        break;
      case "failed":
      case "refunded":
        statusEl.textContent = record.errorMessage ?? record.errorCode ?? "Withdrawal failed.";
        if (record.status === "refunded") statusEl.textContent += " Reserved items were returned to your ledger balance.";
        break;
      default:
        statusEl.textContent = record.status;
    }
    if (record.txHash) {
      txEl.innerHTML = `tx <a href="${record.explorerUrl}" target="_blank" rel="noreferrer">${record.txHash}</a>`;
    } else {
      txEl.textContent = "";
    }
  }

  async function bootstrap(): Promise<void> {
    try {
      const response = await fetchApi(
        `${apiBase}/api/auth/session`,
        undefined,
        controller.signal,
        sessionToken,
      );
      if (response.ok) {
        const info = (await response.json()) as { player: { nearAccountId: string } };
        accountId = info.player.nearAccountId;
        accountEl.textContent = accountId;
        await loadOnchain();
        return;
      }
    } catch {
      // fallthrough to prompt
    }
    statusEl.textContent = "Sign in with NEAR Auth first.";
    options.onSessionNeeded?.();
  }

  void bootstrap();

  return {
    destroy() {
      clearInterval(poll);
      controller.abort();
      root.remove();
    },
    async refresh() {
      if (latest?.id) await refresh(latest.id);
      else await loadOnchain();
    },
  };
}

function normalizeBase(base: string): string {
  const trimmed = (base || "/").trim().replace(/\/+$/, "");
  return trimmed === "/" ? "" : trimmed;
}

async function fetchApi(
  url: string,
  body: unknown,
  signal: AbortSignal,
  token?: string,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    return fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
  }
  return fetch(url, { headers, signal });
}
