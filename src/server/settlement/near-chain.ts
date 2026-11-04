import { providers, transactions, utils } from "near-api-js";
import type { JsonRpcProvider } from "near-api-js/lib/providers";
import type {
  ContractConfigView,
  ContractItemView,
} from "./onchain-types";
import {
  createTreasurySigner,
  readNearCliKeychainKey,
  type TreasurySigner,
} from "./treasury-signer";
import type { MtTransferInput, MtTransferResult, Nep245Chain } from "./chain";
import type { SettlementConfig } from "./config";
import { explorerTxUrl, SETTLEMENT_DEFAULTS } from "./config";
import { SettlementError } from "./errors";

/**
 * Real chain adapter over near-api-js (testnet JSON-RPC).
 *
 * Mutations are signed with the treasury key inside this process; the key is
 * resolved by `createTreasurySigner` and never logged, echoed or serialised.
 * Transfers attach exactly 1 yoctoNEAR and commit only at FINAL execution.
 */
export class NearApiNep245Chain implements Nep245Chain {
  private readonly provider: providers.JsonRpcProvider;
  private signer: unknown;
  private signerSource?: TreasurySigner["source"];
  private signerResolved = false;

  constructor(
    readonly config: SettlementConfig,
    /** Test seam: inject a provider and/or signer and skip env/keychain lookups. */
    seams: { provider?: unknown; signer?: unknown } = {},
  ) {
    this.provider =
      (seams.provider as providers.JsonRpcProvider) ??
      new providers.JsonRpcProvider({ url: config.rpcUrl });
    if (seams.signer !== undefined) {
      this.signer = seams.signer;
      this.signerResolved = true;
      this.signerSource = "inline";
    }
  }

  // ------------------------------------------------------------------ views

  async getConfig(): Promise<ContractConfigView> {
    return (await this.view("get_config", {})) as ContractConfigView;
  }

  async getItems(): Promise<ContractItemView[]> {
    const items = (await this.view("get_items", {})) as ContractItemView[];
    return Array.isArray(items) ? items : [];
  }

  async mtBalanceOf(accountId: string, tokenId: string): Promise<string> {
    const raw = await this.view("mt_balance_of", { account_id: accountId, token_id: tokenId });
    return stringifyAmount(raw);
  }

  async mtBatchBalanceOf(accountId: string, tokenIds: string[]): Promise<string[]> {
    const raw = await this.view("mt_batch_balance_of", {
      account_id: accountId,
      token_ids: tokenIds,
    });
    if (!Array.isArray(raw)) return tokenIds.map(() => "0");
    return raw.map(stringifyAmount);
  }

  async treasuryNearBalance(): Promise<string> {
    const result = (await this.provider.query({
      request_type: "view_account",
      account_id: this.config.treasuryAccountId,
      finality: "final",
    })) as { amount?: string };
    return result.amount ?? "0";
  }

  // ---------------------------------------------------------------- change

  async mtTransferAsTreasury(input: MtTransferInput): Promise<MtTransferResult> {
    const signer = this.requireSigner();
    const deadline = Date.now() + this.config.timeoutMs;

    // Acceptance: broadcast and get the tx hash as fast as the RPC allows.
    const accepted = await raceWithTimeout(
      this.broadcastOnce(input, signer),
      Math.min(this.config.timeoutMs, ACCEPT_PHASE_MS),
      "broadcast",
    );

    const txHash = accepted.transaction?.hash;
    if (!txHash) {
      // RPC accepted but did not echo a hash; nothing to reconcile against.
      throw new SettlementError(
        "INTERNAL",
        500,
        "RPC did not return a transaction hash",
        "The transfer could not be tracked; it will be retried safely.",
      );
    }
    if (isStatusFailure(accepted.status)) {
      // Fast rejection (very rare): the tx was final without doing anything.
      throw panic(accepted);
    }

    // Finality: wait for the FINAL block outcome within the total budget.
    const finalOutcome = await this.awaitFinal(txHash, deadline);
    if (!finalOutcome) {
      throw new SettlementError(
        "TIMEOUT",
        504,
        `Finality not reached within ${this.config.timeoutMs}ms for ${txHash}`,
        "The transfer is still being confirmed on testnet. Check the withdrawal status again in a moment.",
      );
    }
    if (isStatusFailure(finalOutcome.status)) {
      throw panic(finalOutcome);
    }
    return {
      txHash,
      explorerUrl: explorerTxUrl(this.config.explorerTxUrl, txHash),
      explorerAlternativeUrl: `https://testnet.nearblocks.io/tx/${txHash}`,
      final: true,
    };
  }

