import { describe, expect, it } from "vitest";
import { AuthError } from "../../src/server/auth/errors";
import {
  InMemoryNearAuthRateLimiter,
  loadNearAuthRateLimitOptions,
} from "../../src/server/auth/rate-limit";

function limiter(overrides: Partial<{
  windowMs: number;
  ipMax: number;
  subjectMax: number;
  maxConcurrent: number;
}> = {}) {
  return new InMemoryNearAuthRateLimiter({
    windowMs: 60_000,
    ipMax: 10,
    subjectMax: 10,
    maxConcurrent: 2,
    ...overrides,
  });
}

async function expectRateLimited(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).code).toBe("RATE_LIMITED");
    expect((error as AuthError).status).toBe(429);
    return;
  }
  throw new Error("Expected a rate-limit error");
}

describe("NEAR Auth rate limiting", () => {
  it("limits repeated attempts per IP", async () => {
    const subject = "auth0|rate-limited-subject";
    const limited = limiter({ ipMax: 1, maxConcurrent: 10 });

    await expect(limited.withIp("127.0.0.1", async () => "ok")).resolves.toBe(
      "ok",
    );
    await expectRateLimited(
      limited.withIp("127.0.0.1", async () => "blocked"),
    );

    await expect(
      limited.withIp("127.0.0.2", async () => "other-ip"),
    ).resolves.toBe("other-ip");
    await expect(
      limited.withSubject(subject, async () => "subject"),
    ).resolves.toBe("subject");
  });

  it("limits repeated attempts per subject", async () => {
    const limited = limiter({ subjectMax: 1, maxConcurrent: 10 });
    const subject = "auth0|subject";

    await expect(
      limited.withSubject(subject, async () => "ok"),
    ).resolves.toBe("ok");
    await expectRateLimited(
      limited.withSubject(subject, async () => "blocked"),
    );
    await expect(
      limited.withSubject("auth0|another-subject", async () => "ok"),
    ).resolves.toBe("ok");
  });

  it("limits concurrent work per key and releases the slot", async () => {
    const limited = limiter({
      ipMax: 10,
      maxConcurrent: 1,
    });
    let release!: () => void;
    const first = limited.withIp(
      "127.0.0.1",
      () => new Promise<string>((resolve) => {
        release = () => resolve("first");
      }),
    );

    await expectRateLimited(
      limited.withIp("127.0.0.1", async () => "second"),
    );

    release();
    await expect(first).resolves.toBe("first");
    await expect(
      limited.withIp("127.0.0.1", async () => "after-release"),
    ).resolves.toBe("after-release");
  });

  it("reads positive integer limits from the environment", () => {
    const options = loadNearAuthRateLimitOptions({
      NEAR_AUTH_RATE_LIMIT_WINDOW_SECONDS: "30",
      NEAR_AUTH_RATE_LIMIT_IP_MAX: "7",
      NEAR_AUTH_RATE_LIMIT_SUBJECT_MAX: "3",
      NEAR_AUTH_RATE_LIMIT_CONCURRENT_MAX: "2",
    });
    expect(options).toEqual({
      windowMs: 30_000,
      ipMax: 7,
      subjectMax: 3,
      maxConcurrent: 2,
    });

    for (const value of ["0", "-1", "1.5", "nope"]) {
      expect(() =>
        loadNearAuthRateLimitOptions({ NEAR_AUTH_RATE_LIMIT_IP_MAX: value }),
      ).toThrow(/NEAR_AUTH_RATE_LIMIT_IP_MAX/);
    }
  });
});
