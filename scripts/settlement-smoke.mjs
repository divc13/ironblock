#!/usr/bin/env node
/**
 * Real testnet settlement smoke test (operational tool; runs OUTSIDE vitest).
 *
 * Proves end-to-end: server-side treasury key -> mt_transfer (exactly 1
 * yoctoNEAR, memo `ironblock withdraw smoke-...`) to a FRESH implicit account,
 * monitoring to FINAL, then verifying the receiver balance via mt_balance_of.
 *
 * Security: the key is resolved from (1) NEAR_TREASURY_PRIVATE_KEY,
 * (2) NEAR_TREASURY_KEYSTORE_PATH, or (3) the default near-cli-rs keychain via
 * `security find-generic-password`. The secret is kept in memory only and is
 * never printed, logged or written anywhere.
 *
 * Usage:  npm run smoke:settlement
 */
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { KeyPair, keyStores, providers, transactions, utils, InMemorySigner } from "near-api-js";

const envFile = "process/env" && resolveEnv();
function resolveEnv() {
  const path = new URL("../.env", import.meta.url).pathname;
  if (existsSync(path)) {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (match && process.env[match[1]] === undefined) {
        process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
      }
    }
  }
  return null;
}

const CONTRACT = process.env.NEAR_NEP245_CONTRACT_ID ?? "v2.ironblock-items.testnet";
const TREASURY = process.env.NEAR_TREASURY_ACCOUNT_ID ?? "v2.ironblock-treasury.testnet";
const RPC = process.env.NEAR_RPC_URL ?? "https://rpc.testnet.fastnear.com";
const NETWORK = "testnet";
const BUDGET_MS = 90_000;
const EXPLORER = "https://explorer.testnet.near.org/transactions/";

// ---------------------------------------------------------------- signer

const importKey = resolveInline() ?? resolveKeystore() ?? resolveKeychain();
if (!importKey) {
  console.error(
    "BLOCKED: no treasury signing material found. Provide NEAR_TREASURY_PRIVATE_KEY, " +
      "NEAR_TREASURY_KEYSTORE_PATH, or the near-cli-rs keychain entry for " +
      `${TREASURY} (macOS keychain service 'near-${NETWORK}-${TREASURY}').`,
  );
  process.exit(2);
}
const keyPair = KeyPair.fromString(importKey);

function resolveInline() {
  const raw = process.env.NEAR_TREASURY_PRIVATE_KEY?.trim();
  return raw ? raw : undefined;
}

function resolveKeystore() {
  const path = process.env.NEAR_TREASURY_KEYSTORE_PATH?.trim();
  if (!path || !existsSync(path)) return undefined;
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  const value = parsed.private_key ?? parsed.key;
  return typeof value === "string" ? value : undefined;
}

function resolveKeychain() {
  if (process.platform !== "darwin") return undefined;
  const service = `near-${NETWORK}-${TREASURY}`;
  try {
    // stdout captured into memory; never echoed, never written to disk.
    const raw = execFileSync("/usr/bin/security", ["find-generic-password", "-s", service, "-w"], {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
      timeout: 10_000,
    }).trim();
    return extractKey(raw);
  } catch {
    return undefined;
  }
}

/** Accepts a bare key string or a near-cli-rs credential JSON (key only). */
function extractKey(raw) {
  if (!raw) return undefined;
  if (raw.startsWith("ed25519:") || raw.startsWith("secp256k1:")) return raw;
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw);
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

// ---------------------------------------------------------------- chain

const provider = new providers.JsonRpcProvider({ url: RPC });

