import { describe, expect, it } from "vitest";
import { economy } from "../../src/config/economy";
import { EconomyService } from "../../src/server/economy/service";
import { createEconomySettlementLedger } from "../../src/server/settlement/economy-ledger";
import type { EconomyStore, PersistedEconomyEnvelope } from "../../src/shared/economy";
import type { EconomyConfig } from "../../src/shared/types";

/** Engine-equivalent in-memory store: no data directory, no checked-in fixtures. */
class MemoryEconomyStore implements EconomyStore {
  envelope: PersistedEconomyEnvelope | null = null;

  async load(): Promise<PersistedEconomyEnvelope | null> {
    return this.envelope;
  }

  async save(envelope: PersistedEconomyEnvelope): Promise<void> {
    this.envelope = structuredClone(envelope);
  }

  async reset(): Promise<void> {
    this.envelope = null;
  }
}

const testConfig = (inventory: Record<string, number>): EconomyConfig => {
  const config = structuredClone(economy);
  config.player.startingInventory = inventory;
  config.bots.count = 0;
  config.caravan.intervalSeconds = 365 * 86400;
  config.scenario = { ...config.scenario, shocks: [] };
  return config;
};

const createFixture = async (inventory: Record<string, number> = { bread: 5 }) => {
  const service = await EconomyService.create({
    config: testConfig(inventory),
    store: new MemoryEconomyStore(),
  });
  const created = await service.ensurePlayer("worker-1", "Worker One");
  expect(created.success).toBe(true);
  return { service, ledger: createEconomySettlementLedger(service) };
};

const inventoryOf = (service: EconomyService, itemId: string): number =>
  service.snapshot().players["worker-1"].inventory[itemId] ?? 0;

const withdrawEvents = (service: EconomyService) =>
  service.eventsSince(0).filter((event) => event.type === "player.withdraw");

/** Consume held units behind the ledger's back through a normal game trade. */
const sellBehindLedger = async (
  service: EconomyService,
  itemId: string,
  quantity: number,
) => {
  for (const merchant of Object.values(service.snapshot().merchants)) {
    const quote = service.preview("worker-1", merchant.id, itemId, "sell", quantity);
    if (quote?.canTrade) {
      return service.sell("worker-1", merchant.id, itemId, quantity);
    }
  }
  throw new Error(`no merchant can buy ${quantity} ${itemId}`);
};

