import type { IncomingMessage, ServerResponse } from "node:http";
import type { GameSessionClaims } from "../auth/session";
import { verifyGameSessionToken } from "../auth/session";
import type { ServerAuthConfig } from "../auth/config";
import type { SettlementConfig } from "./config";
import { loadSettlementConfig, isValidNearAccountId } from "./config";
import type { Nep245Chain } from "./chain";
import { itemInfoOf } from "./chain";
import { SettlementError, toSettlementError } from "./errors";
import type { SettlementLedger } from "./ledger";
import { InMemorySettlementLedger } from "./ledger";
import { NearItemSettlement } from "./service";
import type { WithdrawalStore } from "./withdrawal-store";
import { InMemoryWithdrawalStore, recordToView } from "./withdrawal-store";
import type { LedgerSnapshot, SettlementHealth } from "../../shared/settlement/types";

type Next = (error?: unknown) => void;

export interface SettlementHttpOptions {
  settlementConfig?: SettlementConfig;
  chain?: Nep245Chain;
  ledger?: SettlementLedger;
  store?: WithdrawalStore;
  /** Shared auth store/config so `/api/auth` and `/api/settlement` agree. */
  authConfig?: ServerAuthConfig;
  verifySession?: (token: string) => Promise<GameSessionClaims>;
  withdrawalLimiter?: SettlementRateLimiter;
  readLimiter?: SettlementRateLimiter;
}

/** Very small fixed-window limiter; scope per session for writes. */
export interface SettlementRateLimiter {
  consume(key: string): void;
}

export class InMemoryFixedWindowRateLimiter implements SettlementRateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();
  constructor(
    readonly max: number,
    readonly windowMs: number,
  ) {}

  consume(key: string): void {
    const now = Date.now();
    const entry = this.windows.get(key);
    if (!entry || entry.resetAt <= now) {
      this.windows.set(key, { count: 1, resetAt: now + this.windowMs });
      return;
    }
    if (entry.count >= this.max) {
      throw new SettlementError(
        "RATE_LIMITED",
        429,
        `Too many settlement requests; window resets at ${entry.resetAt}`,
        "Too many withdrawals in a short time. Wait a minute and try again.",
      );
    }
    entry.count += 1;
  }
}

const MAX_BODY_BYTES = 4 * 1024;
const LIM_DEFAULTS = {
  withdrawWindowMs: 60_000,
  withdrawMax: 10,
  readWindowMs: 60_000,
  readMax: 120,
} as const;

/**
 * Settlement API:
 *
 *   POST /api/settlement/withdraw            withdraw items of the session's own ledger to the session's implicit account
 *   GET  /api/settlement/withdrawals/:id     status/proof of one withdrawal (own only)
 *   GET  /api/settlement/withdrawals         own withdrawals list
 *   GET  /api/settlement/onchain/:account    read-only NEP-245 balances/metadata
 *   GET  /api/settlement/health              config/signer/liveness (no secrets)
 *
 * Everything except /health requires a verified bearer game session. Unauth ->
 * 401, schema problems -> 400, method problems -> 405, unknown -> 404.
 */
export function createSettlementHttpHandler(
  options: SettlementHttpOptions = {},
): (req: IncomingMessage, res: ServerResponse, next: Next) => void {
  // Invalid or missing settlement env must not take down auth/game serving:
  // keep the handler mounted, report degraded health and answer withdrawal
  // routes with 503 until the host is configured.
  let settlementConfig: SettlementConfig | undefined;
  let configError: string | undefined;
  try {
    settlementConfig = options.settlementConfig ?? loadSettlementConfig();
  } catch (error) {
    configError = error instanceof Error ? error.message : String(error);
  }
  const settlement =
    settlementConfig && options.chain
      ? new NearItemSettlement(
          settlementConfig,
          options.chain,
          options.ledger ?? new InMemorySettlementLedger(),
          options.store ?? new InMemoryWithdrawalStore(),
        )
      : undefined;
  const withdrawLimiter =
    options.withdrawalLimiter ??
    new InMemoryFixedWindowRateLimiter(LIM_DEFAULTS.withdrawMax, LIM_DEFAULTS.withdrawWindowMs);
  const readLimiter =
    options.readLimiter ??
    new InMemoryFixedWindowRateLimiter(LIM_DEFAULTS.readMax, LIM_DEFAULTS.readWindowMs);

  return (req, res, next) => {
    void handle(
      req,
      res,
      next,
      { ...options, settlementConfig },
      settlement,
      withdrawLimiter,
      readLimiter,
      configError,
    );
  };
}

