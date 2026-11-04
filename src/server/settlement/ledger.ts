import { SettlementError } from "./errors";

/**
 * Ledger seam for item withdrawals.
 *
 * The integration agent binds the economy engine's inventory here. The
 * settlement service never imports an economy branch; it only calls:
 *
 *   hold()    -> reserve units before broadcasting
 *   commit()  -> the transfer is FINAL on testnet; debit permanently
 *   release() -> the transfer failed on chain; un-reserve
 *
 * Amounts are small non-negative integers encoded as strings to match the
 * NEP-245 U128 wire format.
 */
export interface SettlementHold {
  holdId: string;
  playerId: string;
  tokenId: string;
  amount: number;
  reference: string;
  createdAt: string;
}

export interface LedgerEntry {
  tokenId: string;
  available: string;
  held: string;
  debited: string;
}

export interface SettlementLedger {
  /** Liquid (not held, not debited) balance for one token. */
  available(playerId: string, tokenId: string): Promise<string>;
  /** Atomically reserve `amount`; throws INSUFFICIENT_BALANCE when short. */
  hold(input: {
    playerId: string;
    tokenId: string;
    amount: number;
    reference: string;
  }): Promise<SettlementHold>;
  /** Permanently debit a previously created hold. */
  commit(hold: SettlementHold): Promise<void>;
  /** Return a hold to the available balance (rollback). */
  release(hold: SettlementHold): Promise<void>;
  /** Full per-token snapshot for one player. */
  snapshot(playerId: string): Promise<LedgerEntry[]>;
}

/** Seed entry: `{ [playerId]: [{ tokenId, amount }] }`. */
export type LedgerSeed = Record<string, { tokenId: string; amount: number | string }[]>;

/**
 * Process-local ledger for tests, smoke runs and the demo. Restarting the
 * process resets balances; the server is the source of truth for in-game item
 * custody until a withdrawal is confirmed on testnet.
 */
export class InMemorySettlementLedger implements SettlementLedger {
  private readonly balances = new Map<string, { available: bigint; debited: bigint }>();
  private readonly holds = new Map<string, SettlementHold>();

  constructor(seed: LedgerSeed = {}) {
    for (const [playerId, tokens] of Object.entries(seed)) {
      for (const { tokenId, amount } of tokens) {
        this.entry(playerId, tokenId).available = parseAmount(amount);
      }
    }
  }

  async available(playerId: string, tokenId: string): Promise<string> {
    return this.entry(playerId, tokenId).available.toString();
  }

  async hold(input: {
    playerId: string;
    tokenId: string;
    amount: number;
    reference: string;
  }): Promise<SettlementHold> {
    const amount = parseAmount(input.amount);
    if (amount <= 0n) {
      throw new SettlementError("INVALID_REQUEST", 400, "Hold amount must be positive");
    }
    const key = `${input.playerId}\u0000${input.tokenId}`;
    const entry = this.entry(input.playerId, input.tokenId);

    // Atomic in-process reserve: no await between check and deduct.
    if (entry.available < amount) {
      throw new SettlementError(
        "INSUFFICIENT_BALANCE",
        409,
        `Ledger available ${entry.available.toString()} is less than ${amount.toString()} ${input.tokenId}`,
        `You only have ${entry.available.toString()} ${input.tokenId} available to withdraw.`,
      );
    }

    const hold: SettlementHold = {
      holdId: `hold_${randomSuffix()}`,
      playerId: input.playerId,
      tokenId: input.tokenId,
      amount: Number(amount),
      reference: input.reference,
      createdAt: new Date().toISOString(),
    };
    entry.available -= amount;
    this.holds.set(hold.holdId, hold);
    return hold;
  }

  async commit(hold: SettlementHold): Promise<void> {
    const stored = this.holds.get(hold.holdId);
    if (!stored) {
      throw new SettlementError("CONFLICT", 409, `Hold ${hold.holdId} is not active`);
    }
    this.entry(hold.playerId, hold.tokenId).debited += BigInt(hold.amount);
    this.holds.delete(hold.holdId);
  }

  async release(hold: SettlementHold): Promise<void> {
    const stored = this.holds.get(hold.holdId);
    if (!stored) {
      throw new SettlementError("CONFLICT", 409, `Hold ${hold.holdId} is not active`);
    }
    this.entry(hold.playerId, hold.tokenId).available += BigInt(hold.amount);
    this.holds.delete(hold.holdId);
  }

  async snapshot(playerId: string): Promise<LedgerEntry[]> {
    const prefix = `${playerId}\u0000`;
    const tokens = new Set<string>(
      [...this.balances.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)),
    );
    for (const hold of this.holds.values()) {
      if (hold.playerId === playerId) tokens.add(hold.tokenId);
    }
    return [...tokens].sort().map((tokenId) => {
      const entry = this.balances.get(`${prefix}${tokenId}`);
      return {
        tokenId,
        available: (entry ? entry.available : 0n).toString(),
        held: totalHeld(this.holds, playerId, tokenId).toString(),
        debited: (entry ? entry.debited : 0n).toString(),
      };
    });
  }

  /** Test helper: active holds for one player. */
  activeHolds(playerId: string): SettlementHold[] {
    return [...this.holds.values()].filter((h) => h.playerId === playerId);
  }

  private entry(playerId: string, tokenId: string): { available: bigint; debited: bigint } {
    const key = `${playerId}\u0000${tokenId}`;
    let entry = this.balances.get(key);
    if (!entry) {
      entry = { available: 0n, debited: 0n };
      this.balances.set(key, entry);
    }
    return entry;
  }
}

function totalHeld(
  holds: Map<string, SettlementHold>,
  playerId: string,
  tokenId: string,
): bigint {
  let total = 0n;
  for (const hold of holds.values()) {
    if (hold.playerId === playerId && hold.tokenId === tokenId) total += BigInt(hold.amount);
  }
  return total;
}

function parseAmount(value: number | string): bigint {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new SettlementError("INVALID_REQUEST", 400, "Ledger amounts must be safe integers >= 0");
    }
    return BigInt(value);
  }
  const trimmed = value.trim();
  if (!/^\d{1,19}$/.test(trimmed)) {
    throw new SettlementError("INVALID_REQUEST", 400, "Ledger amounts must be decimal digit strings");
  }
  return BigInt(trimmed);
}

function randomSuffix(): string {
  return `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}
