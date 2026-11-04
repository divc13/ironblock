import { AuthError } from "./errors";

/**
 * Small process-local limiter for the login endpoint and its MPC view call.
 *
 * This is intentionally not distributed: it protects a single hackathon host
 * from accidental retry storms and one-subject abuse. Deployments with more
 * than one process need a shared limiter.
 */
export interface NearAuthRateLimitOptions {
  windowMs: number;
  ipMax: number;
  subjectMax: number;
  maxConcurrent: number;
}

interface WindowEntry {
  count: number;
  resetAt: number;
}

const DEFAULTS = {
  windowMs: 60_000,
  ipMax: 20,
  subjectMax: 8,
  maxConcurrent: 4,
} as const;

export function loadNearAuthRateLimitOptions(
  env: Record<string, string | undefined> = process.env,
): NearAuthRateLimitOptions {
  const windowSeconds = positiveInteger(
    env.NEAR_AUTH_RATE_LIMIT_WINDOW_SECONDS,
    60,
    "NEAR_AUTH_RATE_LIMIT_WINDOW_SECONDS",
  );
  return {
    windowMs: windowSeconds * 1000,
    ipMax: positiveInteger(
      env.NEAR_AUTH_RATE_LIMIT_IP_MAX,
      DEFAULTS.ipMax,
      "NEAR_AUTH_RATE_LIMIT_IP_MAX",
    ),
    subjectMax: positiveInteger(
      env.NEAR_AUTH_RATE_LIMIT_SUBJECT_MAX,
      DEFAULTS.subjectMax,
      "NEAR_AUTH_RATE_LIMIT_SUBJECT_MAX",
    ),
    maxConcurrent: positiveInteger(
      env.NEAR_AUTH_RATE_LIMIT_CONCURRENT_MAX,
      DEFAULTS.maxConcurrent,
      "NEAR_AUTH_RATE_LIMIT_CONCURRENT_MAX",
    ),
  };
}

export class InMemoryNearAuthRateLimiter {
  private readonly windows = new Map<string, WindowEntry>();
  private readonly active = new Map<string, number>();
  private operations = 0;

  constructor(readonly options: NearAuthRateLimitOptions) {}

  withIp<T>(ip: string, task: () => Promise<T>): Promise<T> {
    return this.run("ip", ip || "unknown", this.options.ipMax, task);
  }

  withSubject<T>(subject: string, task: () => Promise<T>): Promise<T> {
    return this.run(
      "subject",
      subject || "unknown",
      this.options.subjectMax,
      task,
    );
  }

  private async run<T>(
    scope: "ip" | "subject",
    rawKey: string,
    requestMax: number,
    task: () => Promise<T>,
  ): Promise<T> {
    const key = `${scope}:${rawKey}`;
    this.consume(key, requestMax);

    const active = (this.active.get(key) ?? 0) + 1;
    if (active > this.options.maxConcurrent) {
      throw new AuthError(
        "RATE_LIMITED",
        429,
        "Too many concurrent login attempts. Please wait and try again.",
      );
    }
    this.active.set(key, active);

    try {
      return await task();
    } finally {
      const remaining = (this.active.get(key) ?? 1) - 1;
      if (remaining <= 0) this.active.delete(key);
      else this.active.set(key, remaining);
    }
  }

  private consume(key: string, max: number): void {
    const now = Date.now();
    this.operations += 1;
    if (this.operations % 1_000 === 0) this.prune(now);

    const entry = this.windows.get(key);
    if (!entry || entry.resetAt <= now) {
      this.windows.set(key, { count: 1, resetAt: now + this.options.windowMs });
      return;
    }

    if (entry.count >= max) {
      throw new AuthError(
        "RATE_LIMITED",
        429,
        "Too many login attempts. Please wait and try again.",
      );
    }
    entry.count += 1;
  }

  private prune(now: number): void {
    for (const [key, entry] of this.windows) {
      if (entry.resetAt <= now) this.windows.delete(key);
    }
  }
}

function positiveInteger(
  raw: string | undefined,
  fallback: number,
  name: string,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}
