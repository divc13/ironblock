import type { GameSessionClaims } from "../auth/session";
import type {
  WithdrawalStatus,
  WithdrawalView,
} from "../../shared/settlement/types";
import type { SettlementConfig } from "./config";
import { explorerTxUrl, isValidNearAccountId, parseItemAmount, parseRequestId, parseTokenId } from "./config";
import type { MtTransferResult, Nep245Chain } from "./chain";
import { SettlementError } from "./errors";
import type { SettlementHold, SettlementLedger } from "./ledger";
import type { WithdrawalRecord, WithdrawalStore } from "./withdrawal-store";
import { recordToView } from "./withdrawal-store";

export interface WithdrawInput {
  session: GameSessionClaims;
  requestId: string;
  tokenId: string;
  amount: number | string;
  receiver?: string;
}

export interface WithdrawalOutcome {
  status: number;
  view: WithdrawalView;
}

/**
 * Lead-game ledger -> NEP-245 bridge.
 *
 * Protocol (see README "Withdrawal flow"):
 *  1. the HTTP layer authenticates the verified game session
 *  2. validate tokenId / integer amount / receiver == session implicit account
 *  3. ledger.hold to prevent double submits from overdrawing
 *  4. idempotent record creation on (playerId, requestId)
 *  5. mt_transfer from the treasury with exactly 1 yoctoNEAR and the withdrawal id in the memo
 *  6. wait for FINAL; commit the debit on success, release the hold on failure
 *  7. return the record with tx hash + explorer link
 *
 * No player key is ever used; the client never signs.
 */
export class NearItemSettlement {
  constructor(
    readonly config: SettlementConfig,
    readonly chain: Nep245Chain,
    readonly ledger: SettlementLedger,
    readonly store: WithdrawalStore,
  ) {}

  /**
   * Execute (or replay) a withdrawal for a verified session.
   * Returns the HTTP status to respond with alongside the record view.
   */
  async withdraw(input: WithdrawInput): Promise<WithdrawalOutcome> {
    const { session } = input;
    const requestId = parseRequestId(input.requestId);
    const tokenId = parseTokenId(input.tokenId);
    const amount = parseItemAmount(input.amount);

    if (!session.nearAccountId) {
      throw new SettlementError(
        "NEAR_ACCOUNT_REQUIRED",
        400,
        "No NEAR payout account is set for this session",
        "Set your NEAR payout address before withdrawing items.",
      );
    }

    const receiver = input.receiver ?? session.nearAccountId;
    if (receiver !== session.nearAccountId) {
      throw new SettlementError(
        "RECEIVER_MISMATCH",
        400,
        `Withdrawal receiver ${receiver} is not this session's payout account`,
        "Withdrawals can only be sent to your saved NEAR payout account.",
      );
    }
    if (!isValidNearAccountId(receiver)) {
      throw new SettlementError("RECEIVER_MISMATCH", 400, "receiver is not a valid NEAR account id");
    }

    // Idempotent replay: an existing (playerId, requestId) record is the truth.
    const existing = await this.store.get(session.playerId, requestId);
    if (existing) {
      if (existing.tokenId !== tokenId || existing.amount !== String(amount) || existing.receiverId !== receiver) {
        throw new SettlementError(
          "CONFLICT",
          409,
          "requestId was already used for a different withdrawal",
          "This requestId was already used with different parameters.",
        );
      }
      if (existing.status === "pending" || existing.status === "submitted") {
        await this.reconcile(existing);
      }
      // Fetch again post-reconcile.
      const refreshed = (await this.store.get(existing.id)) ?? existing;
      return { status: 200, view: { ...recordToView(refreshed), replayed: true } };
    }

    // Validate the token exists on the deployed contract before reserving.
    await this.assertTokenKnown(tokenId);

    const created = await this.createPendingRecord({ session, requestId, tokenId, amount, receiver });
    if (!created.fresh) {
      const record = created.record;
      if (record.status === "pending" || record.status === "submitted") {
        await this.reconcile(record);
      }
      const refreshed = (await this.store.get(record.id)) ?? record;
      return { status: 200, view: { ...recordToView(refreshed), replayed: true } };
    }
    const record = created.record;

    // Reserve immediately and durably enough for the demo: hold first so a
    // duplicate submit cannot overdraw, then broadcast.
    let hold: SettlementHold;
    try {
      hold = await this.ledger.hold({
        playerId: session.playerId,
        tokenId,
        amount,
        reference: record.id,
      });
    } catch (error) {
      await this.fail(record.id, "INSUFFICIENT_BALANCE", safeInsufficient(error), "failed");
      throw error;
    }
    const withHold = await this.store.update(record.id, {
      holdId: hold.holdId,
      status: "pending",
    });

    try {
      const result: MtTransferResult = await this.chain.mtTransferAsTreasury({
        receiverId: receiver,
        tokenId,
        amount,
        memo: `ironblock withdraw ${record.id}`,
      });
      await this.store.update(record.id, {
        status: "submitted",
        txHash: result.txHash,
        explorerUrl: result.explorerUrl,
        submittedAt: new Date().toISOString(),
        errorCode: undefined,
        errorMessage: undefined,
      });
      // Transfer is FINAL: commit the ledger debit.
      await this.ledger.commit(hold);
      const confirmed = await this.store.update(record.id, { status: "confirmed" });
      return { status: 200, view: recordToView(confirmed) };
    } catch (error) {
      if (isTimeout(error)) {
        // The tx hash may or may not exist yet; keep funds held and pending so
        // reconcile() can settle it later. Never guess.
        const settled = await this.settlePendingFromTxHash(record.id, undefined);
        if (settled) return { status: 200, view: recordToView(settled) };
        const pendingRecord = await this.store.update(record.id, {
          errorCode: "TIMEOUT",
          errorMessage: "Still waiting for testnet finality; funds stay reserved until the transfer is FINAL.",
        });
        return { status: 202, view: recordToView(pendingRecord) };
      }

      // Broadcast/panic failure: no FINAL success, so no ledger debit. If we
      // have a tx hash, the failure state is on-chain observable as well.
      await this.fail(record.id, errorCodeOf(error), safeMessage(error), "refunded");
      try {
        await this.ledger.release(hold);
      } catch (releaseError) {
        // Hold already committed/released elsewhere. Ledger consistency keeps
        // the record's refunded flag; log-free single-process scope.
        if (releaseError instanceof SettlementError) {
          // mark refunded only when the hold existed
          if (releaseError.code !== "CONFLICT") {
            await this.store.update(record.id, { errorCode: "REFUND_FAILED" });
          }
        }
      }
      const failed = await this.store.get(record.id);
      throw new SettlementError(
        errorCodeOf(error),
        statusOf(error),
        `${failed?.errorMessage ?? safeMessage(error)}`,
        safeMessage(error),
      );
    }
  }