interface SettlementRuntime {
  settlement: NearItemSettlement;
  ledger: SettlementLedger;
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  next: Next,
  options: SettlementHttpOptions,
  settlement: NearItemSettlement | undefined,
  withdrawLimiter: SettlementRateLimiter,
  readLimiter: SettlementRateLimiter,
  configError?: string,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const route = normalizeRoute(url.pathname);

  if (!route) {
    if (isSettlementPath(url.pathname)) {
      sendJson(res, 404, { error: { code: "NOT_FOUND", message: "Settlement route not found" } });
    } else {
      next();
    }
    return;
  }

  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");

  try {
    if (route.kind === "/health" && req.method === "GET") {
      sendJson(res, 200, healthView(options, settlement, configError));
      return;
    }

    const session = await requireSession(req, options);

    readLimiter.consume(`session:${session.playerId}`);
    readLimiter.consume(`ip:${clientAddress(req)}`);

    if (route.kind === "/withdraw" && req.method === "POST") {
      if (!settlement) throw unavailable();
      withdrawLimiter.consume(`session:${session.playerId}`);
      withdrawLimiter.consume(`ip:${clientAddress(req)}`);
      const body = await readJsonBody(req);
      const outcome = await settlement.withdraw({
        session,
        requestId: expectString(body, "requestId"),
        tokenId: expectString(body, "tokenId"),
        amount: expectAmount(body),
        receiver: optionalReceiver(body, session),
      });
      sendJson(res, outcome.status, outcome.view);
      return;
    }

    if (route.kind === "/withdrawals" && req.method === "GET") {
      if (!settlement) throw unavailable();
      const id = route.param;
      if (id) {
        if (id === "all") {
          const records = await settlement.store.findByPlayer(session.playerId);
          sendJson(res, 200, {
            playerId: session.playerId,
            withdrawals: records.map(recordToView),
          });
          return;
        }
        const record = await settlement.store.get(id);
        if (!record || record.playerId !== session.playerId) {
          throw new SettlementError(
            "CONFLICT",
            404,
            `Withdrawal ${id} not found for this session`,
            "This withdrawal does not exist for your session.",
          );
        }
        sendJson(res, 200, await settlement.describe(record));
        return;
      }
      const limit = parseLimit(url.searchParams.get("limit"));
      const records = await settlement.store.findByPlayer(session.playerId, limit);
      sendJson(res, 200, {
        playerId: session.playerId,
        withdrawals: records.map(recordToView),
      });
      return;
    }

    if (route.kind === "/onchain" && req.method === "GET") {
      if (!settlement) throw unavailable();
      const accountId = route.param ? decodeURIComponent(route.param) : "";
      if (!accountId || !isValidNearAccountId(accountId)) {
        throw new SettlementError(
          "INVALID_REQUEST",
          400,
          "onchain/:account requires a valid NEAR account id",
          "Provide a valid NEAR account id.",
        );
      }
      sendJson(res, 200, await onchainView(settlement, accountId));
      return;
    }

    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }
    sendJson(res, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed" } });
  } catch (error) {
    const settlementError = toSettlementError(error);
    if (!(error instanceof SettlementError)) {
      console.warn("[settlement] unexpected failure:", settlementError.code);
    }
    sendJson(res, settlementError.status, {
      error: { code: settlementError.code, message: settlementError.publicMessage },
    });
  }
}

async function requireSession(
  req: IncomingMessage,
  options: SettlementHttpOptions,
): Promise<GameSessionClaims> {
  const token = readBearerToken(req);
  if (!token) {
    throw new SettlementError(
      "UNAUTHENTICATED",
      401,
      "Missing bearer game session",
      "Sign in with NEAR Auth first.",
    );
  }
  try {
    if (options.verifySession) return await options.verifySession(token);
    const authConfig = options.authConfig;
    if (!authConfig) {
      throw new SettlementError(
        "UNAVAILABLE",
        503,
        "No auth configuration is loaded",
        "Game sessions cannot be verified on this host.",
      );
    }
    return await verifyGameSessionToken(token, authConfig);
  } catch (error) {
    if (error instanceof SettlementError) throw error;
    throw new SettlementError(
      "UNAUTHENTICATED",
      401,
      "The supplied game session is invalid or expired",
      "Your session expired; sign in again.",
    );
  }
}

async function onchainView(
  settlement: NearItemSettlement,
  accountId: string,
): Promise<unknown> {
  const items = await settlement.chain.getItems();
  const tokenIds = items.map((item) => item.token_id);
  const balances = await settlement.chain.mtBatchBalanceOf(accountId, tokenIds);
  const view: Record<string, unknown> = {
    accountId,
    contractId: settlement.config.contractId,
    network: "testnet" as const,
    balances: Object.fromEntries(tokenIds.map((tokenId, index) => [tokenId, balances[index] ?? "0"])),
    items: items.map(itemInfoOf),
  };
  if (accountId === settlement.config.treasuryAccountId) {
    view.treasuryNearBalance = await settlement.chain.treasuryNearBalance();
  }
  return view;
}

