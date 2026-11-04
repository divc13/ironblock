import type { IncomingMessage, ServerResponse } from "node:http";
import { loadServerAuthConfig, type ServerAuthConfig } from "./config";
import { AuthError, toAuthError } from "./errors";
import { verifyGameSessionToken } from "./session";
import {
  authenticateNearLogin,
  defaultAuthStore,
  describeGameSession,
  type AuthenticateNearLoginDeps,
} from "./service";
import { InMemoryAuthStore } from "./store";

type Next = (error?: unknown) => void;

export interface NearAuthHttpOptions {
  config?: ServerAuthConfig;
  store?: InMemoryAuthStore;
  /** Test seam for JWKS / MPC lookups. */
  authDeps?: Omit<AuthenticateNearLoginDeps, "store">;
}

const MAX_BODY_BYTES = 16 * 1024;

/**
 * Dev-server API for the login spike:
 *
 *   POST /api/auth/near     verify Auth0 JWT + MPC-derived NEAR key, issue session
 *   GET  /api/auth/session  validate a stored game session for page reloads
 *
 * Mounted by `nearAuthApiPlugin()` in Vite. The production game server will
 * need the same two routes on its own HTTP host.
 */
export function createNearAuthHttpHandler(
  options: NearAuthHttpOptions = {},
): (req: IncomingMessage, res: ServerResponse, next: Next) => void {
  const store = options.store ?? defaultAuthStore;

  return (req, res, next) => {
    void handleRequest(req, res, next, options.config, store, options.authDeps);
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  next: Next,
  configured: ServerAuthConfig | undefined,
  store: InMemoryAuthStore,
  authDeps: NearAuthHttpOptions["authDeps"],
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const route = normalizeRoute(url.pathname);

  if (!route) {
    next();
    return;
  }

  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");

  try {
    const config = configured ?? loadConfiguredAuth();

    if (route === "/near" && req.method === "POST") {
      requireJson(req);
      const body = await readJsonBody(req);
      const result = await authenticateNearLogin(
        {
          accessToken: readString(body, "accessToken"),
          nearPublicKey: readString(body, "nearPublicKey"),
        },
        config,
        { ...authDeps, store },
      );
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

    if ((route === "/near" || route === "/session") && req.method !== "OPTIONS") {
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

function normalizeRoute(pathname: string): "/near" | "/session" | null {
  const path = pathname.replace(/^\/api\/auth/, "") || "/";
  if (path === "/near") return "/near";
  if (path === "/session") return "/session";
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