describe("createEconomySettlementLedger", () => {
  it("holds against real inventory and commits the economy debit", async () => {
    const { service, ledger } = await createFixture({ bread: 5 });

    await expect(ledger.available("worker-1", "bread")).resolves.toBe("5");
    const hold = await ledger.hold({
      playerId: "worker-1",
      tokenId: "bread",
      amount: 3,
      reference: "withdraw-1",
    });

    await expect(ledger.available("worker-1", "bread")).resolves.toBe("2");
    expect(ledger.activeHolds("worker-1")).toHaveLength(1);
    expect(inventoryOf(service, "bread")).toBe(5);

    await ledger.commit(hold);

    expect(inventoryOf(service, "bread")).toBe(2);
    expect(ledger.activeHolds("worker-1")).toHaveLength(0);
    await expect(ledger.available("worker-1", "bread")).resolves.toBe("2");
    expect((await ledger.snapshot("worker-1")).find((entry) => entry.tokenId === "bread")).toMatchObject({
      available: "2",
      held: "0",
      debited: "0",
    });
    expect(withdrawEvents(service)).toHaveLength(1);
    expect(withdrawEvents(service)[0]).toMatchObject({
      item: "bread",
      quantity: 3,
      cause: "withdrawal",
    });
  });

  it("releases a hold without touching the engine", async () => {
    const { service, ledger } = await createFixture({ bread: 5 });

    const hold = await ledger.hold({
      playerId: "worker-1",
      tokenId: "bread",
      amount: 4,
      reference: "withdraw-2",
    });
    await expect(ledger.available("worker-1", "bread")).resolves.toBe("1");

    await ledger.release(hold);

    await expect(ledger.available("worker-1", "bread")).resolves.toBe("5");
    expect(inventoryOf(service, "bread")).toBe(5);
    expect(ledger.activeHolds("worker-1")).toHaveLength(0);
    expect(withdrawEvents(service)).toHaveLength(0);

    await expect(ledger.release(hold)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rejects insufficient balances, invalid amounts, unknown players and tokens", async () => {
    const { ledger } = await createFixture({ bread: 2 });

    await expect(
      ledger.hold({ playerId: "worker-1", tokenId: "bread", amount: 3, reference: "w" }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_BALANCE", status: 409 });
    expect(ledger.activeHolds("worker-1")).toHaveLength(0);

    for (const amount of [0, -1, 1.5, Number.NaN]) {
      await expect(
        ledger.hold({ playerId: "worker-1", tokenId: "bread", amount, reference: "w" }),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST", status: 400 });
    }

    await expect(
      ledger.hold({ playerId: "ghost", tokenId: "bread", amount: 1, reference: "w" }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });

    await expect(
      ledger.hold({ playerId: "worker-1", tokenId: "unobtainium", amount: 1, reference: "w" }),
    ).rejects.toMatchObject({ code: "UNKNOWN_TOKEN", status: 404 });

    expect(ledger.activeHolds("worker-1")).toHaveLength(0);
  });

  it("never lets two holds spend the same units", async () => {
    const { service, ledger } = await createFixture({ bread: 5 });

    const first = await ledger.hold({
      playerId: "worker-1",
      tokenId: "bread",
      amount: 3,
      reference: "a",
    });
    await expect(
      ledger.hold({ playerId: "worker-1", tokenId: "bread", amount: 3, reference: "b" }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_BALANCE" });

    const [concurrentA, concurrentB] = await Promise.allSettled([
      ledger.hold({ playerId: "worker-1", tokenId: "bread", amount: 2, reference: "c" }),
      ledger.hold({ playerId: "worker-1", tokenId: "bread", amount: 2, reference: "d" }),
    ]);
    expect(concurrentA.status).toBe("fulfilled");
    expect(concurrentB.status).toBe("rejected");
    expect(ledger.activeHolds("worker-1")).toHaveLength(2);

    await ledger.commit(first);
    expect(inventoryOf(service, "bread")).toBe(2);
    expect((await ledger.snapshot("worker-1")).find((entry) => entry.tokenId === "bread")).toMatchObject({
      available: "0",
      held: "2",
    });
  });

  it("snapshots every inventory token with available and held totals", async () => {
    const { ledger } = await createFixture({ bread: 5, grain: 2 });

    await ledger.hold({ playerId: "worker-1", tokenId: "bread", amount: 2, reference: "w" });

    await expect(ledger.snapshot("worker-1")).resolves.toEqual([
      { tokenId: "bread", available: "3", held: "2", debited: "0" },
      { tokenId: "grain", available: "2", held: "0", debited: "0" },
    ]);
    await expect(ledger.snapshot("ghost")).resolves.toEqual([]);
    await expect(ledger.available("ghost", "bread")).resolves.toBe("0");
  });

  it("keeps the hold when the engine refuses the commit", async () => {
    const { service, ledger } = await createFixture({ bread: 5 });

    const hold = await ledger.hold({
      playerId: "worker-1",
      tokenId: "bread",
      amount: 3,
      reference: "behind-ledger",
    });
    const sold = await sellBehindLedger(service, "bread", 3);
    expect(sold.success).toBe(true);
    expect(inventoryOf(service, "bread")).toBe(2);

    await expect(ledger.commit(hold)).rejects.toMatchObject({ code: "CONFLICT" });

    // The debit did not happen and the reservation was not silently lost.
    expect(inventoryOf(service, "bread")).toBe(2);
    expect(ledger.activeHolds("worker-1")).toHaveLength(1);
    expect(withdrawEvents(service)).toHaveLength(0);

    await ledger.release(hold);
    expect(ledger.activeHolds("worker-1")).toHaveLength(0);
    await expect(ledger.available("worker-1", "bread")).resolves.toBe("2");
  });

  it("refuses to commit an unknown or already committed hold", async () => {
    const { service, ledger } = await createFixture({ bread: 5 });
    const hold = await ledger.hold({
      playerId: "worker-1",
      tokenId: "bread",
      amount: 2,
      reference: "once",
    });
    await ledger.commit(hold);

    await expect(ledger.commit(hold)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(inventoryOf(service, "bread")).toBe(3);
    expect(withdrawEvents(service)).toHaveLength(1);
  });
});
