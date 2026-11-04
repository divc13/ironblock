import { SettlementError } from "./errors";

/**
 * Server-only settlement configuration (NEAR testnet only).
 *
 * Defaults pin the final, verified deployment:
 * - contract: v2.ironblock-items.testnet
 * - treasury: v2.ironblock-treasury.testnet
 *
 * Never include private key material in this object: the treasury key lives
 * only inside the signer created from env/keystore/keychain at request time.
 */
export interface SettlementConfig {
  network: "testnet";
  rpcUrl: string;
  contractId: string;
  treasuryAccountId: string;
  /** Total budget (ms) for broadcasting + waiting for FINAL execution. */
  timeoutMs: number;
  /** Explorer base for building transaction links. */
  explorerTxUrl: string;
  /**
   * How to obtain the treasury key:
   * - inline: NEAR_TREASURY_PRIVATE_KEY (env; CI/injected secrets only)
   * - keystore: NEAR_TREASURY_KEYSTORE_PATH (legacy near JSON keystore file)
   */
  treasuryKeyMode: "inline" | "keystore" | "auto";
  treasuryKeystorePath?: string;
  /** Optional inline key value. Never logged or serialised. */
  treasuryPrivateKey?: string;
}

const DEFAULTS = {
  network: "testnet" as const,
  rpcUrl: "https://rpc.testnet.fastnear.com",
  contractId: "v2.ironblock-items.testnet",
  treasuryAccountId: "v2.ironblock-treasury.testnet",
  timeoutMs: 45_000,
  explorerTxUrl: "https://explorer.testnet.near.org/transactions/",
} as const;

const ACCOUNT_ID_RE = /^[a-z0-9._-]{2,64}$/;
const HEX_IMPL_RE = /^[0-9a-f]{64}$/;

export const SETTLEMENT_DEFAULTS = DEFAULTS;

/** True for the MPC-derived implicit accounts used by NEAR Auth login. */
export function isImplicitAccountId(accountId: string): boolean {
  return HEX_IMPL_RE.test(accountId);
}

export function isValidNearAccountId(accountId: string): boolean {
  if (HEX_IMPL_RE.test(accountId)) return true;
  return ACCOUNT_ID_RE.test(accountId) && !accountId.includes("..");
}

export function explorerTxUrl(explorerBase: string, txHash: string): string {
  return `${explorerBase}${txHash}`;
}

export function loadSettlementConfig(
  env: Record<string, string | undefined> = process.env,
): SettlementConfig {
  const network = (env.NEAR_NETWORK ?? DEFAULTS.network).trim();
  if (network !== "testnet") {
    throw new SettlementError(
      "UNAVAILABLE",
      503,
      `NEAR_NETWORK=${network} is not supported; Ironblock settlement is testnet-only`,
      "Settlement is testnet-only on this deployment",
    );
  }

  const contractId = clean(env.NEAR_NEP245_CONTRACT_ID, DEFAULTS.contractId);
  const treasuryAccountId = clean(env.NEAR_TREASURY_ACCOUNT_ID, DEFAULTS.treasuryAccountId);
  const rpcUrl = clean(env.NEAR_RPC_URL, DEFAULTS.rpcUrl);

  for (const [value, label] of [
    [contractId, "NEAR_NEP245_CONTRACT_ID"],
    [treasuryAccountId, "NEAR_TREASURY_ACCOUNT_ID"],
  ] as const) {
    if (!isValidNearAccountId(value)) {
      throw new SettlementError("UNAVAILABLE", 503, `${label} is not a valid NEAR account id`);
    }
  }

  if (!/^https:\/\/.+/.test(rpcUrl)) {
    throw new SettlementError("UNAVAILABLE", 503, "NEAR_RPC_URL must be an https URL");
  }

  const timeoutRaw = env.NEAR_SETTLEMENT_TIMEOUT_MS;
  const timeoutMs = timeoutRaw === undefined || timeoutRaw.trim() === "" ? DEFAULTS.timeoutMs : Number(timeoutRaw);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 5_000 || timeoutMs > 300_000) {
    throw new SettlementError("UNAVAILABLE", 503, "NEAR_SETTLEMENT_TIMEOUT_MS must be 5000..300000");
  }

  const inlineKey = env.NEAR_TREASURY_PRIVATE_KEY?.trim();
  const keystorePath = env.NEAR_TREASURY_KEYSTORE_PATH?.trim();

  const keyMode: SettlementConfig["treasuryKeyMode"] = inlineKey
    ? "inline"
    : keystorePath
      ? "keystore"
      : "auto";

  return {
    network: "testnet",
    contractId,
    treasuryAccountId,
    rpcUrl,
    timeoutMs: Math.floor(timeoutMs),
    explorerTxUrl: DEFAULTS.explorerTxUrl,
    treasuryKeyMode: keyMode,
    treasuryKeystorePath: keystorePath || undefined,
    treasuryPrivateKey: inlineKey || undefined,
  };
}

function clean(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

/** Validate that a body value is a positive integer item amount. */
export function parseItemAmount(value: unknown): number {
  const amount = typeof value === "string" ? Number(value.trim()) : value;
  if (
    typeof amount === "number" &&
    Number.isSafeInteger(amount) &&
    amount > 0 &&
    amount <= 1_000_000_000
  ) {
    return amount;
  }
  throw new SettlementError(
    "INVALID_REQUEST",
    400,
    "amount must be a positive integer item count of at most 1e9",
    "Amount must be a whole number of items greater than zero.",
  );
}

/** Withdrawal request ids: 8..64 safe characters so they fit in an on-chain memo. */
export function parseRequestId(value: unknown): string {
  if (typeof value !== "string") {
    throw new SettlementError("INVALID_REQUEST", 400, "requestId is required", "A requestId is required.");
  }
  const id = value.trim();
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
    throw new SettlementError(
      "INVALID_REQUEST",
      400,
      "requestId must be 8..64 characters of letters, digits, dashes or underscores",
      "The requestId must be 8-64 characters (letters, digits, dashes, underscores).",
    );
  }
  return id;
}

export function parseTokenId(value: unknown): string {
  if (typeof value !== "string" || /^[a-z0-9_-]{1,64}$/.test(value) === false) {
    throw new SettlementError(
      "INVALID_REQUEST",
      400,
      "tokenId must be 1..64 characters of [a-z0-9_-]",
      "Choose one of the listed items.",
    );
  }
  return value;
}
