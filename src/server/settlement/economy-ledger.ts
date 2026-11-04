import type { EconomyActionResult, WithdrawActionData } from "../../shared/economy";
import { startEconomyService } from "../economy/runtime";
import type { EconomyService } from "../economy/service";
import { SettlementError } from "./errors";
import type { LedgerEntry, SettlementHold, SettlementLedger } from "./ledger";

/**
 * Economy-backed implementation of the settlement ledger seam.
 *
 * The authoritative inventory comes from the running economy engine:
 * `service.snapshot().players[playerId].inventory[itemId]`. Settlement token
 * IDs equal economy item IDs, so the two namespaces map 1:1.
 *
 * Active holds live only in this process's memory. Balances are read straight
 * from the engine, so `available` = engine inventory - active holds. `hold`
 * validates and reserves inside one synchronous read-modify block. `commit`
 * claims the hold, runs the real economy debit via `service.withdrawItem`,
 * and restores the claim if the engine refuses so a failed commit never
 * silently loses the reservation. `release` un-reserves without touching the
 * engine.
 */
export function createEconomySettlementLedger(service: EconomyService): SettlementLedger {
  return new EconomySettlementLedger(service);
}

/**
 * Ledger for hosts whose configuration must be built synchronously (the Vite
 * dev/preview plugins). The shared economy service starts asynchronously, so
 * the real economy-backed ledger is created on first use and then reused.
 * Holds live inside that one instance; delegating keeps `available` accurate.
 */
export function createLazyEconomySettlementLedger(): SettlementLedger {
  let ledgerPromise: Promise<SettlementLedger> | null = null;
  const resolveLedger = (): Promise<SettlementLedger> => {
    if (!ledgerPromise) {
      ledgerPromise = startEconomyService().then(createEconomySettlementLedger);
    }
    return ledgerPromise;
  };

  return {
    async available(playerId, tokenId) {
      return (await resolveLedger()).available(playerId, tokenId);
    },
    async hold(input) {
      return (await resolveLedger()).hold(input);
    },
    async commit(hold) {
      return (await resolveLedger()).commit(hold);
    },
    async release(hold) {
      return (await resolveLedger()).release(hold);
    },
    async snapshot(playerId) {
      return (await resolveLedger()).snapshot(playerId);
    },
  };
}

class EconomySettlementLedger implements SettlementLedger {
  private readonly holds = new Map<string, SettlementHold>();

  constructor(private readonly service: EconomyService) {}

  async available(playerId: string, tokenId: string): Promise<string> {
    const inventory = this.readInventory(playerId, tokenId);
    if (inventory === null) return "0";
    const held = this.totalHeld(playerId, tokenId);
    return Math.max(0, inventory - held).toString();
  }

  async hold(input: {
    playerId: string;
    tokenId: string;
    amount: number;
    reference: string;
  }): Promise<SettlementHold> {
    // Read, validate and reserve in one synchronous block: no awaits between
    // the balance check and the reservation, so two holds in this process
    // cannot double-spend the same inventory units.
    const amount = input.amount;
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new SettlementError(
        "INVALID_REQUEST",
        400,
        "Hold amount must be a positive whole number",
      );
    }
    const itemId = input.tokenId;
    const snapshot = this.service.snapshot();
    const player = snapshot.players[input.playerId];
    if (!player) {
      throw new SettlementError(
        "INVALID_REQUEST",
        400,
        `Unknown player ${input.playerId}`,
      );
    }
    if (!this.service.config.items[itemId]) {
      throw new SettlementError(
        "UNKNOWN_TOKEN",
        404,
        `Unknown settlement token ${input.tokenId}`,
      );
    }
    const inventory = player.inventory[itemId] ?? 0;
    const held = this.totalHeld(input.playerId, itemId);
    if (inventory - held < amount) {
      const available = Math.max(0, inventory - held);
      throw new SettlementError(
        "INSUFFICIENT_BALANCE",
        409,
        `Ledger available ${available} is less than ${amount} ${itemId}`,
        `You only have ${available} ${itemId} available to withdraw.`,
      );
    }

