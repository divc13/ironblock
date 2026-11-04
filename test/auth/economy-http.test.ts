import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { economy } from "../../src/config/economy";
import type { PersistedEconomyEnvelope } from "../../src/shared/economy";
import { createEconomyHttpHandler } from "../../src/server/economy/http";
import { EconomyService } from "../../src/server/economy/service";
import { InMemoryAuthStore } from "../../src/server/auth/store";
import { issueGameSession } from "../../src/server/auth/session";
import type { VerifiedNearIdentity } from "../../src/server/auth/near-identity";
import { createTestAuth, makeEd25519PublicKey } from "./helpers";

class MemoryEconomyStore {
  private envelope: PersistedEconomyEnvelope | null = null;

  async load(): Promise<PersistedEconomyEnvelope | null> {
    return this.envelope;
  }

  async save(envelope: PersistedEconomyEnvelope): Promise<void> {
    this.envelope = envelope;
  }

  async reset(): Promise<void> {
    this.envelope = null;
  }
}

const identity = (publicKey: string): VerifiedNearIdentity => ({
  auth0Subject: "auth0|economy-http-test",
  auth0SubjectHash: "0123456789abcdef",
  playerId: "auth0_0123456789abcdef0123456789abcdef",
  nearPublicKey: publicKey,
  nearAccountId: publicKey.split(":")[1] ?? "account",
  displayName: "Economy Tester",
  derivedKeyPath: "jwt#https://login.testnet.fast-auth.com/#auth0|economy-http-test",
});

