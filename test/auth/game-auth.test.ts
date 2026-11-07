import { describe, expect, it } from "vitest";
import type { RpgServerAuthSocket } from "@rpgjs/server";
import { authenticateGameSocket } from "../../src/server/auth/game-auth";
import type { VerifiedNearIdentity } from "../../src/server/auth/near-identity";
import { issueGameSession } from "../../src/server/auth/session";
import { InMemoryAuthStore } from "../../src/server/auth/store";
import {
  createTestAuth,
  makeEd25519PublicKey,
} from "./helpers";

function identity(publicKey = makeEd25519PublicKey()): VerifiedNearIdentity {
  return {
    auth0Subject: "auth0|socket-subject",
    auth0SubjectHash: "0123456789abcdef",
    playerId: "auth0_0123456789abcdef0123456789abcdef",
    nearPublicKey: publicKey,
    nearAccountId: publicKey.split(":")[1] ?? "account",
    displayName: "socket-player",
    derivedKeyPath:
      "jwt#https://login.testnet.fast-auth.com/#auth0|socket-subject",
  };
}

function socket(token?: string): RpgServerAuthSocket {
  return {
    handshake: { query: token ? { token } : {} },
  } as unknown as RpgServerAuthSocket;
}

async function expectRejected(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toThrow(
    "Authentication failed: invalid or expired game session",
  );
}

describe("authenticateGameSocket", () => {
  it("accepts a valid stored session and returns ephemeral auth data", async () => {
    const auth = await createTestAuth();
    const store = new InMemoryAuthStore();
    const issued = await issueGameSession(identity(), auth.config);
    store.createSession(issued.claims);

    await expect(
      authenticateGameSocket(socket(issued.token), {
        config: auth.config,
        store,
      }),
    ).resolves.toEqual({
      id: issued.claims.playerId,
      data: {
        sessionId: issued.claims.sessionId,
        nearPublicKey: issued.claims.nearPublicKey,
        nearAccountId: issued.claims.nearAccountId,
        nearAccountSource: issued.claims.nearAccountSource,
        auth0SubjectHash: issued.claims.auth0SubjectHash,
        displayName: issued.claims.displayName,
      },
    });
  });

  it("rejects a missing session token", async () => {
    const auth = await createTestAuth();
    await expect(
      authenticateGameSocket(socket(), {
        config: auth.config,
        store: new InMemoryAuthStore(),
      }),
    ).rejects.toThrow("Authentication required");
  });

  it("rejects a revoked session even though its signature is valid", async () => {
    const auth = await createTestAuth();
    const store = new InMemoryAuthStore();
    const issued = await issueGameSession(identity(), auth.config);
    store.createSession(issued.claims);
    store.revokeSession(issued.claims.sessionId);

    await expectRejected(
      authenticateGameSocket(socket(issued.token), {
        config: auth.config,
        store,
      }),
    );
  });

  it("rejects an expired session at WebSocket connect time", async () => {
    const auth = await createTestAuth();
    const store = new InMemoryAuthStore();
    const issued = await issueGameSession(identity(), {
      ...auth.config,
      sessionTtlSeconds: -60,
    });
    store.createSession(issued.claims);

    await expectRejected(
      authenticateGameSocket(socket(issued.token), {
        config: auth.config,
        store,
      }),
    );
  });

  it("falls back to the signed token in a fresh process with no session records", async () => {
    const auth = await createTestAuth();
    const issued = await issueGameSession(identity(), auth.config);

    await expect(
      authenticateGameSocket(socket(issued.token), {
        config: auth.config,
        store: new InMemoryAuthStore(),
      }),
    ).resolves.toMatchObject({ id: issued.claims.playerId });
  });
});
