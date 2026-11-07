import { describe, expect, it, vi } from "vitest";
import type { GameSessionClaims } from "../../src/server/auth/session";
import { loadSettlementConfig } from "../../src/server/settlement/config";
import { SettlementError } from "../../src/server/settlement/errors";
import type { MtTransferInput, MtTransferResult, Nep245Chain } from "../../src/server/settlement/chain";
import { NearItemSettlement } from "../../src/server/settlement/service";
import { InMemorySettlementLedger } from "../../src/server/settlement/ledger";
import { InMemoryWithdrawalStore } from "../../src/server/settlement/withdrawal-store";

const RECEIVER = "f09b12705f578af820d22da5a5f1bca10ae5fe25cd1a645da6953e2cc5730a57";

const ITEMS = [
  { token_id: "iron_ore", name: "Iron Ore", symbol: "IORE", description: "", icon: "", decimals: 0, supply: "100000" },
  { token_id: "bread", name: "Bread", symbol: "BREAD", description: "", icon: "", decimals: 0, supply: "25000" },
];

/** Scriptable NEP-245 chain used by every test; defaults are a happy path. */
function makeChain(overrides: Partial<Nep245Chain> = {}): Nep245Chain & { transfers: MtTransferInput[] } & {
  txStatusScript: (hash: string) => Promise<"confirmed" | "failed" | "pending">;
  setFinalResult(result: MtTransferResult | SettlementError): void;
} {
  const transfers: MtTransferInput[] = [];
  let finalResult: MtTransferResult | SettlementError = {
    txHash: "5txhash",
    explorerUrl: "https://explorer.testnet.near.org/transactions/5txhash",
    final: true,
  };
  const chain = {
    transfers,
    async getConfig() {
      return {
        owner_id: "v2.ironblock-items.testnet",
        treasury_id: "v2.ironblock-treasury.testnet",
        genesis_minted: true,
        token_count: ITEMS.length,
      };
    },
    async getItems() {
      return ITEMS;
    },
    async mtBalanceOf(accountId: string, tokenId: string) {
      if (accountId === "v2.ironblock-treasury.testnet" && tokenId === "bread") return "24999";
      return "0";
    },
    async mtBatchBalanceOf(accountId: string) {
      return accountId === "v2.ironblock-treasury.testnet"
        ? ["100000", "24999"]
        : ["0", "0"];
    },
    async mtTransferAsTreasury(input: MtTransferInput) {
      transfers.push(input);
      if (finalResult instanceof SettlementError) throw finalResult;
      return finalResult;
    },
    txStatusScript: vi.fn(async () => "pending" as const),
    async transactionStatus(txHash: string) {
      return (this as unknown as { txStatusScript: (hash: string) => Promise<"confirmed" | "failed" | "pending"> }).txStatusScript(txHash);
    },
    async treasuryNearBalance() {
      return "9900000000000000000000000";
    },
    ...overrides,
  };
  return chain as never;
}

function makeSession(overrides: Partial<GameSessionClaims> = {}): GameSessionClaims {
  return {
    sessionId: "sess-1",
    playerId: "player_1",
    displayName: "Tester",
    authMode: "near",
    nearPublicKey: "ed25519:9RBws9u5jKencGEaxVuV4FXY85Ue22TwTozMxYDG8ryh",
    nearAccountId: RECEIVER,
    auth0SubjectHash: "hash",
    issuedAt: 1,
    expiresAt: 4_000_000_000,
    ...overrides,
  };
}

function makeService(chain: Nep245Chain, ledgerSeed?: object) {
  const config = loadSettlementConfig({});
  const ledger = new InMemorySettlementLedger(ledgerSeed as never);
  const store = new InMemoryWithdrawalStore();
  const settlement = new NearItemSettlement(config, chain, ledger, store);
  return { settlement, ledger, store, config };
}

