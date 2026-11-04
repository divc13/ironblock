import { describe, expect, it } from "vitest";
import { AuthError } from "../../src/server/auth/errors";
import {
  issueGameSession,
  verifyGameSessionToken,
} from "../../src/server/auth/session";
import type { VerifiedNearIdentity } from "../../src/server/auth/near-identity";
import { InMemoryAuthStore } from "../../src/server/auth/store";
import {
  authenticateNearLogin,
  describeGameSession,
} from "../../src/server/auth/service";
import { createTestAuth, makeAuth0Token, makeEd25519PublicKey } from "./helpers";

async function expectAuthError(
  promise: Promise<unknown>,
  code: string,
): Promise<AuthError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).code).toBe(code);
    return error as AuthError;
  }
  throw new Error(`Expected auth error ${code}`);
}

function identity(publicKey = makeEd25519PublicKey()): VerifiedNearIdentity {
  return {
    auth0Subject: "auth0|session-subject",
    auth0SubjectHash: "0123456789abcdef",
    playerId: "auth0_0123456789abcdef0123456789abcdef",
    nearPublicKey: publicKey,
    nearAccountId: publicKey.split(":")[1] ?? "account",
    displayName: "session-player",
    derivedKeyPath:
      "jwt#https://login.testnet.fast-auth.com/#auth0|session-subject",
  };
}

describe("game sessions", () => {
  it("issues an HMAC session that verifies with the same config", async () => {
    const auth = await createTestAuth();
    const issued = await issueGameSession(identity(), auth.config);

    const claims = await verifyGameSessionToken(issued.token, auth.config);

    expect(claims).toEqual(issued.claims);
    expect(claims.playerId).toBe("auth0_0123456789abcdef0123456789abcdef");
    expect(claims.expiresAt).toBeGreaterThan(claims.issuedAt);
    expect(issued.expiresAt).toBe(
      new Date(claims.expiresAt * 1000).toISOString(),
    );
  });

  it("rejects a tampered session token", async () => {
    const auth = await createTestAuth();
    const issued = await issueGameSession(identity(), auth.config);
    const [header, payload, signature] = issued.token.split(".");
    const tampered = `${header}.${payload}.${signature.slice(0, -2)}xx`;

    await expectAuthError(
      verifyGameSessionToken(tampered, auth.config),
      "SESSION_INVALID",
    );
  });

  it("rejects a session signed with a different secret", async () => {
    const auth = await createTestAuth();
    const other = await createTestAuth({
      NEAR_AUTH_SESSION_SECRET:
        "a-completely-different-session-secret-that-is-long-enough",
    });
    const issued = await issueGameSession(identity(), other.config);

    await expectAuthError(
      verifyGameSessionToken(issued.token, auth.config),
      "SESSION_INVALID",
    );
  });

  it("rejects an expired session", async () => {
    const auth = await createTestAuth();
    const issued = await issueGameSession(identity(), {
      ...auth.config,
      sessionTtlSeconds: -60,
    });

    await expectAuthError(
      verifyGameSessionToken(issued.token, auth.config),
      "SESSION_INVALID",
    );
  });
});

describe("InMemoryAuthStore", () => {
  it("upserts one player and keeps the first creation timestamp", async () => {
    const store = new InMemoryAuthStore();
    const publicKey = makeEd25519PublicKey();
    const player = {
      id: "auth0_0123456789abcdef0123456789abcdef",
      displayName: "merchant",
      nearPublicKey: publicKey,
      nearAccountId: "account",
      auth0SubjectHash: "0123456789abcdef",
    };

    const first = store.upsertPlayer({
      identity: player,
      auth0Subject: "auth0|subject",
      email: "first@example.com",
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = store.upsertPlayer({
      identity: { ...player, displayName: "renamed" },
      auth0Subject: "auth0|subject",
      email: "second@example.com",
    });

    expect(store.size.players).toBe(1);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.lastLoginAt >= first.lastLoginAt).toBe(true);
    expect(second.displayName).toBe("renamed");
    expect(second.email).toBe("second@example.com");
  });

  it("creates, reads, revokes and prunes sessions", async () => {
    const auth = await createTestAuth();
    const issued = await issueGameSession(identity(), {
      ...auth.config,
      sessionTtlSeconds: 3600,
    });
    const store = new InMemoryAuthStore();
    store.createSession(issued.claims);

    expect(store.getSession(issued.claims.sessionId)?.playerId).toBe(
      issued.claims.playerId,
    );

    store.revokeSession(issued.claims.sessionId);
    expect(store.getSession(issued.claims.sessionId)).toBeUndefined();

    store.createSession(issued.claims);
    store.prune(Date.now() + 3_600_001);
    expect(store.size.sessions).toBe(0);
  });
});

describe("authenticateNearLogin", () => {
  it("verifies JWT, derives identity, stores the player and issues a session", async () => {
    const auth = await createTestAuth();
    const store = new InMemoryAuthStore();
    const publicKey = makeEd25519PublicKey();
    const token = await makeAuth0Token(auth, {
      sub: "auth0|end-to-end-subject",
      email: "player@example.com",
    });
    let requestedPath = "";

    const response = await authenticateNearLogin(
      { accessToken: token, nearPublicKey: publicKey },
      auth.config,
      {
        jwks: auth.jwks,
        store,
        lookupDerivedPublicKey: async (path) => {
          requestedPath = path;
          return publicKey;
        },
      },
    );

    expect(requestedPath).toBe(
      "jwt#https://login.testnet.fast-auth.com/#auth0|end-to-end-subject",
    );
    expect(response.player.nearPublicKey).toBe(publicKey);
    expect(response.player.nearAccountId).toMatch(/^[0-9a-f]{64}$/);
    expect(response.player.displayName).toBe("player");
    expect(response.sessionToken).toMatch(/^eyJ/);
    expect(store.size).toEqual({ players: 1, sessions: 1 });

    const info = await describeGameSession(
      response.sessionToken,
      auth.config,
      store,
    );
    expect(info.player).toEqual(response.player);
  });

  it("does not issue a session when the NEAR key does not match", async () => {
    const auth = await createTestAuth();
    const store = new InMemoryAuthStore();
    const token = await makeAuth0Token(auth);

    await expectAuthError(
      authenticateNearLogin(
        {
          accessToken: token,
          nearPublicKey: makeEd25519PublicKey(),
        },
        auth.config,
        {
          jwks: auth.jwks,
          store,
          lookupDerivedPublicKey: async () => makeEd25519PublicKey(),
        },
      ),
      "NEAR_KEY_MISMATCH",
    );

    expect(store.size).toEqual({ players: 0, sessions: 0 });
  });

  it("rejects a revoked session even when its signature is valid", async () => {
    const auth = await createTestAuth();
    const store = new InMemoryAuthStore();
    const publicKey = makeEd25519PublicKey();
    const token = await makeAuth0Token(auth);

    const response = await authenticateNearLogin(
      { accessToken: token, nearPublicKey: publicKey },
      auth.config,
      {
        jwks: auth.jwks,
        store,
        lookupDerivedPublicKey: async () => publicKey,
      },
    );
    store.revokeSession(
      (await verifyGameSessionToken(response.sessionToken, auth.config))
        .sessionId,
    );

    await expectAuthError(
      describeGameSession(response.sessionToken, auth.config, store),
      "SESSION_INVALID",
    );
  });
});
