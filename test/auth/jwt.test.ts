import { describe, expect, it } from "vitest";
import { AuthError } from "../../src/server/auth/errors";
import { verifyAuth0Token } from "../../src/server/auth/jwt";
import { createTestAuth, makeAuth0Token } from "./helpers";

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

describe("verifyAuth0Token", () => {
  it("accepts a correctly signed token and exposes only safe claims", async () => {
    const auth = await createTestAuth();
    const token = await makeAuth0Token(auth);

    const claims = await verifyAuth0Token(token, auth.config, auth.jwks);

    expect(claims.sub).toBe("auth0|test-subject");
    expect(claims.email).toBe("tester@example.com");
    expect(claims.iss).toBe(auth.config.issuer);
    expect(claims.aud).toBe(auth.config.audience);
    expect(claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("rejects a token signed by an untrusted key", async () => {
    const auth = await createTestAuth();
    const attacker = await createTestAuth();
    const token = await makeAuth0Token(attacker);

    const error = await expectAuthError(
      verifyAuth0Token(token, auth.config, auth.jwks),
      "INVALID_TOKEN",
    );
    expect(error.message).not.toMatch(/eyJ/);
  });

  it("rejects a token from a different issuer", async () => {
    const auth = await createTestAuth();
    const token = await makeAuth0Token(auth, {}, {
      issuer: "https://attacker.example/",
    });

    await expectAuthError(
      verifyAuth0Token(token, auth.config, auth.jwks),
      "INVALID_ISSUER",
    );
  });

  it("rejects a token for a different audience", async () => {
    const auth = await createTestAuth();
    const token = await makeAuth0Token(auth, {}, {
      audience: "some-other-api",
    });

    await expectAuthError(
      verifyAuth0Token(token, auth.config, auth.jwks),
      "INVALID_AUDIENCE",
    );
  });

  it("rejects an expired token", async () => {
    const auth = await createTestAuth();
    const token = await makeAuth0Token(auth, {}, {
      expiresAt: Math.floor(Date.now() / 1000) - 60,
    });

    await expectAuthError(
      verifyAuth0Token(token, auth.config, auth.jwks),
      "TOKEN_EXPIRED",
    );
  });

  it("rejects a token without a usable subject", async () => {
    const auth = await createTestAuth();
    const token = await makeAuth0Token(auth, { sub: "   " });

    await expectAuthError(
      verifyAuth0Token(token, auth.config, auth.jwks),
      "MISSING_SUBJECT",
    );
  });

  it("rejects a malformed token without calling the verifier", async () => {
    const auth = await createTestAuth();
    let verifierCalled = false;

    await expectAuthError(
      verifyAuth0Token("not-a-jwt", auth.config, async () => {
        verifierCalled = true;
        return new Uint8Array();
      }),
      "INVALID_TOKEN",
    );
    expect(verifierCalled).toBe(false);
  });

  it("rejects a token with an unsupported algorithm", async () => {
    const auth = await createTestAuth();
    // An HS256 token is structurally valid but must never be accepted when the
    // server expects RS256 from Auth0.
    const { SignJWT } = await import("jose");
    const token = await new SignJWT({ sub: "auth0|test-subject" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(auth.config.issuer)
      .setAudience(auth.config.audience)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode("a-shared-secret-that-is-long-enough"));

    await expectAuthError(
      verifyAuth0Token(token, auth.config, auth.jwks),
      "INVALID_TOKEN",
    );
  });
});