const happyInput = () => ({
  session: makeSession(),
  requestId: "req-0001",
  tokenId: "bread",
  amount: 3,
});

describe("NearItemSettlement.withdraw", () => {
  it("completes a withdrawal: hold -> transfer -> FINAL -> commit", async () => {
    const chain = makeChain();
    const { settlement, ledger } = makeService(chain, {
      player_1: [{ tokenId: "bread", amount: 10 }],
    });

    const outcome = await settlement.withdraw(happyInput());
    expect(outcome.status).toBe(200);
    expect(outcome.view.status).toBe("confirmed");
    expect(outcome.view.txHash).toBe("5txhash");
    expect(outcome.view.explorerUrl).toContain("explorer.testnet.near.org/transactions/5txhash");

    expect(chain.transfers).toHaveLength(1);
    const transfer = chain.transfers[0];
    expect(transfer.receiverId).toBe(RECEIVER);
    expect(transfer.tokenId).toBe("bread");
    expect(transfer.amount).toBe(3);
    expect(transfer.memo).toContain(outcome.view.id);

    expect(await ledger.available("player_1", "bread")).toBe("7");
    expect(ledger.activeHolds("player_1")).toHaveLength(0);
  });

  it("is idempotent by (playerId, requestId) and does not transfer twice", async () => {
    const chain = makeChain();
    const { settlement, ledger } = makeService(chain, {
      player_1: [{ tokenId: "bread", amount: 10 }],
    });

    const first = await settlement.withdraw(happyInput());
    const replay = await settlement.withdraw(happyInput());
    expect(replay.view.id).toBe(first.view.id);
    expect(replay.view.replayed).toBe(true);
    expect(chain.transfers).toHaveLength(1);
    expect(await ledger.available("player_1", "bread")).toBe("7");

    // Same requestId with different parameters must conflict.
    await expect(settlement.withdraw({ ...happyInput(), amount: 4 })).rejects.toMatchObject({
      code: "CONFLICT",
      status: 409,
    });
  });

  it("rolls back the hold when the contract panics", async () => {
    const chain = makeChain({
      mtTransferAsTreasury: async () => {
        throw new SettlementError("CONFLICT", 409, "mock contract panic");
      },
    } as never as Nep245Chain);
    const { settlement, ledger, store } = makeService(chain, {
      player_1: [{ tokenId: "bread", amount: 10 }],
    });

    await expect(settlement.withdraw(happyInput())).rejects.toMatchObject({
      code: "CONFLICT",
      status: 409,
    });
    expect(await ledger.available("player_1", "bread")).toBe("10");
    expect(ledger.activeHolds("player_1")).toHaveLength(0);

    const list = await store.findByPlayer("player_1");
    expect(list).toHaveLength(1);
    expect(list[0].status).toBe("refunded");
    expect(list[0].errorCode).toBe("CONFLICT");
  });

  it("keeps funds pending (no guess) when finality timing out", async () => {
    const chain = makeChain({
      mtTransferAsTreasury: async () => {
        throw new SettlementError("TIMEOUT", 504, "finality budget exceeded");
      },
    } as never as Nep245Chain);
    const { settlement, ledger, store } = makeService(chain, {
      player_1: [{ tokenId: "bread", amount: 10 }],
    });

    const outcome = await settlement.withdraw(happyInput());
    expect(outcome.status).toBe(202);
    expect(outcome.view.status).toBe("pending");
    expect(outcome.view.txHash).toBeUndefined();
    // Funds remain reserved (10 - 3 held): the ledger does not pretend success.
    expect(await ledger.available("player_1", "bread")).toBe("7");
    expect(ledger.activeHolds("player_1")).toHaveLength(1);

    // Reconcile with an unknown-tx verdict leaves the record pending.
    const record = (await store.findByPlayer("player_1"))[0];
    await settlement.reconcile(record, new Date(Date.now() + 3 * 60_000));
    expect((await store.get(record.id))?.status).toBe("pending");

    // A later FINAL failure (by now the tx hash is known from the record)
    // releases the hold via the record's hold id.
    const withTag = {
      ...record,
      holdId: ledger.activeHolds("player_1")[0].holdId,
      txHash: "5txhash",
    };
    chain.txStatusScript = async () => "failed";
    await settlement.reconcile(withTag);
    expect(await ledger.available("player_1", "bread")).toBe("10");
  });

  it("reconciles a pending record into confirmed when the tx finally lands", async () => {
    const chain = makeChain();
    const { settlement, ledger, store } = makeService(chain, {
      player_1: [{ tokenId: "bread", amount: 10 }],
    });
    const outcome = await settlement.withdraw(happyInput());
    const record = await store.get(outcome.view.id);
    // Simulate the submitted-but-not-final state by forcing status back
    const patched = await store.update(record!.id, { status: "submitted" });
    chain.txStatusScript = async () => "confirmed";
    await settlement.reconcile(patched);
    expect((await store.get(record!.id))?.status).toBe("confirmed");
    expect(ledger.activeHolds("player_1")).toHaveLength(0);
  });

  it("rejects insufficient balance before any transfer", async () => {
    const chain = makeChain();
    const { settlement, ledger, store } = makeService(chain, {
      player_1: [{ tokenId: "bread", amount: 1 }],
    });

    await expect(settlement.withdraw(happyInput())).rejects.toMatchObject({
      code: "INSUFFICIENT_BALANCE",
      status: 409,
    });
    expect(chain.transfers).toHaveLength(0);
    expect(ledger.activeHolds("player_1")).toHaveLength(0);
    const records = await store.findByPlayer("player_1");
    expect(records[0].status).toBe("failed");
  });

  it("requires a payout address before withdrawing", async () => {
    const chain = makeChain();
    const { settlement, ledger } = makeService(chain, {
      player_1: [{ tokenId: "bread", amount: 10 }],
    });

    await expect(
      settlement.withdraw({
        ...happyInput(),
        session: makeSession({ nearAccountId: undefined }),
      }),
    ).rejects.toMatchObject({
      code: "NEAR_ACCOUNT_REQUIRED",
      status: 400,
    });
    expect(chain.transfers).toHaveLength(0);
    expect(await ledger.available("player_1", "bread")).toBe("10");
  });

  it("rejects unauthorized receivers, unknown tokens and bad sessions", async () => {
    const chain = makeChain();
    const { settlement, ledger } = makeService(chain, {
      player_1: [{ tokenId: "bread", amount: 10 }],
    });

    await expect(
      settlement.withdraw({
        ...happyInput(),
        receiver: "evil.testnet",
      }),
    ).rejects.toMatchObject({ code: "RECEIVER_MISMATCH" });

    await expect(
      settlement.withdraw({ ...happyInput(), tokenId: "not_a_token" }),
    ).rejects.toMatchObject({ code: "UNKNOWN_TOKEN" });

    await expect(
      settlement.withdraw({ ...happyInput(), requestId: "tiny" }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });

    await expect(
      settlement.withdraw({ ...happyInput(), amount: 0 }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });

    expect(chain.transfers).toHaveLength(0);
    expect(await ledger.available("player_1", "bread")).toBe("10");
  });

  it("rolls back and reports a chain outage", async () => {
    const chain = makeChain({
      mtTransferAsTreasury: async () => {
        throw new Error("Transparent network error: rpc down");
      },
    } as never as Nep245Chain);
    const { settlement, ledger, store } = makeService(chain, {
      player_1: [{ tokenId: "bread", amount: 10 }],
    });

    await expect(settlement.withdraw(happyInput())).rejects.toMatchObject({ status: 500 });
    const records = await store.findByPlayer("player_1");
    expect(records[0].status).toBe("refunded");
    expect(await ledger.available("player_1", "bread")).toBe("10");
  });
});
