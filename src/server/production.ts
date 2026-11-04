import { createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { extname, resolve, sep } from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { createRpgServerTransport } from "@rpgjs/server/node";
import gameServer from "../server";
import { loadServerAuthConfig, type ServerAuthConfig } from "./auth/config";
import { createNearAuthHttpHandler } from "./auth/http";
import { defaultAuthStore, verifyActiveGameSession } from "./auth/service";
import { createEconomyHttpHandler } from "./economy/http";
import { startEconomyService } from "./economy/runtime";
import { createObservabilityNodeHandler } from "./observability/node-mount";
import { asObservabilitySource } from "./observability/source";
import { loadSettlementConfig } from "./settlement/config";
import { createEconomySettlementLedger } from "./settlement/economy-ledger";
import { createSettlementHttpHandler } from "./settlement/http";
import { NearApiNep245Chain } from "./settlement/near-chain";
import { InMemoryWithdrawalStore } from "./settlement/withdrawal-store";
import {
  InMemoryNearAuthRateLimiter,
  loadNearAuthRateLimitOptions,
} from "./auth/rate-limit";

export interface ProductionServerOptions {
  port?: number;
  host?: string;
  basePath?: string;
  clientDir?: string;
}

export interface ProductionServer {
  url: string;
  close(): Promise<void>;
}

/**
 * Small authoritative host for the built game:
 * - serves `dist/client`
 * - mounts the same `/api/auth/*` handler used by Vite
 * - mounts the economy, settlement and read-only observability APIs
 * - hosts the RPGJS WebSocket transport and game-session auth
 *
 * `vite preview` only serves assets and the HTTP routes; this host exists
 * because RPGJS's authoritative WebSocket transport is not started by preview.
 */
export async function startProductionServer(
  options: ProductionServerOptions = {},
): Promise<ProductionServer> {
  const config = loadServerAuthConfig();
  const clientDir = resolve(
    options.clientDir ??
      process.env.IRONBLOCK_CLIENT_DIR ??
      resolve(process.cwd(), "dist/client"),
  );
  const basePath = normalizeBase(
    options.basePath ?? process.env.IRONBLOCK_BASE_PATH ?? "/",
  );
  await assertBuiltClient(clientDir);

  const authHandler = createNearAuthHttpHandler({
    config,
    store: defaultAuthStore,
    rateLimiter: new InMemoryNearAuthRateLimiter(
      loadNearAuthRateLimitOptions(),
    ),
  });
  // Same auth config/store as `/api/auth/*`; the handler lazily shares the
  // economy service singleton with the game server.
  const economyHandler = createEconomyHttpHandler({ config });

  // Start the shared singleton before settlement binds its ledger. The game
  // transport reuses this same instance, so withdrawals debit live inventory.
  const economyService = await startEconomyService();

  // Settlement shares the verified session store so a login from /api/auth is
  // honoured here without re-verifying Auth0. Missing/invalid settlement env or
  // an absent treasury signer degrades to health-only; it never blocks auth or
  // game serving.
  let settlementHandler: ReturnType<typeof createSettlementHttpHandler>;
  try {
    const settlementConfig = loadSettlementConfig();
    settlementHandler = createSettlementHttpHandler({
      authConfig: config,
      settlementConfig,
      chain: new NearApiNep245Chain(settlementConfig),
      ledger: createEconomySettlementLedger(economyService),
      store: new InMemoryWithdrawalStore(),
      verifySession: (token) =>
        verifyActiveGameSession(token, config, defaultAuthStore),
    });
  } catch (error) {
    console.warn("[ironblock] settlement is disabled:", errorMessage(error));
    settlementHandler = createSettlementHttpHandler({ authConfig: config });
  }

  // Read-only `/api/market/*` + the built `/spectator` dashboard. Mounted after
  // auth/economy/settlement so those routes keep precedence.
  const observabilityHandler = createObservabilityNodeHandler({
    getService: async () => asObservabilitySource(await startEconomyService()),
  });

  const transport = createRpgServerTransport(gameServer as never, {});
  const wsServer = new WebSocketServer({ noServer: true });

  const httpServer = createHttpServer((req, res) => {
    setSecurityHeaders(res, config);
    const pathname = requestPathname(req);

    const healthPath = `${basePath === "/" ? "" : basePath.slice(0, -1)}/health`;
    if (
      (pathname === "/health" || pathname === healthPath) &&
      (req.method === "GET" || req.method === "HEAD")
    ) {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(
        req.method === "HEAD"
          ? undefined
          : JSON.stringify({ status: "ok", service: "ironblock" }),
      );
      return;
    }

    if (
      basePath !== "/" &&
      (pathname === "/" || pathname === basePath.slice(0, -1))
    ) {
      res.statusCode = 302;
      res.setHeader("location", basePath);
      res.end();
      return;
    }

    authHandler(req, res, () => {
      economyHandler(req, res, () => {
        settlementHandler(req, res, () => {
          observabilityHandler(req, res, () => {
            void serveStatic(req, res, clientDir, basePath).catch((error) => {
              console.warn(
                "[ironblock] static file failure:",
                errorMessage(error),
              );
              if (!res.headersSent) {
                res.statusCode = 500;
                res.end("Internal server error");
              } else if (!res.writableEnded) {
                res.end();
              }
            });
          });
        });
      });
    });
  });

  httpServer.on("upgrade", (request, socket, head) => {
    void transport
      .handleUpgrade(wsServer, request, socket, head)
      .then((handled) => {
        if (!handled) socket.destroy();
      })
      .catch((error) => {
        console.warn("[ironblock] WebSocket upgrade failed:", errorMessage(error));
        socket.destroy();
      });
  });

  const port = options.port ?? Number(process.env.PORT ?? 3000);
  const host = options.host ?? process.env.HOST ?? "0.0.0.0";

  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error) => {
      httpServer.off("listening", onListening);
      rejectListen(error);
    };
    const onListening = () => {
      httpServer.off("error", onError);
      resolveListen();
    };
    httpServer.once("error", onError);
    httpServer.once("listening", onListening);
    httpServer.listen(port, host);
  });

  const address = httpServer.address() as AddressInfo;
  const displayHost =
    host === "0.0.0.0" || host === "::" ? "localhost" : host;
  const url = `http://${displayHost}:${address.port}${basePath}`;

  return {
    url,
    async close() {
      for (const client of wsServer.clients) client.terminate();
      await new Promise<void>((resolveClose) => wsServer.close(() => resolveClose()));
      await new Promise<void>((resolveClose, rejectClose) => {
        httpServer.close((error) => (error ? rejectClose(error) : resolveClose()));
      });
    },
  };
}