    const hold: SettlementHold = {
      holdId: `hold_${randomSuffix()}`,
      playerId: input.playerId,
      tokenId: input.tokenId,
      amount,
      reference: input.reference,
      createdAt: new Date().toISOString(),
    };
    this.holds.set(hold.holdId, hold);
    return hold;
  }

  async commit(hold: SettlementHold): Promise<void> {
    // Claim first so a duplicated commit cannot debit the engine twice. The
    // claim is synchronous with the check, no awaits in between.
    const claimed = this.claim(hold.holdId, hold);
    let result: EconomyActionResult<WithdrawActionData>;
    try {
      result = await this.service.withdrawItem(claimed.playerId, claimed.tokenId, claimed.amount);
    } catch (error) {
      // The engine never saw the debit: keep the hold reserved.
      this.restoreIfAbsent(claimed);
      throw error instanceof SettlementError
        ? error
        : new SettlementError(
            "UNAVAILABLE",
            503,
            `Ledger commit for hold ${claimed.holdId} failed: ${error instanceof Error ? error.message : String(error)}`,
          );
    }
    if (!result.success) {
      // Engine refused (e.g. inventory was consumed by a normal game action
      // after the hold). The debit did not happen; the hold stays reserved.
      this.restoreIfAbsent(claimed);
      const code = result.error?.code === "insufficient_inventory" ? "CONFLICT" : "UNAVAILABLE";
      throw new SettlementError(
        code,
        code === "CONFLICT" ? 409 : 503,
        `Ledger commit for hold ${claimed.holdId} refused: ${result.error?.code ?? "unknown"} ${result.error?.message ?? ""}`.trim(),
      );
    }
    // The economy debit is permanent: drop the hold.
    this.holds.delete(claimed.holdId);
  }

  async release(hold: SettlementHold): Promise<void> {
    // Rollback: the reservation simply disappears; the engine was untouched.
    this.claim(hold.holdId, hold);
  }

  async snapshot(playerId: string): Promise<LedgerEntry[]> {
    const snapshot = this.service.snapshot();
    const player = snapshot.players[playerId];
    const itemIds = player ? Object.keys(player.inventory) : [];
    const tokens = new Set<string>(itemIds);
    for (const hold of this.holds.values()) {
      if (hold.playerId === playerId) tokens.add(hold.tokenId);
    }
    return [...tokens].sort().map((tokenId) => {
      const inventory = player?.inventory[tokenId] ?? 0;
      const held = this.totalHeld(playerId, tokenId);
      return {
        tokenId,
        available: Math.max(0, inventory - held).toString(),
        held: held.toString(),
        // Engine debits are authoritative; this seam reports no local total.
        debited: "0",
      };
    });
  }

  /** Test helper: active holds for one player. */
  activeHolds(playerId: string): SettlementHold[] {
    return [...this.holds.values()].filter((hold) => hold.playerId === playerId);
  }

  /** Synchronously checks a hold is active and removes it from the map. */
  private claim(holdId: string, expected: SettlementHold): SettlementHold {
    const stored = this.holds.get(holdId);
    if (!stored) {
      throw new SettlementError("CONFLICT", 409, `Hold ${holdId} is not active`);
    }
    if (
      stored.playerId !== expected.playerId ||
      stored.tokenId !== expected.tokenId ||
      stored.amount !== expected.amount
    ) {
      throw new SettlementError("CONFLICT", 409, `Hold ${holdId} does not match the expected hold`);
    }
    this.holds.delete(holdId);
    return stored;
  }

  private restoreIfAbsent(hold: SettlementHold): void {
    if (!this.holds.has(hold.holdId)) this.holds.set(hold.holdId, hold);
  }

  private totalHeld(playerId: string, itemId: string): number {
    let total = 0;
    for (const hold of this.holds.values()) {
      if (hold.playerId === playerId && hold.tokenId === itemId) total += hold.amount;
    }
    return total;
  }

  private readInventory(playerId: string, itemId: string): number | null {
    const snapshot = this.service.snapshot();
    const player = snapshot.players[playerId];
    if (!player) return null;
    if (!this.service.config.items[itemId]) return null;
    return player.inventory[itemId] ?? 0;
  }
}

function randomSuffix(): string {
  return `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}
