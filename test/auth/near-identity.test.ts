import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "../../src/server/auth/errors";
import {
  derivedKeyPathForSubject,
  lookupMpcDerivedPublicKey,
  playerIdForSubject,
  subjectHashForSubject,
  verifyNearIdentityForSubject,
} from "../../src/server/auth/near-identity";
import { createTestAuth, makeEd25519PublicKey } from "./helpers";

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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("NEAR identity mapping", () => {
  it("uses the JavaScript provider path derived from the verified subject", async () => {
    const auth = await createTestAuth();

    expect(derivedKeyPathForSubject(auth.config, "auth0|abc")).toBe(
      "jwt#https://login.testnet.fast-auth.com/#auth0|abc",
    );
  });

  it("maps a subject to a stable pseudonymous player id", () => {
    const first = playerIdForSubject("auth0|stable-subject");
    const second = playerIdForSubject("auth0|stable-subject");

    expect(first).toBe(second);
    expect(first).toMatch(/^auth0_[0-9a-f]{32}$/);
    expect(first).not.toContain("stable-subject");
    expect(playerIdForSubject("auth0|another-subject")).not.toBe(first);
  });

  it("returns a short public subject hash, never the raw subject", () => {
    const hash = subjectHashForSubject("auth0|stable-subject");

    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(hash).not.toContain("stable-subject");
  });

  it("accepts the MPC-derived key and computes the implicit account id", async () => {
    const auth = await createTestAuth();
    const publicKey = makeEd25519PublicKey();
    let requestedPath = "";

    const identity = await verifyNearIdentityForSubject(
      {
        subject: "auth0|player",
        email: "merchant.town@example.com",
        clientPublicKey: publicKey,
      },
      auth.config,
      async (path) => {
        requestedPath = path;
        return publicKey;
      },
    );

    expect(requestedPath).toBe(
      "jwt#https://login.testnet.fast-auth.com/#auth0|player",
    );
    expect(identity.nearPublicKey).toBe(publicKey);
    expect(identity.nearAccountId).toMatch(/^[0-9a-f]{64}$/);
    expect(identity.playerId).toBe(playerIdForSubject("auth0|player"));
    expect(identity.displayName).toBe("merchant.town");
    expect(identity.auth0Subject).toBe("auth0|player");
  });

  it("rejects a client key that is not the key derived for the subject", async () => {
    const auth = await createTestAuth();
    const expectedKey = makeEd25519PublicKey();
    const claimedKey = makeEd25519PublicKey();

    await expectAuthError(
      verifyNearIdentityForSubject(
        {
          subject: "auth0|player",
          clientPublicKey: claimedKey,
        },
        auth.config,
        async () => expectedKey,
      ),
      "NEAR_KEY_MISMATCH",
    );
  });

  it("rejects non-ed25519 and malformed keys", async () => {
    const auth = await createTestAuth();

    await expectAuthError(
      verifyNearIdentityForSubject(
        {
          subject: "auth0|player",
          clientPublicKey: "secp256k1:3WwZk...",
        },
        auth.config,
        async () => "ed25519:11111111111111111111111111111111",
      ),
      "NEAR_KEY_MISMATCH",
    );

    await expectAuthError(
      verifyNearIdentityForSubject(
        {
          subject: "auth0|player",
          clientPublicKey: "ed25519:not-base58",
        },
        auth.config,
        async () => "ed25519:not-base58",
      ),
      "NEAR_KEY_MISMATCH",
    );
  });
});

describe("lookupMpcDerivedPublicKey", () => {
  it("calls derived_public_key with the Auth0 path and NEAR Auth predecessor", async () => {
    const auth = await createTestAuth();
    const publicKey = makeEd25519PublicKey();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as {
        method: string;
        params: {
          account_id: string;
          method_name: string;
          args_base64: string;
        };
      };
      const args = JSON.parse(
        Buffer.from(request.params.args_base64, "base64").toString("utf8"),
      );
      expect(request.params.account_id).toBe("v1.signer-prod.testnet");
      expect(request.params.method_name).toBe("derived_public_key");
      expect(args).toEqual({
        path: "jwt#https://login.testnet.fast-auth.com/#auth0|lookup",
        predecessor: "fast-auth.testnet",
        domain_id: 1,
      });

      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "ironblock-near-auth",
          result: {
            result: Array.from(
              Buffer.from(JSON.stringify(publicKey), "utf8"),
            ),
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await lookupMpcDerivedPublicKey(
      "jwt#https://login.testnet.fast-auth.com/#auth0|lookup",
      auth.config,
    );

    expect(result).toBe(publicKey);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("turns RPC failures into a safe auth error", async () => {
    const auth = await createTestAuth();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "unavailable" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const error = await expectAuthError(
      lookupMpcDerivedPublicKey(
        "jwt#https://login.testnet.fast-auth.com/#auth0|lookup",
        auth.config,
      ),
      "NEAR_LOOKUP_FAILED",
    );
    expect(error.message).not.toMatch(/eyJ/);
  });

  it("rejects a malformed MPC response", async () => {
    const auth = await createTestAuth();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            result: {
              result: Array.from(Buffer.from("not a json string", "utf8")),
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    );

    await expectAuthError(
      lookupMpcDerivedPublicKey(
        "jwt#https://login.testnet.fast-auth.com/#auth0|lookup",
        auth.config,
      ),
      "NEAR_LOOKUP_FAILED",
    );
  });
});