  /**
   * Re-read the record and its ledger snapshot; refresh pending/submitted
   * withdrawals with the latest on-chain verdict.
   */
  async describe(record: WithdrawalRecord): Promise<WithdrawalView> {
    if (record.status === "pending" || record.status === "submitted") {
      await this.reconcile(record);
      const refreshed = await this.store.get(record.id);
      if (refreshed) return recordToView(refreshed);
    }
    return recordToView(record);
  }

  /** Idempotent reconcile of a hold-backed pending/submitted record. */
  async reconcile(record: WithdrawalRecord, now = new Date()): Promise<void> {
    if (!record.holdId) return; // pre-hold records resolve on their own paths
    const drewDown = now.getTime() - Date.parse(record.createdAt);
    if (!record.txHash) {
      // Broadcast never confirmed a hash within budget. After a grace period
      // treat as refundable ONLY if there is no way to touch the chain? There
      // is not, so keep pending but surface TIMEOUT (safe: funds stay held).
      if (drewDown > this.config.timeoutMs * 3) {
        await this.store.update(record.id, {
          errorCode: "TIMEOUT",
          errorMessage: "The transfer could not be broadcast before the timeout. Funds remain reserved for manual settlement.",
        });
      }
      return;
    }
    const verdict = await this.chain.transactionStatus(record.txHash);
    if (verdict === "confirmed") {
      const hold = await this.resolveHold(record);
      if (hold) {
        try {
          await this.ledger.commit(hold);
        } catch {
          // commit double-apply guard: hold already gone means it committed
        }
      }
      await this.store.update(record.id, {
        status: "confirmed",
        confirmedAt: new Date().toISOString(),
        explorerUrl: record.explorerUrl ?? explorerTxUrl(this.config.explorerTxUrl, record.txHash),
        errorCode: undefined,
        errorMessage: undefined,
      });
      return;
    }
    if (verdict === "failed") {
      const hold = await this.resolveHold(record);
      if (hold) {
        try {
          await this.ledger.release(hold);
        } catch {
          // already released
        }
      }
      await this.store.update(record.id, {
        status: "refunded",
        errorCode: record.errorCode ?? "ONCHAIN_FAILED",
        errorMessage:
          record.errorMessage ??
          "The testnet transfer failed; the reserved items returned to your ledger balance.",
        refundedAt: new Date().toISOString(),
      });
    }
    // "pending": leave as-is; a later describe() retries.
  }

