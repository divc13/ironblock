import { afterEach, describe, expect, it } from "vitest";
import type { NearAuthSessionResponse } from "../../src/shared/auth/types";
import { loginApiPathForBase } from "../../src/client/auth/api-path";
import {
  createNearAuthSessionCache,
  isNearAuthSessionResponse,
} from "../../src/client/auth/session-cache";
import {
  assertMatchingTokenSubjects,
  readJwtSubject,
} from "../../src/client/auth/token-subject";

function session(
  overrides: Partial<NearAuthSessionResponse> = {},
): NearAuthSessionResponse {
  return {
    sessionToken: `session-token-${"x".repeat(48)}`,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    player: {
      id: "auth0_0123456789abcdef0123456789abcdef",
      displayName: "player",
      nearPublicKey: "ed25519:test",
      nearAccountId: "0123",
      nearAccountSource: "mpc",
      auth0SubjectHash: "0123456789abcdef",
    },
    authMode: "near",
    ...overrides,
  };
}

function jwtWithSubject(subject: string): string {
  const payload = Buffer.from(JSON.stringify({ sub: subject })).toString(
    "base64url",
  );
  return `header.${payload}.signature`;
}

const originalWindow = (globalThis as { window?: unknown }).window;

afterEach(() => {
  if (originalWindow === undefined) {
    delete (globalThis as { window?: unknown }).window;
  } else {
    (globalThis as { window?: unknown }).window = originalWindow;
  }
});

describe("login API path", () => {
  it("follows Vite's base path", () => {
    expect(loginApiPathForBase("/")).toBe("/api/auth");
    expect(loginApiPathForBase("/quest/")).toBe("/quest/api/auth");
    expect(loginApiPathForBase("quest")).toBe("/quest/api/auth");
    expect(loginApiPathForBase(undefined)).toBe("/api/auth");
  });
});

describe("Auth0 subject consistency check", () => {
  it("reads a JWT subject", () => {
    expect(readJwtSubject(jwtWithSubject("auth0|player"))).toBe(
      "auth0|player",
    );
    expect(readJwtSubject("not-a-jwt")).toBeUndefined();
  });

  it("accepts matching subjects and rejects mismatches without tokens", () => {
    expect(() =>
      assertMatchingTokenSubjects(
        "auth0|player",
        jwtWithSubject("auth0|player"),
      ),
    ).not.toThrow();

    expect(() =>
      assertMatchingTokenSubjects(
        "auth0|player",
        jwtWithSubject("auth0|other"),
      ),
    ).toThrow(/inconsistent identities/);

    expect(() =>
      assertMatchingTokenSubjects("auth0|player", "opaque-token"),
    ).toThrow(/unreadable access token/);
  });
});

describe("NearAuthSessionCache", () => {
  it("validates session responses", () => {
    expect(isNearAuthSessionResponse(session())).toBe(true);
    expect(isNearAuthSessionResponse({})).toBe(false);
    expect(
      isNearAuthSessionResponse(
        session({ expiresAt: "not-a-date" }),
      ),
    ).toBe(false);
  });

  it("keeps an in-memory fallback when sessionStorage is unavailable", () => {
    const storageKey = `test.${Math.random()}`;
    const cache = createNearAuthSessionCache(storageKey);
    const value = session();

    cache.save(value);
    expect(cache.read()).toEqual(value);

    cache.clear();
    expect(cache.read()).toBeUndefined();
  });

  it("uses the in-memory fallback when sessionStorage throws", () => {
    (globalThis as { window?: unknown }).window = {
      sessionStorage: {
        setItem() {
          throw new Error("storage disabled");
        },
        getItem() {
          throw new Error("storage disabled");
        },
        removeItem() {
          throw new Error("storage disabled");
        },
      },
    };
    const cache = createNearAuthSessionCache("test.fallback");
    const value = session();

    cache.save(value);
    expect(cache.read()).toEqual(value);
  });

  it("discards expired cached sessions", () => {
    const cache = createNearAuthSessionCache("test.expired");
    cache.save(session({ expiresAt: new Date(Date.now() - 1).toISOString() }));
    expect(cache.read()).toBeUndefined();
  });
});
