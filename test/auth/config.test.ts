import { describe, expect, it } from "vitest";
import {
  loadServerAuthConfig,
  validateClientServerAuthConsistency,
} from "../../src/server/auth/config";

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

  it("accepts a matching custom domain and issuer", () => {
    const config = loadServerAuthConfig({
      NEAR_AUTH_SESSION_SECRET: VALID_SECRET,
      NEAR_AUTH_DOMAIN: "example.auth0.test",
      NEAR_AUTH_ISSUER: "https://example.auth0.test/",
      NEAR_AUTH_JWKS_URL: "https://example.auth0.test/.well-known/jwks.json",
    });

    expect(config.domain).toBe("example.auth0.test");
    expect(config.issuer).toBe("https://example.auth0.test/");
  });

  it("adds the Auth0 trailing slash to a matching issuer", () => {
    const config = loadServerAuthConfig({
      NEAR_AUTH_SESSION_SECRET: VALID_SECRET,
      NEAR_AUTH_DOMAIN: "example.auth0.test",
      NEAR_AUTH_ISSUER: "https://example.auth0.test",
      NEAR_AUTH_JWKS_URL: "https://example.auth0.test/.well-known/jwks.json",
    });

    expect(config.issuer).toBe("https://example.auth0.test/");
  });

  it("rejects an issuer that does not match the Auth0 domain", () => {
    expect(() =>
      loadServerAuthConfig({
        NEAR_AUTH_SESSION_SECRET: VALID_SECRET,
        NEAR_AUTH_DOMAIN: "example.auth0.test",
        NEAR_AUTH_ISSUER: "https://other.auth0.test/",
      }),
    ).toThrow(/NEAR_AUTH_ISSUER/);
  });

  it("rejects a JWKS host that differs from the Auth0 domain", () => {
    expect(() =>
      loadServerAuthConfig({
        NEAR_AUTH_SESSION_SECRET: VALID_SECRET,
        NEAR_AUTH_JWKS_URL: "https://example.com/jwks.json",
      }),
    ).toThrow(/NEAR_AUTH_JWKS_URL/);
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

describe("validateClientServerAuthConsistency", () => {
  const config = loadServerAuthConfig({
    NEAR_AUTH_SESSION_SECRET: VALID_SECRET,
  });

  it("accepts matching public and server values", () => {
    expect(() =>
      validateClientServerAuthConsistency(config, {
        VITE_NEAR_AUTH_NETWORK: "testnet",
        VITE_NEAR_AUTH_DOMAIN: config.domain,
        VITE_NEAR_AUTH_AUDIENCE: config.audience,
        VITE_NEAR_AUTH_FAST_AUTH_CONTRACT_ID: config.fastAuthContractId,
        VITE_NEAR_AUTH_MPC_CONTRACT_ID: config.mpcContractId,
      }),
    ).not.toThrow();
  });

  it("rejects an audience mismatch between client and server", () => {
    expect(() =>
      validateClientServerAuthConsistency(config, {
        VITE_NEAR_AUTH_AUDIENCE: "wrong-audience",
      }),
    ).toThrow(/VITE_NEAR_AUTH_AUDIENCE/);
  });

  it("rejects a contract id mismatch between client and server", () => {
    expect(() =>
      validateClientServerAuthConsistency(config, {
        VITE_NEAR_AUTH_MPC_CONTRACT_ID: "v2.signer.testnet",
      }),
    ).toThrow(/VITE_NEAR_AUTH_MPC_CONTRACT_ID/);
  });

  it("rejects a non-testnet client network", () => {
    expect(() =>
      validateClientServerAuthConsistency(config, {
        VITE_NEAR_AUTH_NETWORK: "mainnet",
      }),
    ).toThrow(/VITE_NEAR_AUTH_NETWORK/);
  });
});
