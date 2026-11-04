import { execFileSync } from "node:child_process";
import { KeyPair } from "near-api-js";
import { loadSettlementConfig, type SettlementConfig } from "./config";

/**
 * Resolve the treasury signing material into a near-api-js signer, or return a
 * precise reason for diagnostics (never the key itself):
 *
 * 1. NEAR_TREASURY_PRIVATE_KEY        inline env (CI / injected secrets)
 * 2. NEAR_TREASURY_KEYSTORE_PATH      legacy near keystore JSON file
 * 3. default near-cli-rs "secure" keychain (macOS `security` store). near-cli
 *    0.30.x stores full-access keys as generic passwords named
 *    `near-testnet-<account_id>` whose password is a credential JSON; we
 *    extract only its `private_key`.
 *
 * The resolved private key never leaves this function's scope except inside the
 * returned signer object.
 */
export interface TreasurySigner {
  signer: unknown;
  source: "inline" | "keystore" | "keychain";
}

export function createTreasurySigner(
  config: SettlementConfig,
): { signer: unknown; source: TreasurySigner["source"] } | { error: string } {
  try {
    if (config.treasuryPrivateKey) {
      return { signer: fromKeyString(config.treasuryPrivateKey), source: "inline" };
    }

    if (config.treasuryKeystorePath) {
      return { signer: fromKeystoreFile(config.treasuryKeystorePath, config), source: "keystore" };
    }

    const keychain = readNearCliKeychainKey(config.treasuryAccountId, config.network);
    if (keychain) return { signer: fromKeyString(keychain), source: "keychain" };
    return {
      error:
        "Treasury key not found. Checked: inline NEAR_TREASURY_PRIVATE_KEY " +
        "(absent), NEAR_TREASURY_KEYSTORE_PATH (unset), and the default " +
        "near-cli keychain entry for this account (absent).",
    };
  } catch (error) {
    // Never include key material or keystore contents in the reason.
    const message = error instanceof Error ? error.message : String(error);
    return { error: `Treasury signer could not be created from the configured source: ${message}` };
  }
}

function fromKeyString(value: string): unknown {
  let keyPair: KeyPair;
  try {
    keyPair = KeyPair.fromString(value as `${string}:${string}`);
  } catch {
    throw new Error("treasury key string is not a valid ed25519/secp256k1 key");
  }
  // InMemorySigner + keyStores.InMemoryKeyStore are version-consistent with
  // near-api-js 5.x transactions.signTransaction(..., signer, accountId, networkId).
  const store = new keyStores.InMemoryKeyStore();
  // The key must be reachable by account_id+network for the transfer path which
  // resolves getPublicKey(accountId, network); register it under both.
  const network = "testnet";
  return {
    async getPublicKey(accountId: string, networkId: string): Promise<unknown> {
      if (accountId === "testnet" || accountId === "") return keyPair.getPublicKey();
      await store.setKey(network, accountId, keyPair);
      return keyPair.getPublicKey();
    },
    async signMessage(message: Uint8Array, accountId: string, networkId: string): Promise<unknown> {
      if (accountId) {
        try {
          await store.setKey(network, accountId, keyPair);
        } catch {
          // registration is best-effort; signing still uses the keyPair
        }
      }
      void networkId;
      return keyPair.sign(message);
    },
  };
}

/** Accepts a bare key string or a near-cli-rs credential JSON (key only). */
function extractKey(raw: string): string | undefined {
  if (!raw) return undefined;
  if (raw.startsWith("ed25519:") || raw.startsWith("secp256k1:")) return raw;
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const value = parsed.private_key;
      return typeof value === "string" && (value.startsWith("ed25519:") || value.startsWith("secp256k1:"))
        ? value
        : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function fromKeystoreFile(path: string, config: SettlementConfig): unknown {
  if (!existsSync(path)) {
    throw new Error(`NEAR_TREASURY_KEYSTORE_PATH does not exist: ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`NEAR_TREASURY_KEYSTORE_PATH is not valid JSON: ${path}`);
  }
  const record = parsed as Record<string, unknown>;
  const raw =
    typeof record.private_key === "string"
      ? record.private_key
      : typeof record.key === "string"
        ? record.key
        : "";
  const accountId = typeof record.account_id === "string" ? record.account_id : "";
  if (!raw) throw new Error("keystore file has no private_key field");
  if (accountId && accountId !== config.treasuryAccountId) {
    throw new Error(
      `keystore file belongs to ${accountId}, not the configured treasury ${config.treasuryAccountId}`,
    );
  }
  return fromKeyString(raw);
}

/**
 * Read the secret for `account` from the near-cli-rs secure keychain via the
 * macOS `security` CLI. The password is captured through stdout inside this
 * process and is never echoed, logged or persisted.
 *
 * Returns undefined (without touching a secret) when the item does not exist.
 */
export function readNearCliKeychainKey(accountId: string, network: string): string | undefined {
  const service = `near-${network}-${accountId}`;
  let stdout: string;
  try {
    stdout = execFileSync("/usr/bin/security", ["find-generic-password", "-s", service, "-w"], {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
      timeout: 10_000,
    });
  } catch {
    return undefined;
  }
  return extractKey(stdout.trim());
}

/** Eager validation helper for health checks. */
export function describeTreasuryKeyAvailability(config: SettlementConfig = loadSettlementConfig()): {
  available: boolean;
  reason?: string;
  source?: string;
} {
  const resolved = createTreasurySigner(config);
  return "signer" in resolved
    ? { available: true, source: (resolved as { source?: string }).source }
    : { available: false, reason: (resolved as { error?: string }).error };
}