function healthView(
  options: SettlementHttpOptions,
  settlement: NearItemSettlement | undefined,
  configError?: string,
): SettlementHealth {
  const config = settlement?.config ?? options.settlementConfig;
  let keyStatus: SettlementHealth["treasuryKey"] = "unavailable";
  let detail: string | undefined;
  if (settlement && "signerStatus" in settlement.chain) {
    const status = (settlement.chain as unknown as { signerStatus(): { available: boolean; source?: string; reason?: string } }).signerStatus();
    if (status.available) keyStatus = "available";
    else detail = status.reason;
  } else if (!settlement) {
    detail = configError
      ? `Settlement is not configured: ${configError}`
      : "Settlement is not configured on this host.";
  }
  return {
    status: config && keyStatus === "available" ? "ok" : "degraded",
    service: "settlement",
    network: "testnet",
    contractId: config?.contractId ?? "",
    treasuryAccountId: config?.treasuryAccountId ?? "",
    treasuryKey: keyStatus,
    ledger: options.ledger ? "connected" : "in-memory",
    detail,
  };
}

function unavailable(): SettlementError {
  return new SettlementError(
    "UNAVAILABLE",
    503,
    "Settlement is not configured on this host",
    "Withdrawals are unavailable on this server.",
  );
}

export function parseLimit(raw: string | null): number {
  if (!raw) return 50;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 200) return 50;
  return value;
}

function expectString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string") {
    throw new SettlementError(
      "INVALID_REQUEST",
      400,
      `Missing ${key}`,
      `The ${key} field is required.`,
    );
  }
  return value;
}

function expectAmount(body: Record<string, unknown>): number {
  const raw = body.amount;
  const value = typeof raw === "string" ? Number(raw.trim()) : raw;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  throw new SettlementError(
    "INVALID_REQUEST",
    400,
    "amount must be a positive integer",
    "Amount must be a whole number of items.",
  );
}

function optionalReceiver(
  body: Record<string, unknown>,
  session: GameSessionClaims,
): string | undefined {
  const receiver = body.receiver;
  if (receiver === undefined || receiver === null) return undefined;
  if (typeof receiver !== "string" || receiver !== session.nearAccountId) {
    throw new SettlementError("RECEIVER_MISMATCH", 400, "receiver must be the session's own implicit account");
  }
  return receiver;
}

function readBearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (!header || Array.isArray(header)) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim();
}

function clientAddress(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? "unknown";
}

function isSettlementPath(pathname: string): boolean {
  return pathname === "/api/settlement" || pathname.includes("/api/settlement/");
}

function normalizeRoute(
  pathname: string,
): { kind: "/health" | "/withdraw" | "/withdrawals" | "/onchain"; param?: string } | null {
  const marker = "/api/settlement";
  const markerIndex = pathname.indexOf(marker);
  const rest =
    markerIndex >= 0 ? pathname.slice(markerIndex + marker.length) || "/" : pathname;

  const trimmed = rest.replace(/\/+$/, "") || "/";
  if (trimmed === "/health") return { kind: "/health" };
  if (trimmed === "/withdraw") return { kind: "/withdraw" };
  if (trimmed === "/withdrawals") return { kind: "/withdrawals" };
  if (trimmed.startsWith("/withdrawals/")) {
    const param = trimmed.slice("/withdrawals/".length).split("/")[0];
    if (param) return { kind: "/withdrawals", param };
    return { kind: "/withdrawals" };
  }
  if (trimmed.startsWith("/onchain/")) {
    const param = trimmed.slice("/onchain/".length).split("/")[0];
    if (param) return { kind: "/onchain", param };
    return null;
  }
  return null;
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = String(req.headers["content-type"] ?? "");
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new SettlementError("INVALID_REQUEST", 415, "Content-Type must be application/json");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      throw new SettlementError("INVALID_REQUEST", 413, "Request body is too large");
    }
    chunks.push(buffer);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new SettlementError("INVALID_REQUEST", 400, "Body must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof SettlementError) throw error;
    throw new SettlementError("INVALID_REQUEST", 400, "Request body is not valid JSON");
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return;
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

/** Exposed for the integration agent: ledger snapshots for proof UIs. */
export async function ledgerSnapshot(
  settlement: NearItemSettlement,
  playerId: string,
): Promise<LedgerSnapshot> {
  return {
    playerId,
    balances: await settlement.ledger.snapshot(playerId),
  };
}