async function view(method, args) {
  const response = await provider.query({
    request_type: "call_function",
    account_id: CONTRACT,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    finality: "final",
  });
  return JSON.parse(Buffer.from(new Uint8Array(response.result)).toString("utf8"));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const receiverKeyPair = KeyPair.fromRandom("ed25519");
const receiver =
  receiverKeyPair.getPublicKey().data instanceof Uint8Array
    ? Buffer.from(receiverKeyPair.getPublicKey().data).toString("hex")
    : Buffer.from(receiverKeyPair.getPublicKey().data).toString("hex");
const requestId = `smoke-${Date.now().toString(36)}`;

const treasuryBalances = await view("mt_batch_balance_of", {
  account_id: TREASURY,
  token_ids: ["iron_ore", "bread", "grain"],
});
const tokens = ["iron_ore", "bread", "grain"];
let tokenId = null;
tokens.forEach((t, i) => {
  if (tokenId === null && Number(treasuryBalances[i]) >= 1) tokenId = t;
});
if (!tokenId) {
  console.error("BLOCKED: none of iron_ore/bread/grain had balance >= 1 in the treasury.");
  process.exit(2);
}
const amount = "1";

console.log(`[smoke] contract=${CONTRACT} treasury=${TREASURY} token=${tokenId} amount=${amount}`);
console.log(`[smoke] receiver (fresh implicit)=${receiver}`);

// Sign with the treasury key inside this process; the key never leaves memory
// beyond the signer object and nothing prints it.
const store = new keyStores.InMemoryKeyStore();
await store.setKey(NETWORK, TREASURY, keyPair);
const signer = new InMemorySigner(store);
const publicKey = await signer.getPublicKey(TREASURY, NETWORK);
const accessKey = await provider.query({
  request_type: "view_access_key",
  account_id: TREASURY,
  public_key: publicKey.toString(),
  finality: "final",
});
const block = await provider.block({ finality: "final" });
const nonce = BigInt(accessKey.nonce) + 1n;
const memo = `ironblock withdraw ${requestId}`;

const action = transactions.functionCall(
  "mt_transfer",
  {
    receiver_id: receiver,
    token_id: tokenId,
    amount,
    approval: null,
    memo,
  },
  30_000_000_000_000n, // 30 Tgas
  1n, // exactly 1 yoctoNEAR
);

const [, signedTx] = await transactions.signTransaction(
  CONTRACT,
  nonce,
  [action],
  utils.serialize.base_decode(block.header.hash),
  signer,
  TREASURY,
  NETWORK,
);

console.log("[smoke] broadcasting mt_transfer…");
const accepted = await provider.sendTransaction(signedTx);
const txHash = accepted.transaction.hash;
console.log(`[smoke] accepted: ${EXPLORER}${txHash}`);

// Wait for FINAL within the budget.
const deadline = Date.now() + BUDGET_MS;
let finalOutcome = undefined;
while (Date.now() < deadline) {
  const outcome = await provider.txStatus(txHash, TREASURY, "FINAL");
  if (outcome.status && typeof outcome.status === "object") {
    if ("SuccessValue" in outcome.status) {
      finalOutcome = outcome;
      break;
    }
    if ("Failure" in outcome.status) {
      console.error(`[smoke] FAILED on chain: ${JSON.stringify(outcome.status.Failure).slice(0, 300)}`);
      process.exit(3);
    }
  }
  await sleep(2_000);
}
if (!finalOutcome) {
  console.error(`[smoke] BLOCKED: finality not reached within ${BUDGET_MS}ms; check ${EXPLORER}${txHash}`);
  process.exit(4);
}

const RECEIVER_BALANCE = await view("mt_balance_of", { account_id: receiver, token_id: tokenId });
const treasuryAfter = await view("mt_balance_of", { account_id: TREASURY, token_id: tokenId });

let verdict = "verified";
if (RECEIVER_BALANCE !== amount) {
  verdict = `MISMATCH: receiver balance ${JSON.stringify(RECEIVER_BALANCE)} != ${amount}`;
}

console.log(
  JSON.stringify(
    {
      token: tokenId,
      amount,
      receiver,
      memo,
      txHash,
      explorerUrl: `${EXPLORER}${txHash}`,
      finality: "FINAL",
      receiverBalance: RECEIVER_BALANCE,
      treasuryBalanceAfter: treasuryAfter,
      verdict,
    },
    null,
    2,
  ),
);
process.exit(verdict === "verified" ? 0 : 5);
