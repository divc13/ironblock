import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createNearAuthHttpHandler } from "../../src/server/auth/http";
import { InMemoryAuthStore } from "../../src/server/auth/store";
import { createTestAuth, makeAuth0Token, makeEd25519PublicKey } from "./helpers";

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

describe("NEAR Auth HTTP routes", () => {
  it("exchanges a verified Auth0 token + MPC key for a game session", async () => {
    const auth = await createTestAuth();
    const store = new InMemoryAuthStore();
    const publicKey = makeEd25519PublicKey();
    const token = await makeAuth0Token(auth);
    const origin = await startServer(
      createNearAuthHttpHandler({
        config: auth.config,
        store,
        authDeps: {
          jwks: auth.jwks,
          lookupDerivedPublicKey: async () => publicKey,
        },
      }),
    );

    const response = await fetch(`${origin}/api/auth/near`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accessToken: token, nearPublicKey: publicKey }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as {
      sessionToken: string;
      expiresAt: string;
      player: { id: string; nearPublicKey: string };
    };
    expect(body.sessionToken).toMatch(/^eyJ/);
    expect(body.player.id).toMatch(/^auth0_[0-9a-f]{32}$/);
    expect(body.player.nearPublicKey).toBe(publicKey);

    const sessionResponse = await fetch(`${origin}/api/auth/session`, {
      headers: { authorization: `Bearer ${body.sessionToken}` },
    });
    expect(sessionResponse.status).toBe(200);
    const info = (await sessionResponse.json()) as {
      player: { id: string };
    };
    expect(info.player.id).toBe(body.player.id);
  });

  it("rejects invalid JSON, missing bearer tokens and wrong methods", async () => {
    const auth = await createTestAuth();
    const origin = await startServer(
      createNearAuthHttpHandler({
        config: auth.config,
        store: new InMemoryAuthStore(),
        authDeps: {
          jwks: auth.jwks,
          lookupDerivedPublicKey: async () => makeEd25519PublicKey(),
        },
      }),
    );

    const invalidJson = await fetch(`${origin}/api/auth/near`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(invalidJson.status).toBe(400);
    expect(await invalidJson.json()).toMatchObject({
      error: { code: "INVALID_REQUEST" },
    });

    const wrongType = await fetch(`${origin}/api/auth/near`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    expect(wrongType.status).toBe(415);

    const noSession = await fetch(`${origin}/api/auth/session`);
    expect(noSession.status).toBe(401);

    const wrongMethod = await fetch(`${origin}/api/auth/near`);
    expect(wrongMethod.status).toBe(405);
  });

  it("does not leak token material in a rejected login response", async () => {
    const auth = await createTestAuth();
    const origin = await startServer(
      createNearAuthHttpHandler({
        config: auth.config,
        store: new InMemoryAuthStore(),
        authDeps: {
          jwks: auth.jwks,
          lookupDerivedPublicKey: async () => makeEd25519PublicKey(),
        },
      }),
    );
    const token = await makeAuth0Token(auth, {}, {
      audience: "wrong-audience",
    });

    const response = await fetch(`${origin}/api/auth/near`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accessToken: token,
        nearPublicKey: makeEd25519PublicKey(),
      }),
    });
    const body = await response.text();
    expect(response.status).toBe(401);
    expect(body).toContain("INVALID_AUDIENCE");
    expect(body).not.toContain(token);
  });
});
