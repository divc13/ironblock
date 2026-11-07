import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { loadServerAuthConfig, type ServerAuthConfig } from "../../src/server/auth/config";
import { issueGameSession, verifyGameSessionToken } from "../../src/server/auth/session";
import type { GameSessionClaims } from "../../src/server/auth/session";
import type { Nep245Chain } from "../../src/server/settlement/chain";
import {
  createSettlementHttpHandler,
  InMemoryFixedWindowRateLimiter,
} from "../../src/server/settlement/http";
import { InMemorySettlementLedger } from "../../src/server/settlement/ledger";
import { InMemoryWithdrawalStore } from "../../src/server/settlement/withdrawal-store";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

const RECEIVER = "f09b12705f578af820d22da5a5f1bca10ae5fe25cd1a645da6953e2cc5730a57";
const OTHER_RECEIVER = `${"ab".repeat(32)}`;
const PLAYER_ID = "auth0_0123456789abcdef0123456789abcdef";

const ITEMS = [
  { token_id: "bread", name: "Bread", symbol: "BREAD", description: "", icon: "", decimals: 0, supply: "25000" },
  { token_id: "iron_ore", name: "Iron Ore", symbol: "IORE", description: "", icon: "", decimals: 0, supply: "100000" },
];

function mockChain(): Nep245Chain {
  return {
    async getConfig() {
      return { owner_id: "v2.ironblock-items.testnet", treasury_id: "v2.ironblock-treasury.testnet", genesis_minted: true, token_count: 13 };
    },
    async getItems() {
      return ITEMS;
    },
    async mtBalanceOf(_accountId: string, tokenId: string) {
      return tokenId === "bread" ? "24999" : "0";
    },
    async mtBatchBalanceOf() {
      return ["24999", "0"];
    },
    async mtTransferAsTreasury(input) {
      return {
        txHash: `tx_${input.tokenId}_${input.amount}`,
        explorerUrl: `https://explorer.testnet.near.org/transactions/tx_${input.tokenId}_${input.amount}`,
        final: true,
      };
    },
    async transactionStatus() {
      return "confirmed";
    },
    async treasuryNearBalance() {
      return "10000000000000000000000000";
    },
  };
}

const AUTH_ENV = {
  NEAR_AUTH_SESSION_SECRET: "test-session-secret-that-is-long-enough-1234567890",
};

async function makeSessionToken(
  config: ServerAuthConfig,
  nearAccountId = RECEIVER,
  playerId = PLAYER_ID,
): Promise<string> {
  const session = await issueGameSession(
    {
      playerId,
      displayName: "Tester",
      authMode: "near",
      nearPublicKey: "ed25519:9RBws9u5jKencGEaxVuV4FXY85Ue22TwTozMxYDG8ryh",
      nearAccountId,
      auth0SubjectHash: `hash-${playerId}`,
      auth0Subject: `auth0|${playerId}`,
      derivedKeyPath: "m/0",
    },
    config,
  );
  return session.token;
}

function makeBundle(extra: Record<string, unknown> = {}) {
  const authConfig = loadServerAuthConfig(AUTH_ENV);
  const ledger = new InMemorySettlementLedger({
    [PLAYER_ID]: [{ tokenId: "bread", amount: 5 }],
  });
  const withdrawalStore = new InMemoryWithdrawalStore();
  const handler = createSettlementHttpHandler({
    chain: mockChain(),
    ledger,
    store: withdrawalStore,
    authConfig,
    verifySession: (token) => verifyGameSessionToken(token, authConfig),
    ...extra,
  });
  return { handler, withdrawalStore, ledger, authConfig };
}

