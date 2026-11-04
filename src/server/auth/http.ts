import type { IncomingMessage, ServerResponse } from "node:http";
import { loadServerAuthConfig, type ServerAuthConfig } from "./config";
import { AuthError, toAuthError } from "./errors";
import {
  InMemoryNearAuthRateLimiter,
  loadNearAuthRateLimitOptions,
} from "./rate-limit";
import { verifyGameSessionToken } from "./session";
import {
  authenticateNearLogin,
  defaultAuthStore,
  describeGameSession,
  revokeGameSession,
  type AuthenticateNearLoginDeps,
} from "./service";
import { InMemoryAuthStore } from "./store";

type Next = (error?: unknown) => void;

export interface NearAuthHttpOptions {
  config?: ServerAuthConfig;
  store?: InMemoryAuthStore;
  /** Test seam for JWKS / MPC lookups. */
  authDeps?: Omit<AuthenticateNearLoginDeps, "store" | "withSubjectLimit">;
  /** Share a limiter between routes/tests; `false` disables it for a test. */
  rateLimiter?: InMemoryNearAuthRateLimiter | false;
}

const MAX_BODY_BYTES = 16 * 1024;

/**
 * Auth API for the login spike:
 *
 *   GET  /api/auth/health  configuration health check
 *   POST /api/auth/near    verify Auth0 JWT + MPC key, issue session
 *   GET  /api/auth/session validate a stored session for page reloads
 *   POST /api/auth/logout  revoke the supplied game session
 *
 * Mounted by `nearAuthApiPlugin()` in Vite dev/preview and by the production
 * Node host. The same store is used by RPGJS WebSocket authentication.
 */
export function createNearAuthHttpHandler(
  options: NearAuthHttpOptions = {},
): (req: IncomingMessage, res: ServerResponse, next: Next) => void {
  const store = options.store ?? defaultAuthStore;
  const limiter =
    options.rateLimiter === false
      ? undefined
      : options.rateLimiter ??
        new InMemoryNearAuthRateLimiter(loadNearAuthRateLimitOptions());

  return (req, res, next) => {
    void handleRequest(
      req,
      res,
      next,
      options.config,
      store,
      options.authDeps,
      limiter,
    );
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  next: Next,
  configured: ServerAuthConfig | undefined,
  store: InMemoryAuthStore,
  authDeps: NearAuthHttpOptions["authDeps"],
  limiter: InMemoryNearAuthRateLimiter | undefined,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const route = normalizeRoute(url.pathname);

  if (!route) {
    if (isAuthPath(url.pathname)) {
      sendJson(res, 404, {
        error: { code: "NOT_FOUND", message: "Auth route not found" },
      });
    } else {
      next();
    }
    return;
  }

  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");

  try {
    const config = configured ?? loadConfiguredAuth();

    if (route === "/health" && req.method === "GET") {
      sendJson(res, 200, {
        status: "ok",
        service: "near-auth",
        network: "testnet",
      });
      return;
    }

    if (route === "/near" && req.method === "POST") {
      const run = async () => {
        requireJson(req);
        const body = await readJsonBody(req);
        return authenticateNearLogin(
          {
            accessToken: readString(body, "accessToken"),
            nearPublicKey: readString(body, "nearPublicKey"),
          },
          config,
          {
            ...authDeps,
            store,
            withSubjectLimit: limiter
              ? (subject, task) => limiter.withSubject(subject, task)
              : undefined,
          },
        );
      };

      const result = limiter
        ? await limiter.withIp(clientAddress(req), run)
        : await run();
      sendJson(res, 200, result);
      return;
    }

    if (route === "/session" && req.method === "GET") {
      const token = readBearerToken(req);
      if (!token) {
        throw new AuthError("SESSION_INVALID", 401, "Missing game session");
      }
      const result = await describeGameSession(token, config, store);
      sendJson(res, 200, result);
      return;
    }

    if (route === "/logout" && req.method === "POST") {
      const token = readBearerToken(req);
      if (!token) {
        throw new AuthError("SESSION_INVALID", 401, "Missing game session");
      }
      await revokeGameSession(token, config, store);
      res.statusCode = 204;
      res.end();
      return;
    }

    if (req.method !== "OPTIONS") {
      sendJson(res, 405, {
        error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed" },
      });
      return;
    }

    next();
  } catch (error) {
    const authError = toAuthError(error);
    if (!(error instanceof AuthError)) {
      // Never log the request body, JWT, access token or key material.
      console.warn("[near-auth] unexpected auth failure:", authError.message);
    }
    sendJson(res, authError.status, {
      error: { code: authError.code, message: authError.message },
    });
  }
}

function loadConfiguredAuth(): ServerAuthConfig {
  try {
    return loadServerAuthConfig();
  } catch {
    // Do not echo environment values or secret-length details to the browser.
    throw new AuthError(
      "CONFIGURATION",
      500,
      "NEAR Auth is not configured on this server",
    );
  }
}

function isAuthPath(pathname: string): boolean {
  return pathname === "/api/auth" || pathname.includes("/api/auth/");
}

function normalizeRoute(
  pathname: string,
): "/health" | "/near" | "/session" | "/logout" | null {
  const marker = "/api/auth";
  const markerIndex = pathname.indexOf(marker);
  const routePath =
    markerIndex >= 0
      ? pathname.slice(markerIndex + marker.length) || "/"
      : pathname;

  if (routePath === "/health") return "/health";
  if (routePath === "/near") return "/near";
  if (routePath === "/session") return "/session";
  if (routePath === "/logout") return "/logout";
  return null;
}

function requireJson(req: IncomingMessage): void {
  const contentType = String(req.headers["content-type"] ?? "");
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new AuthError(
      "INVALID_REQUEST",
      415,
      "Content-Type must be application/json",
    );
  }
}

function readBearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (!header || Array.isArray(header)) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim();
}

function clientAddress(req: IncomingMessage): string {
  // Do not trust X-Forwarded-For by default. A reverse proxy must be configured
  // to pass the real client address or apply its own limiter.
  return req.socket.remoteAddress ?? "unknown";
}

function readString(body: unknown, key: string): string {
  if (
    typeof body !== "object" ||
    body === null ||
    !(key in body) ||
    typeof (body as Record<string, unknown>)[key] !== "string"
  ) {
    throw new AuthError("INVALID_REQUEST", 400, `Missing ${key}`);
  }
  return (body as Record<string, string>)[key];
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      throw new AuthError("INVALID_REQUEST", 413, "Request body is too large");
    }
    chunks.push(buffer);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new AuthError("INVALID_REQUEST", 400, "Request body is not valid JSON");
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return;
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

/** Re-exported so the Vite plugin can validate a session before mounting. */
export { verifyGameSessionToken };
