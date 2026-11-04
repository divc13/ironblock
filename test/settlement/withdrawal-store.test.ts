import { describe, expect, it } from "vitest";
import {
  InMemoryWithdrawalStore,
  recordToView,
} from "../../src/server/settlement/withdrawal-store";
import { SettlementError } from "../../src/server/settlement/errors";
import type { WithdrawalRecord } from "../../src/server/settlement/withdrawal-store";

function draft(overrides: Partial<WithdrawalRecord> = {}): WithdrawalRecord {
  return {
    id: "wd1",
    playerId: "p1",
    requestId: "req-0001",
    tokenId: "bread",
    amount: "3",
    receiverId: "f".repeat(64),
    status: "pending",
    contractId: "v2.ironblock-items.testnet",
    network: "testnet",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("InMemoryWithdrawalStore", () => {
  it("inserts, reads and lists per player", async () => {
    const store = new InMemoryWithdrawalStore(() => "wd1");
    await store.insert(draft());
    expect((await store.get("wd1"))?.status).toBe("pending");
    expect((await store.get("p1", "req-0001"))?.id).toBe("wd1");
    await store.update("wd1", { status: "confirmed", confirmedAt: new Date().toISOString() });
    expect((await store.get("wd1"))?.status).toBe("confirmed");
    const list = await store.findByPlayer("p1");
    expect(list).toHaveLength(1);
    expect(await store.findByPlayer("ghost")).toEqual([]);
  });

  it("prevents duplicate requestId per player across ids", async () => {
    const store = new InMemoryWithdrawalStore();
    await store.insert(draft({ id: "a" }));
    await expect(store.insert(draft({ id: "b", amount: "5" }))).rejects.toMatchObject({ code: "CONFLICT" });
    // Same requestId for another player is fine.
    await expect(store.insert(draft({ id: "c", playerId: "p2" }))).resolves.toBeTruthy();
  });

  it("strips internal fields in the public view", () => {
    const view = recordToView(draft({ holdId: "hold_x" }));
    expect(view).not.toHaveProperty("holdId");
    expect(view).not.toHaveProperty("updatedAt");
  });
});