  /** Re-check a broadcast transaction. Only a FINAL outcome yields a verdict. */
  async transactionStatus(txHash: string): Promise<"confirmed" | "failed" | "pending"> {
    try {
      const outcome = (await this.provider.txStatus(
        txHash,
        this.config.treasuryAccountId,
        "FINAL",
      )) as outcomeLike;
      if (isStatusFailure(outcome.status)) return "failed";
      if (isStatusSuccess(outcome.status)) return "confirmed";
      return "pending";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/does not exist|not found|UNKNOWN|UNKNOWN_TRANSACTION|Transparent network error/i.test(message)) {
        return "pending";
      }
      if (/timeout|Connection|network/i.test(message)) return "pending";
      return "pending";
    }
  }

  /** Settle a pending/broadcast withdrawal by re-querying finality. */
  private async awaitFinal(txHash: string, deadline: number): Promise<outcomeLike | undefined> {
    let attempt = 0;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      try {
        const outcome = (await raceWithTimeout(
          this.provider.txStatus(txHash, this.config.treasuryAccountId, "FINAL") as Promise<outcomeLike>,
          Math.min(remaining, 15_000),
          "txStatus",
        )) as outcomeLike;
        if (isStatusFailure(outcome.status) || isStatusSuccess(outcome.status)) return outcome;
      } catch {
        attempt += 1;
        if (attempt > FINAL_ATTEMPTS) return undefined;
      }
      await sleep(Math.min(POLL_INTERVAL_MS, Math.max(deadline - Date.now(), 0)));
    }
    return undefined;
  }

  // ------------------------------------------------------------- internals

  private async broadcastOnce(input: MtTransferInput, signer: unknown): Promise<outcomeLike> {
    const networkId = this.config.network;
    const accountId = this.config.treasuryAccountId;
    const publicKey = (await (signer as signerLike).getPublicKey(accountId, networkId))!;
    const accessKey = (await this.provider.query({
      request_type: "view_access_key",
      account_id: accountId,
      public_key: publicKey.toString(),
      finality: "final",
    })) as { nonce?: string | number };

    const block = (await this.provider.block({ finality: "final" })) as {
      header: { hash: string };
    };
    const nonce =
      accessKey.nonce === undefined
        ? 0n
        : BigInt(accessKey.nonce as string | number) + 1n;

    const action = transactions.functionCall(
      "mt_transfer",
      {
        receiver_id: input.receiverId,
        token_id: input.tokenId,
        amount: input.amount.toString(),
        approval: null,
        memo: input.memo.slice(0, 180),
      },
      TRANSFER_GAS,
      1n, // exactly 1 yoctoNEAR
    );

    const [, signedTx] = (await transactions.signTransaction(
      this.config.contractId, // receiverId: the account that runs the action
      nonce,
      [action],
      utils.serialize.base_decode(block.header.hash),
      signer,
      accountId, // signer: the treasury account
      networkId,
    )) as unknown as [Uint8Array, unknown];

    return (await this.provider.sendTransaction(signedTx as never)) as outcomeLike;
  }

  private requireSigner(): unknown {
    if (!this.signerResolved) {
      const treasury = createTreasurySigner(this.config);
      if ("signer" in treasury) {
        this.signer = treasury.signer;
        this.signerSource = treasury.source;
      } else {
        throw new SettlementError("UNAVAILABLE", 503, treasury.error);
      }
      this.signerResolved = true;
    }
    if (!this.signer) {
      throw new SettlementError(
        "UNAVAILABLE",
        503,
        "No treasury signing material is configured",
      );
    }
    return this.signer;
  }

  /** Diagnostics for /health: can we sign at all? */
  signerStatus(): { available: boolean; source?: string; reason?: string } {
    if (this.signerResolved && this.signer) {
      return { available: true, source: this.signerSource };
    }
    const treasury = createTreasurySigner(this.config);
    return "signer" in treasury
      ? { available: true, source: treasury.source }
      : { available: false, reason: treasury.error };
  }

  private async view(
    method: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const result = (await this.provider.query({
      request_type: "call_function",
      account_id: this.config.contractId,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      finality: "final",
    })) as { result?: unknown };
    if (!result || !Array.isArray(result.result)) return undefined;
    const bytes = new Uint8Array(result.result as unknown as number[]);
    try {
      return JSON.parse(Buffer.from(bytes).toString("utf8"));
    } catch {
      return undefined;
    }
  }
}