  private async resolveHold(record: WithdrawalRecord): Promise<SettlementHold | undefined> {
    if (!record.holdId) return undefined;
    return {
      holdId: record.holdId,
      playerId: record.playerId,
      tokenId: record.tokenId,
      amount: Number(record.amount),
      reference: record.id,
      createdAt: record.createdAt,
    };
  }

  /**
   * Last-resort status probe for a timeout before the client sees 202: if the
   * hash is already known somehow, use the tx verdict immediately.
   */
  private async settlePendingFromTxHash(
    recordId: string,
    _txHash: string | undefined,
  ): Promise<WithdrawalRecord | undefined> {
    const record = await this.store.get(recordId);
    if (!record || !record.txHash) return undefined;
    await this.reconcile(record);
    return this.store.get(recordId);
  }

  private async assertTokenKnown(tokenId: string): Promise<void> {
    const items = await this.chain.getItems();
    if (items.some((item) => item.token_id === tokenId)) return;
    throw new SettlementError(
      "UNKNOWN_TOKEN",
      400,
      `token ${tokenId} is not part of the deployed item contract`,
      `${tokenId} is not a known item on ${this.config.contractId}.`,
    );
  }

  private async createPendingRecord(input: {
    session: GameSessionClaims;
    requestId: string;
    tokenId: string;
    amount: number;
    receiver: string;
  }): Promise<WithdrawalRecord> {
    const now = new Date();
    const draft: WithdrawalRecord = {
      id: this.newRecordId(),
      playerId: input.session.playerId,
      requestId: input.requestId,
      tokenId: input.tokenId,
      amount: String(input.amount),
      receiverId: input.receiver,
      status: "pending" as WithdrawalStatus,
      contractId: this.config.contractId,
      network: "testnet",
      createdAt: now.toISOString(),
    };
    try {
      const inserted = await this.store.insert(draft);
      return { fresh: true, record: inserted };
    } catch (error) {
      if (error instanceof SettlementError && error.code === "CONFLICT") {
        // A race lost the insert; the winner's record is authoritative.
        const existing = await this.store.get(input.session.playerId, input.requestId);
        if (
          existing &&
          existing.tokenId === input.tokenId &&
          existing.amount === String(input.amount) &&
          existing.receiverId === input.receiver
        ) {
          return { fresh: false, record: existing };
        }
      }
      throw error;
    }
  }

  protected newRecordId(): string {
    return `wd_${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;
  }

  private async fail(
    id: string,
    code: string,
    message: string,
    status: "failed" | "refunded",
  ): Promise<void> {
    const now = new Date().toISOString();
    const patch: Partial<WithdrawalRecord> = {
      status,
      errorCode: code,
      errorMessage: message,
      failedAt: now,
    };
    if (status === "refunded") patch.refundedAt = now;
    try {
      await this.store.update(id, patch);
    } catch {
      // Record may have been settled concurrently; the error below wins.
      void patch;
    }
  }
}

function isTimeout(error: unknown): boolean {
  return (
    error instanceof SettlementError &&
    (error.code === "TIMEOUT" || error.status === 504)
  );
}

function errorCodeOf(error: unknown): string {
  if (error instanceof SettlementError) return error.code;
  return "CHAIN_ERROR";
}

function statusOf(error: unknown): number {
  if (error instanceof SettlementError) return error.status;
  return 500;
}

/** Strip any variadic detail that could carry internal chain wording. */
function safeMessage(error: unknown): string {
  if (error instanceof SettlementError) return error.publicMessage;
  if (error instanceof Error) {
    const byPattern: [RegExp, string][] = [
      [/insufficient|yNEAR balance/i, "The treasury could not fund gas for this transfer."],
      [/reject|panic/i, "The item contract rejected the transfer parameters."],
      [/timeout|Connection|network|fetch/i, "The NEAR testnet is unreachable right now."],
    ];
    for (const [pattern, message] of byPattern) {
      if (pattern.test(error.message)) return message;
    }
    return "The transfer could not be completed. Your reserved items were returned to your ledger balance.";
  }
  return "The transfer could not be completed.";
}

function safeInsufficient(error: unknown): string {
  if (error instanceof SettlementError) {
    return error.publicMessage;
  }
  return "Your available ledger balance is too low for this withdrawal.";
}
