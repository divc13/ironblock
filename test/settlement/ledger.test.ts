import { describe, expect, it } from "vitest";
import { InMemorySettlementLedger, type SettlementLedger } from "../../src/server/settlement/ledger";
import { SettlementError } from "../../src/server/settlement/errors";

describe("InMemorySettlementLedger", () => {
  it("seeds, holds, commits and reports balances", async () => {
    const ledger = new InMemorySettlementLedger({
      p1: [{ tokenId: "bread", amount: "10" }],
    });
    expect(await ledger.available("p1", "bread")).toBe("10");

    const hold = await ledger.hold({ playerId: "p1", tokenId: "bread", amount: 4, reference: "w1" });
    expect(await ledger.available("p1", "bread")).toBe("6");
    expect((await ledger.snapshot("p1")).find((e) => e.tokenId === "bread")).toMatchObject({
      available: "6",
      held: "4",
      debited: "0",
    });

    await ledger.commit(hold);
    expect(await ledger.available("p1", "bread")).toBe("6");
    expect((await ledger.snapshot("p1")).find((e) => e.tokenId === "bread")).toMatchObject({
      available: "6",
      debited: "4",
    });
    expect(ledger.activeHolds("p1")).toHaveLength(0);
  });

  it("refuses holds beyond the available balance and releases on rollback", async () => {
    const ledger = new InMemorySettlementLedger({
      p1: [{ tokenId: "iron_ore", amount: 2 }],
    });
    await expect(
      ledger.hold({ playerId: "p1", tokenId: "iron_ore", amount: 3, reference: "w" }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_BALANCE", status: 409 });

    const hold = await ledger.hold({ playerId: "p1", tokenId: "iron_ore", amount: 2, reference: "w2" });
    await ledger.release(hold);
    expect(await ledger.available("p1", "iron_ore")).toBe("2");
  });

  it("rejects invalid amounts and unknown holds", async () => {
    const ledger = new InMemorySettlementLedger({ p1: [{ tokenId: "bread", amount: 1 }] });
    await expect(
      ledger.hold({ playerId: "p1", tokenId: "bread", amount: 0, reference: "w" }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });

    await expect(
      ledger.commit({ holdId: "nope", playerId: "p1", tokenId: "bread", amount: 1, reference: "w", createdAt: "" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("serialises concurrent holds so double submits cannot overdraw", async () => {
    const ledger = new InMemorySettlementLedger({ p1: [{ tokenId: "bread", amount: 5 }] });
    const first = ledger.hold({ playerId: "p1", tokenId: "bread", amount: 4, reference: "a" });
    const second = ledger.hold({ playerId: "p1", tokenId: "bread", amount: 4, reference: "b" });
    const [a, b] = await Promise.allSettled([first, second]);
    expect(a.status).toBe("fulfilled");
    expect(b.status).toBe("rejected");
    expect((b as PromiseRejectedResult).reason).toBeInstanceOf(SettlementError);
  });

  it("snapshots empty ledgers and unknown players", async () => {
    const ledger = new InMemorySettlementLedger();
    expect(await ledger.snapshot("ghost")).toEqual([]);
    await expect(ledger.available("ghost", "bread")).resolves.toBe("0");
  });
});