export interface signerLike {
  getPublicKey(accountId?: string, networkId?: string): Promise<{ toString(): string } | null | undefined>;
  signMessage(
    message: Uint8Array,
    accountId?: string,
    networkId?: string,
  ): Promise<{ signature: Uint8Array }>;
}

type statusLike = { SuccessValue?: unknown; Failure?: unknown; Unknown?: unknown } | string;
interface outcomeLike {
  transaction?: { hash?: string };
  status?: statusLike;
}

const TRANSFER_GAS = 30_000_000_000_000n; // 30 Tgas: mt_transfer is cheap; batch ops need more
const ACCEPT_PHASE_MS = 20_000;
const POLL_INTERVAL_MS = 2_000;
const FINAL_ATTEMPTS = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Bounded race that leaves the losing promise unhandled-safe. */
function raceWithTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new SettlementError("TIMEOUT", 504, `${label} exceeded ${ms}ms budget`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function isStatusFailure(status: statusLike | undefined): boolean {
  return typeof status === "object" && status !== null && "Failure" in status;
}

function isStatusSuccess(status: statusLike | undefined): boolean {
  if (status === undefined) return false;
  if (typeof status === "string") return status === "SuccessValue";
  return "SuccessValue" in status;
}

function isStatusUnknown(status: statusLike | undefined): boolean {
  return typeof status === "object" && status !== null && "Unknown" in status;
}

export function stringifyAmount(raw: unknown): string {
  if (typeof raw === "string") return /^\d+$/.test(raw) ? raw : "0";
  if (typeof raw === "number") return Number.isSafeInteger(raw) && raw >= 0 ? String(raw) : "0";
  return "0";
}

/** Human-safe description of a final execution failure. */
function panic(outcome: outcomeLike): SettlementError {
  const failure = typeof outcome.status === "object" ? outcome.status?.Failure : undefined;
  const code = "CONFLICT";
  const message = failure ? `Transaction failed on testnet: ${summarise(failure)}` : "Transaction failed on testnet";
  return new SettlementError(code, 409, message, "The testnet transfer was rejected. Your reserved items were returned to your ledger balance.");
}

function summarise(failure: unknown): string {
  try {
    const text = JSON.stringify(failure);
    return text.length > 300 ? `${text.slice(0, 300)}…` : text;
  } catch {
    return "unknown execution error";
  }
}

export { isStatusUnknown };
export { readNearCliKeychainKey };
export type { JsonRpcProvider };
export const SETTLEMENT_EXPLORER_BASE = SETTLEMENT_DEFAULTS.explorerTxUrl;
