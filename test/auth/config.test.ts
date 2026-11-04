import { describe, expect, it } from "vitest";
import { loadServerAuthConfig } from "../../src/server/auth/config";

const VALID_SECRET = "test-session-secret-that-is-long-enough-1234567890";

describe("loadServerAuthConfig", () => {
  it("uses testnet defaults and normalizes the issuer", () => {
    const config = loadServerAuthConfig({
      NEAR_AUTH_SESSION_SECRET: VALID_SECRET,
    });

    expect(config.domain).toBe("login.testnet.fast-auth.com");
    expect(config.issuer).toBe("https://login.testnet.fast-auth.com/");
    expect(config.audience).toBe("auth0.jwt.fast-auth.testnet");
    expect(config.jwksUri).toBe(
      "https://login.testnet.fast-auth.com/.well-known/jwks.json",
    );
    expect(config.sessionTtlSeconds).toBe(3600);
  });

  it("adds the Auth0 trailing slash to a custom issuer", () => {
    const config = loadServerAuthConfig({
      NEAR_AUTH_SESSION_SECRET: VALID_SECRET,
      NEAR_AUTH_ISSUER: "https://example.auth0.test",
    });

    expect(config.issuer).toBe("https://example.auth0.test/");
  });

  it("requires a strong session secret", () => {
    expect(() => loadServerAuthConfig({})).toThrow(
      /NEAR_AUTH_SESSION_SECRET/,
    );
    expect(() =>
      loadServerAuthConfig({ NEAR_AUTH_SESSION_SECRET: "too-short" }),
    ).toThrow(/NEAR_AUTH_SESSION_SECRET/);
  });

  it("rejects mainnet Auth0 domains for this testnet spike", () => {
    expect(() =>
      loadServerAuthConfig({
        NEAR_AUTH_SESSION_SECRET: VALID_SECRET,
        NEAR_AUTH_DOMAIN: "login.auth.near.org",
      }),
    ).toThrow(/testnet-only/);
  });

  it("bounds the session lifetime", () => {
    for (const ttl of ["0", "59", "86401", "not-a-number"]) {
      expect(() =>
        loadServerAuthConfig({
          NEAR_AUTH_SESSION_SECRET: VALID_SECRET,
          NEAR_AUTH_SESSION_TTL_SECONDS: ttl,
        }),
      ).toThrow(/NEAR_AUTH_SESSION_TTL_SECONDS/);
    }
  });
});