function normalizeBase(raw: string): string {
  const value = `/${(raw || "/").replace(/^\/+|\/+$/g, "")}`;
  return value === "/" ? "/" : `${value}/`;
}

async function assertBuiltClient(clientDir: string): Promise<void> {
  try {
    await access(resolve(clientDir, "index.html"));
  } catch {
    throw new Error(
      `Built client not found at ${clientDir}. Run "npm run build" before "npm start".`,
    );
  }
}

function requestPathname(req: IncomingMessage): string {
  return new URL(req.url ?? "/", "http://localhost").pathname;
}

async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  clientDir: string,
  basePath: string,
): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    res.end("Method not allowed");
    return;
  }

  const pathname = requestPathname(req);
  if (!pathname.startsWith(basePath)) {
    res.statusCode = 404;
    res.end("Not found");
    return;
  }

  let relative: string;
  try {
    relative = decodeURIComponent(pathname.slice(basePath.length));
  } catch {
    res.statusCode = 400;
    res.end("Bad request");
    return;
  }

  const requested = relative || "index.html";
  let filePath = resolve(clientDir, requested);
  if (!isInside(clientDir, filePath)) {
    res.statusCode = 404;
    res.end("Not found");
    return;
  }

  let fileStat = await stat(filePath).catch(() => undefined);
  if (!fileStat || fileStat.isDirectory()) {
    // Only extensionless routes fall back to the SPA shell. A missing JS asset
    // must be a 404, not HTML with a JavaScript content type.
    if (extname(requested) !== "") {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }
    filePath = resolve(clientDir, "index.html");
    fileStat = await stat(filePath);
  }

  res.statusCode = 200;
  res.setHeader("content-type", contentType(filePath));
  res.setHeader(
    "cache-control",
    /\/assets\//.test(requested) || /\/map\//.test(requested)
      ? "public, max-age=31536000, immutable"
      : "no-cache",
  );
  res.setHeader("content-length", String(fileStat.size));

  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(filePath).pipe(res);
}

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${sep}`);
}

function contentType(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    case ".ttf":
      return "font/ttf";
    case ".tmx":
      return "application/xml; charset=utf-8";
    case ".tsx":
      return "application/xml; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function setSecurityHeaders(
  res: ServerResponse,
  config: ServerAuthConfig,
): void {
  const contentSecurityPolicy = [
    "default-src 'self'",
    // RPGJS/Pixi compiles shaders with `new Function` and instantiates its
    // WASM runtime in the browser, so this game engine needs both eval
    // allowances. The runtime also fetches its embedded module through a data
    // URL. This is the minimum CSP that lets the untouched RPGJS canvas boot.
    "script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    `connect-src 'self' data: blob: ${config.rpcUrl} https://${config.domain} ws: wss:`,
    `frame-src https://${config.domain}`,
    `form-action 'self' https://${config.domain}`,
    "worker-src 'self' blob:",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
  ].join("; ");

  res.setHeader("content-security-policy", contentSecurityPolicy);
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader(
    "permissions-policy",
    "camera=(), microphone=(), geolocation=()",
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