describe("authenticated economy HTTP routes", () => {
  let server: Server;
  let origin: string;
  let token: string;
  let service: EconomyService;

  const call = async (
    path: string,
    init: RequestInit & { json?: unknown; bearer?: string } = {},
  ): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (init.json !== undefined) headers.set("content-type", "application/json");
    if (init.bearer !== "") {
      headers.set("authorization", `Bearer ${init.bearer ?? token}`);
    }
    return fetch(`${origin}${path}`, {
      ...init,
      headers,
      body: init.json === undefined ? init.body : JSON.stringify(init.json),
    });
  };

  beforeAll(async () => {
    const auth = await createTestAuth();
    const store = new InMemoryAuthStore();
    const issued = await issueGameSession(identity(makeEd25519PublicKey()), auth.config);
    store.createSession(issued.claims);
    token = issued.token;

    service = await EconomyService.create({
      config: economy,
      store: new MemoryEconomyStore(),
      autoSave: false,
    });

    const handler = createEconomyHttpHandler({
      config: auth.config,
      store,
      service,
      rateLimiter: false,
    });
    server = createServer((req, res) => {
      handler(req, res, () => {
        res.statusCode = 404;
        res.end("not found");
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address() as AddressInfo;
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("rejects requests without a game session", async () => {
    const response = await call("/api/economy/snapshot", { bearer: "" });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "UNAUTHORIZED" },
    });
  });

  it("returns the authenticated player and merchant world", async () => {
    const response = await call("/api/economy/snapshot");
    expect(response.status).toBe(200);
    const snapshot = (await response.json()) as {
      player: { id: string; cash: number };
      merchants: unknown[];
      sequence: number;
      state: { day: number };
    };
    expect(snapshot.player.id).toBe(identity("").playerId);
    expect(snapshot.player.cash).toBeGreaterThan(0);
    expect(snapshot.merchants).toHaveLength(Object.keys(economy.merchants).length);
    expect(snapshot.sequence).toBeGreaterThanOrEqual(0);
    expect(snapshot.state.day).toBeGreaterThanOrEqual(1);
  });

  it("serves authoritative quotes", async () => {
    const params = new URLSearchParams({
      merchantId: "ferro",
      itemId: "iron_ore",
      side: "buy",
      quantity: "1",
    });
    const response = await call(`/api/economy/quote?${params}`);
    expect(response.status).toBe(200);
    const quote = (await response.json()) as {
      merchantId: string;
      itemId: string;
      unitPrice: number;
    };
    expect(quote.merchantId).toBe("ferro");
    expect(quote.itemId).toBe("iron_ore");
    expect(quote.unitPrice).toBeGreaterThan(0);
  });

  it("validates request bodies and maps engine errors", async () => {
    const invalid = await call("/api/economy/trade", {
      method: "POST",
      json: { merchantId: "ferro" },
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      error: { code: "INVALID_REQUEST" },
    });

    const wrongTool = await call("/api/economy/gather", {
      method: "POST",
      json: { resourceId: "wheat_field" },
    });
    expect(wrongTool.status).toBe(400);
    expect(await wrongTool.json()).toMatchObject({
      error: { code: "required_tool_missing" },
    });
  });

  it("runs the gather → craft → trade → repair → eat loop", async () => {
    for (let index = 0; index < 3; index += 1) {
      const gathered = await call("/api/economy/gather", {
        method: "POST",
        json: { resourceId: "iron_vein" },
      });
      expect(gathered.status).toBe(200);
    }

    const crafted = await call("/api/economy/craft", {
      method: "POST",
      json: { recipeId: "smelt_iron_ingot", quantity: 1 },
    });
    expect(crafted.status).toBe(200);
    expect(await crafted.json()).toMatchObject({
      ok: true,
      recipeId: "smelt_iron_ingot",
    });

    const bought = await call("/api/economy/trade", {
      method: "POST",
      json: {
        merchantId: "ferro",
        itemId: "iron_ore",
        side: "buy",
        quantity: 1,
      },
    });
    expect(bought.status).toBe(200);
    expect(await bought.json()).toMatchObject({ ok: true, fillQuantity: 1 });

    const repaired = await call("/api/economy/repair", {
      method: "POST",
      json: {},
    });
    expect(repaired.status).toBe(200);
    expect(await repaired.json()).toMatchObject({ ok: true });

    const ate = await call("/api/economy/eat", {
      method: "POST",
      json: { itemId: "bread" },
    });
    expect(ate.status).toBe(200);
    expect(await ate.json()).toMatchObject({ ok: true, itemId: "bread" });
  });

  it("serves events, orders and a derived recap", async () => {
    const events = await call("/api/economy/events?since=0");
    expect(events.status).toBe(200);
    expect(Array.isArray((await events.json()).events)).toBe(true);

    const orders = await call("/api/economy/orders");
    expect(orders.status).toBe(200);
    expect(Array.isArray(await orders.json())).toBe(true);

    const recap = await call("/api/economy/recap");
    expect(recap.status).toBe(200);
    expect(await recap.json()).toMatchObject({
      generatedAtDay: expect.any(Number),
      trades: expect.any(Object),
      merchants: expect.any(Object),
    });
  });

  it("fast-forwards the authoritative world and reopens a bankrupt stall", async () => {
    const fastForward = await call("/api/economy/fast-forward", {
      method: "POST",
      json: { days: 7 },
    });
    expect(fastForward.status).toBe(200);
    const result = (await fastForward.json()) as {
      success: boolean;
      summaries: unknown[];
      series: unknown[];
      events: unknown[];
    };
    expect(result.success).toBe(true);
    expect(result.summaries).toHaveLength(7);
    expect(result.series).toHaveLength(7);

    const snapshot = (await (await call("/api/economy/snapshot")).json()) as {
      merchants: Array<{
        id: string;
        bankrupt: boolean;
        cash: number;
        reserve: number;
      }>;
      player: { cash: number };
    };
    const bankrupt = snapshot.merchants.find((merchant) => merchant.bankrupt);
    expect(bankrupt).toBeDefined();

    const required = Math.max(
      0,
      Math.ceil((bankrupt?.reserve ?? 0) * 2 - (bankrupt?.cash ?? 0)),
    );
    expect(snapshot.player.cash).toBeGreaterThanOrEqual(required);
    const invested = await call("/api/economy/invest", {
      method: "POST",
      json: { merchantId: bankrupt?.id, amount: required },
    });
    expect(invested.status).toBe(200);
    expect(await invested.json()).toMatchObject({ ok: true, reopened: true });
  });
});