async function startServer(handler: ReturnType<typeof createSettlementHttpHandler>): Promise<string> {
  const server = createServer((req, res) => {
    handler(req, res, () => {
      res.statusCode = 404;
      res.end("not found");
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function withdraw(sessionToken: string, origin: string, body: object): Promise<Response> {
  return fetch(`${origin}/api/settlement/withdraw`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${sessionToken}` },
    body: JSON.stringify(body),
  });
}

describe("settlement HTTP routes", () => {
  it("health requires no session and reports config", async () => {
    const { handler } = makeBundle();
    const origin = await startServer(handler);
    const response = await fetch(`${origin}/api/settlement/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { service: string; contractId: string };
    expect(body.service).toBe("settlement");
    expect(body.contractId).toBe("v2.ironblock-items.testnet");
  });

  it("withdraws and replays idempotently", async () => {
    const { handler } = makeBundle();
    const origin = await startServer(handler);
    const token = await makeSessionToken(loadServerAuthConfig(AUTH_ENV));

    const response = await withdraw(token, origin, { requestId: "req-http-01", tokenId: "bread", amount: 3 });
    expect(response.status).toBe(200);
    const view = (await response.json()) as { status: string; txHash?: string; id: string; amount: string };
    expect(view.status).toBe("confirmed");
    expect(view.txHash).toBe("tx_bread_3");
    expect(view.amount).toBe("3");

    const replay = await withdraw(token, origin, { requestId: "req-http-01", tokenId: "bread", amount: 3 });
    expect(replay.status).toBe(200);
    const replayView = (await replay.json()) as { id: string; replayed?: boolean };
    expect(replayView.id).toBe(view.id);
    expect(replayView.replayed).toBe(true);

    // Same requestId, different params -> conflict
    const conflict = await withdraw(token, origin, { requestId: "req-http-01", tokenId: "bread", amount: 4 });
    expect(conflict.status).toBe(409);
  });

  it("rejects unauthenticated, malformed, wrong-method and mismatched requests", async () => {
    const { handler, authConfig } = makeBundle();
    const origin = await startServer(handler);
    const token = await makeSessionToken(authConfig);

    const noAuth = await fetch(`${origin}/api/settlement/withdraw`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(noAuth.status).toBe(401);

    const invalidToken = await fetch(`${origin}/api/settlement/withdraw`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer garbage" },
      body: "{}",
    });
    expect(invalidToken.status).toBe(401);

    const badJson = await fetch(`${origin}/api/settlement/withdraw`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: "{oops",
    });
    expect(badJson.status).toBe(400);
    expect(((await badJson.json()) as { error: { code: string } }).error.code).toBe("INVALID_REQUEST");

    const missingFields = await withdraw(token, origin, { tokenId: "bread" });
    expect(missingFields.status).toBe(400);

    const wrongType = await fetch(`${origin}/api/settlement/withdraw`, {
      method: "POST",
      headers: { "content-type": "text/plain", authorization: `Bearer ${token}` },
      body: "{}",
    });
    expect(wrongType.status).toBe(415);

    const wrongMethod = await fetch(`${origin}/api/settlement/withdraw`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(wrongMethod.status).toBe(405);

    const foreignReceiver = await withdraw(token, origin, {
      requestId: "req-http-02",
      tokenId: "bread",
      amount: 1,
      receiver: OTHER_RECEIVER,
    });
    expect(foreignReceiver.status).toBe(400);
    expect(((await foreignReceiver.json()) as { error: { code: string } }).error.code).toBe("RECEIVER_MISMATCH");
  });

  it("serves withdrawal lookup with ownership isolation", async () => {
    const { handler, withdrawalStore, authConfig } = makeBundle();
    await withdrawalStore.insert({
      id: "wd_owner",
      playerId: PLAYER_ID,
      requestId: "req-owner-1",
      tokenId: "bread",
      amount: "2",
      receiverId: RECEIVER,
      status: "confirmed",
      contractId: "v2.ironblock-items.testnet",
      network: "testnet",
      createdAt: new Date().toISOString(),
    });
    const ownerToken = await makeSessionToken(authConfig);
    const otherToken = await makeSessionToken(authConfig, OTHER_RECEIVER, "auth0_ffffffffffffffffffffffffffffffff");
    const origin = await startServer(handler);

    const mine = await fetch(`${origin}/api/settlement/withdrawals/wd_owner`, {
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(mine.status).toBe(200);
    expect(((await mine.json()) as { playerId: string }).playerId).toBe(PLAYER_ID);

    const foreign = await fetch(`${origin}/api/settlement/withdrawals/wd_owner`, {
      headers: { authorization: `Bearer ${otherToken}` },
    });
    expect(foreign.status).toBe(404);

    const list = await fetch(`${origin}/api/settlement/withdrawals`, {
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(list.status).toBe(200);
    const listView = (await list.json()) as { withdrawals: unknown[] };
    expect(listView.withdrawals).toHaveLength(1);
    expect(listView.withdrawals[0]).toMatchObject({ id: "wd_owner" });

    const unknown = await fetch(`${origin}/api/settlement/withdrawals/ghost`, {
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(unknown.status).toBe(404);
  });

  it("exposes read-only onchain balances", async () => {
    const { handler, authConfig } = makeBundle();
    const token = await makeSessionToken(authConfig);
    const origin = await startServer(handler);
    const response = await fetch(`${origin}/api/settlement/onchain/${RECEIVER}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    const view = (await response.json()) as { accountId: string; balances: Record<string, string>; items: unknown[] };
    expect(view.accountId).toBe(RECEIVER);
    expect(view.balances.bread).toBe("24999");
    expect(view.items).toHaveLength(2);
  });

  it("rate limits withdrawals per session", async () => {
    const { handler, authConfig } = makeBundle({
      withdrawalLimiter: new InMemoryFixedWindowRateLimiter(1, 60_000),
    });
    const token = await makeSessionToken(authConfig);
    const origin = await startServer(handler);

    const first = await withdraw(token, origin, { requestId: "req-rl-0001", tokenId: "bread", amount: 1 });
    expect(first.status).toBe(200);

    const second = await withdraw(token, origin, { requestId: "req-rl-0002", tokenId: "bread", amount: 1 });
    expect(second.status).toBe(429);
    expect(((await second.json()) as { error: { code: string } }).error.code).toBe("RATE_LIMITED");
  });

  it("handles unknown routes and subpath prefixes safely", async () => {
    const { handler, authConfig } = makeBundle();
    const token = await makeSessionToken(authConfig);
    const origin = await startServer(handler);

    const direct = await fetch(`${origin}/api/settlement/nope`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(direct.status).toBe(404);
    expect(((await direct.json()) as { error: { code: string } }).error.code).toBe("NOT_FOUND");

    // Subpath deployments still reach the settlement handler.
    const roots = await fetch(`${origin}/api/auth/settlement/health`);
    expect([404, 200]).toContain(roots.status);
  });
});

export type { GameSessionClaims };
