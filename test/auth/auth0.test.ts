import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { AuthError } from "../../src/server/auth/errors";
import { createNearAuthHttpHandler } from "../../src/server/auth/http";
import {
  authenticateAuth0Login,
  updatePayoutAddress,
  verifyActiveGameSession,
} from "../../src/server/auth/service";
import {
  issueGameSession,
  verifyGameSessionToken,
} from "../../src/server/auth/session";
import { InMemoryAuthStore } from "../../src/server/auth/store";
import { createTestAuth, makeAuth0Token } from "./helpers";

const AUTH0_ENV = {
  AUTH_MODE: "auth0",
  AUTH0_DOMAIN: "dev-y6d3ancokvaznjrh.us.auth0.com",
  AUTH0_CLIENT_ID: "test-spa-client",
  AUTH0_AUDIENCE: "test-spa-client",
};

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

async function expectAuthError(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).code).toBe(code);
    return;
  }
  throw new Error(`Expected auth error ${code}`);
}

async function startServer(
  handler: ReturnType<typeof createNearAuthHttpHandler>,
): Promise<string> {
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

describe("Auth0 ID-token login", () => {
  it("issues an auth0 session without a NEAR key or payout address", async () => {
    const auth = await createTestAuth(AUTH0_ENV);
    const store = new InMemoryAuthStore();
    const token = await makeAuth0Token(auth);

    const session = await authenticateAuth0Login(
      { idToken: token },
      auth.config,
      { jwks: auth.jwks, store },
    );

    expect(session.authMode).toBe("auth0");
    expect(session.player.id).toMatch(/^auth0_[0-9a-f]{32}$/);
    expect(session.player.nearPublicKey).toBeUndefined();
    expect(session.player.nearAccountId).toBeUndefined();
    expect(store.getPlayer(session.player.id)?.nearAccountId).toBeUndefined();

    const claims = await verifyGameSessionToken(
      session.sessionToken,
      auth.config,
    );
    expect(claims.authMode).toBe("auth0");
    expect(claims.nearPublicKey).toBeUndefined();
    expect(claims.nearAccountId).toBeUndefined();
  });

  it("accepts an optional payout address and keeps it across later logins", async () => {
    const auth = await createTestAuth(AUTH0_ENV);
    const store = new InMemoryAuthStore();
    const token = await makeAuth0Token(auth);

    const first = await authenticateAuth0Login(
      { idToken: token, nearAccountId: "alice.testnet" },
      auth.config,
      { jwks: auth.jwks, store },
    );
    expect(first.player.nearAccountId).toBe("alice.testnet");
    expect(first.player.nearAccountSource).toBe("player");

    const second = await authenticateAuth0Login(
      { idToken: token },
      auth.config,
      { jwks: auth.jwks, store },
    );
    expect(second.player.nearAccountId).toBe("alice.testnet");
    expect(second.player.nearAccountSource).toBe("player");
  });

  it("rejects an invalid payout address without trusting it", async () => {
    const auth = await createTestAuth(AUTH0_ENV);
    const token = await makeAuth0Token(auth);

    await expectAuthError(
      authenticateAuth0Login(
        { idToken: token, nearAccountId: "Not A NEAR Account" },
        auth.config,
        { jwks: auth.jwks, store: new InMemoryAuthStore() },
      ),
      "INVALID_NEAR_ACCOUNT",
    );
  });

  it("rejects an Auth0 login on a near-mode server", async () => {
    const auth = await createTestAuth();
    const token = await makeAuth0Token(auth);

    await expectAuthError(
      authenticateAuth0Login(
        { idToken: token },
        auth.config,
        { jwks: auth.jwks, store: new InMemoryAuthStore() },
      ),
      "CONFIGURATION",
    );
  });

  it("updates the payout address and revokes the previous session", async () => {
    const auth = await createTestAuth(AUTH0_ENV);
    const store = new InMemoryAuthStore();
    const token = await makeAuth0Token(auth);
    const first = await authenticateAuth0Login(
      { idToken: token },
      auth.config,
      { jwks: auth.jwks, store },
    );

    const updated = await updatePayoutAddress(
      first.sessionToken,
      "bob.testnet",
      auth.config,
      store,
    );
    expect(updated.authMode).toBe("auth0");
    expect(updated.player.nearAccountId).toBe("bob.testnet");
    expect(updated.player.nearAccountSource).toBe("player");

    await expectAuthError(
      verifyActiveGameSession(first.sessionToken, auth.config, store),
      "SESSION_INVALID",
    );
    const claims = await verifyActiveGameSession(
      updated.sessionToken,
      auth.config,
      store,
    );
    expect(claims.nearAccountId).toBe("bob.testnet");
  });

  it("rejects a near-mode session on an auth0-mode server", async () => {
    const near = await createTestAuth();
    const auth0 = await createTestAuth(AUTH0_ENV);
    const issued = await issueGameSession(
      {
        playerId: "auth0_0123456789abcdef0123456789abcdef",
        displayName: "near-player",
        authMode: "near",
        nearPublicKey: `ed25519:${"a".repeat(44)}`,
        nearAccountId: "a".repeat(64),
        auth0SubjectHash: "0123456789abcdef",
      },
      near.config,
    );

    await expectAuthError(
      verifyGameSessionToken(issued.token, auth0.config),
      "SESSION_INVALID",
    );
  });
});

describe("Auth0 HTTP routes", () => {
  it("logs in, sets a payout address and reports auth0 health", async () => {
    const auth = await createTestAuth(AUTH0_ENV);
    const store = new InMemoryAuthStore();
    const token = await makeAuth0Token(auth);
    const origin = await startServer(
      createNearAuthHttpHandler({
        config: auth.config,
        store,
        rateLimiter: false,
        authDeps: { jwks: auth.jwks },
      }),
    );

    const health = await fetch(`${origin}/api/auth/health`);
    expect(await health.json()).toEqual({
      status: "ok",
      service: "ironblock-auth",
      mode: "auth0",
      network: "testnet",
    });

    const login = await fetch(`${origin}/api/auth/auth0`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idToken: token }),
    });
    expect(login.status).toBe(200);
    const first = (await login.json()) as {
      sessionToken: string;
      authMode: string;
      player: { nearAccountId?: string };
    };
    expect(first.authMode).toBe("auth0");
    expect(first.player.nearAccountId).toBeUndefined();

    const invalid = await fetch(`${origin}/api/auth/near-account`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${first.sessionToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ nearAccountId: "bad account" }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      error: { code: "INVALID_NEAR_ACCOUNT" },
    });

    const update = await fetch(`${origin}/api/auth/near-account`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${first.sessionToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ nearAccountId: "carol.testnet" }),
    });
    expect(update.status).toBe(200);
    const second = (await update.json()) as {
      sessionToken: string;
      player: { nearAccountId: string };
    };
    expect(second.player.nearAccountId).toBe("carol.testnet");

    const oldSession = await fetch(`${origin}/api/auth/session`, {
      headers: { authorization: `Bearer ${first.sessionToken}` },
    });
    expect(oldSession.status).toBe(401);

    const newSession = await fetch(`${origin}/api/auth/session`, {
      headers: { authorization: `Bearer ${second.sessionToken}` },
    });
    expect(newSession.status).toBe(200);
    expect(await newSession.json()).toMatchObject({
      authMode: "auth0",
      player: { nearAccountId: "carol.testnet" },
    });
  });
});
