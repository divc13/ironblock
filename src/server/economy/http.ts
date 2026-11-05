import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  CraftActionData,
  EconomyActionError,
  EconomyWorldState,
  GatherActionData,
  InvestActionData,
  MerchantRuntimeState,
  PlayerRuntimeState,
  SequencedMarketEvent,
  TradeActionData,
} from "../../shared/economy";
import type {
  EconomyCraftResponse,
  EconomyEatResponse,
  EconomyEventsResponse,
  EconomyFastForwardResponse,
  EconomyGatherResponse,
  EconomyInvestResponse,
  EconomyOrderBoardEntryResponse,
  EconomyRepairResponse,
  EconomySnapshotResponse,
  EconomyTradeResponse,
} from "../../shared/economy/api";
import type { EconomyConfig, ItemId, Quote, TradeSide } from "../../shared/types";
import { loadServerAuthConfig, type ServerAuthConfig } from "../auth/config";
import { AuthError } from "../auth/errors";
import { defaultAuthStore, verifyActiveGameSession } from "../auth/service";
import { InMemoryAuthStore } from "../auth/store";
import { startBotPlayback } from "./bot-playback";
import { getEconomyServiceOrNull, startEconomyService } from "./runtime";
import type { EconomyService } from "./service";

type Next = (error?: unknown) => void;

export interface EconomyRateLimitOptions {
  windowMs?: number;
  maxRequests?: number;
}

/** Small process-local limiter. A real deployment needs a shared limiter. */
export class InMemoryEconomyRateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  private readonly windowMs: number;
  private readonly maxRequests: number;
  private lastSweep = 0;

  constructor(options: EconomyRateLimitOptions = {}) {
    this.windowMs = Math.max(1_000, options.windowMs ?? 60_000);
    this.maxRequests = Math.max(1, options.maxRequests ?? 240);
  }

  take(key: string, now = Date.now()): boolean {
    if (now - this.lastSweep > this.windowMs) {
      for (const [candidate, entry] of this.hits) {
        if (entry.resetAt <= now) this.hits.delete(candidate);
      }
      this.lastSweep = now;
    }

    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    if (entry.count >= this.maxRequests) return false;
    entry.count += 1;
    return true;
  }
}

export interface EconomyHttpOptions {
  config?: ServerAuthConfig;
  store?: InMemoryAuthStore;
  /** Test seam: keep using this service instead of the process singleton. */
  service?: EconomyService;
  /** Share a limiter between routes/tests; `false` disables it. */
  rateLimiter?: InMemoryEconomyRateLimiter | false;
}

const MAX_BODY_BYTES = 16 * 1024;
const MAX_ID_LENGTH = 64;
const MAX_QUANTITY = 10_000;
const ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const ROUTE_MARKER = "/api/economy";
const SNAPSHOT_EVENT_LIMIT = 40;

/**
 * Authenticated economy API:
 *
 *   GET  /api/economy/snapshot        world + authenticated player view
 *   GET  /api/economy/quote           authoritative trade quote
 *   POST /api/economy/trade           buy/sell through the service
 *   POST /api/economy/gather          gather a configured resource
 *   POST /api/economy/craft           run a configured recipe
 *   POST /api/economy/invest          reopen a bankrupt merchant
 *   POST /api/economy/repair          repair the equipped tool
 *   POST /api/economy/eat             consume food for stamina
 *   POST /api/economy/fast-forward    authenticated demo simulation
 *   GET  /api/economy/events          event stream since a sequence
 *   GET  /api/economy/orders          open order board mapped to world entries
 *   GET  /api/economy/recap           derived session recap
 *
 * Player identity always comes from the verified NEAR Auth game session.
 * Request bodies never select the player id.
 */
export function createEconomyHttpHandler(
  options: EconomyHttpOptions = {},
): (req: IncomingMessage, res: ServerResponse, next: Next) => void {
  const limiter =
    options.rateLimiter === false
      ? undefined
      : options.rateLimiter ?? new InMemoryEconomyRateLimiter();

  return (req, res, next) => {
    void handleRequest(req, res, next, options, limiter);
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  next: Next,
  options: EconomyHttpOptions,
  limiter: InMemoryEconomyRateLimiter | undefined,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const route = normalizeRoute(url.pathname);

  if (!route) {
    if (isEconomyPath(url.pathname)) {
      sendJson(res, 404, {
        error: { code: "NOT_FOUND", message: "Economy route not found" },
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
    const config = options.config ?? loadConfiguredAuth();
    const token = readBearerToken(req);
    if (!token) {
      throw new EconomyHttpError(
        401,
        "UNAUTHORIZED",
        "Sign in with NEAR Auth to use the market economy",
      );
    }

    // The player id comes from the verified HMAC session, never the body.
    const claims = await verifyActiveGameSession(
      token,
      config,
      options.store ?? defaultAuthStore,
    );

    if (limiter && !limiter.take(claims.playerId)) {
      throw new EconomyHttpError(
        429,
        "RATE_LIMITED",
        "Too many market requests. Wait a moment and try again.",
      );
    }

    const service = options.service ?? (await ensureService());
    // The WebSocket hook also ensures the player. Repeating it here makes the
    // HTTP API usable before the socket connects and keeps ids authoritative.
    const ensured = await service.ensurePlayer(claims.playerId, claims.displayName);
    if (!ensured.success) {
      throw engineError(ensured.error);
    }

    const playerId = claims.playerId;

    if (route === "/snapshot" && req.method === "GET") {
      sendJson(res, 200, buildSnapshot(service, playerId));
      return;
    }

    if (route === "/quote" && req.method === "GET") {
      sendJson(res, 200, buildQuote(service, playerId, url));
      return;
    }

    if (route === "/trade" && req.method === "POST") {
      requireJson(req);
      const body = await readJsonBody(req);
      sendJson(res, 200, await trade(service, playerId, body));
      return;
    }

    if (route === "/gather" && req.method === "POST") {
      requireJson(req);
      const body = await readJsonBody(req);
      sendJson(res, 200, await gather(service, playerId, body));
      return;
    }

    if (route === "/craft" && req.method === "POST") {
      requireJson(req);
      const body = await readJsonBody(req);
      sendJson(res, 200, await craft(service, playerId, body));
      return;
    }

    if (route === "/invest" && req.method === "POST") {
      requireJson(req);
      const body = await readJsonBody(req);
      sendJson(res, 200, await invest(service, playerId, body));
      return;
    }

    if (route === "/repair" && req.method === "POST") {
      requireJson(req);
      const body = await readJsonBody(req);
      sendJson(res, 200, await repair(service, playerId, body));
      return;
    }

    if (route === "/eat" && req.method === "POST") {
      requireJson(req);
      const body = await readJsonBody(req);
      sendJson(res, 200, await eat(service, playerId, body));
      return;
    }

    if (route === "/fast-forward" && req.method === "POST") {
      requireJson(req);
      const body = await readJsonBody(req);
      sendJson(res, 200, await fastForward(service, body));
      return;
    }

    if (route === "/events" && req.method === "GET") {
      sendJson(res, 200, buildEvents(service, url));
      return;
    }

    if (route === "/orders" && req.method === "GET") {
      sendJson(res, 200, buildOrders(service));
      return;
    }

    if (route === "/recap" && req.method === "GET") {
      sendJson(res, 200, buildRecap(service));
      return;
    }

    sendJson(res, 405, {
      error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed" },
    });
  } catch (error) {
    if (error instanceof EconomyHttpError) {
      sendJson(res, error.status, {
        error: { code: error.code, message: error.message },
      });
      return;
    }

    if (error instanceof AuthError) {
      const unauthorized = error.status === 401;
      sendJson(res, error.status, {
        error: {
          code: unauthorized ? "UNAUTHORIZED" : error.code,
          message: unauthorized
            ? "The NEAR Auth session is invalid or expired. Sign in again."
            : error.message,
        },
      });
      return;
    }

    // Unknown failures must not be reported as auth errors; keep the client
    // message generic and log only the message (never bodies or tokens).
    console.warn(
      "[economy] request failed:",
      error instanceof Error ? error.message : "unknown error",
    );
    sendJson(res, 500, {
      error: {
        code: "INTERNAL",
        message: "The market server hit an unexpected error.",
      },
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Route implementations                                                       */
/* -------------------------------------------------------------------------- */

async function ensureService(): Promise<EconomyService> {
  return getEconomyServiceOrNull() ?? startEconomyService();
}

function buildSnapshot(
  service: EconomyService,
  playerId: string,
): EconomySnapshotResponse {
  const state = service.snapshot();
  const config = service.config;
  const events = recentEvents(service);
  const ownPlayer = state.players[playerId] ?? null;
  // Authenticated callers only receive their own player entry. Other players'
  // (and bots') inventories/cash stay server-side; merchants, resources,
  // clock/seed and public events are still included.
  const publicState: EconomyWorldState = {
    ...state,
    players: ownPlayer ? { [playerId]: ownPlayer } : {},
  };
  return {
    state: publicState,
    player: ownPlayer,
    totalPlayerCash: Object.values(state.players).reduce(
      (sum, player) => sum + player.cash,
      0,
    ),
    merchants: merchantsInStallOrder(config, state.merchants),
    events,
    sequence: state.sequence,
    firstRetainedSequence: service.engine.firstRetainedSequence,
    configHash: state.configHash,
    configVersion: state.configVersion,
  };
}

function buildQuote(
  service: EconomyService,
  playerId: string,
  url: URL,
): Quote {
  const merchantId = readQueryId(url, "merchantId");
  const itemId = readQueryId(url, "itemId");
  const side = readSide(url.searchParams.get("side"));
  const quantity = readQuantity(url.searchParams.get("quantity"));
  const quote = service.preview(playerId, merchantId, itemId, side, quantity);
  if (!quote) {
    throw new EconomyHttpError(
      400,
      "INVALID_QUOTE",
      "Unknown merchant, item, player or trade side",
    );
  }
  return quote;
}

async function trade(
  service: EconomyService,
  playerId: string,
  body: unknown,
): Promise<EconomyTradeResponse> {
  const merchantId = readBodyId(body, "merchantId");
  const itemId = readBodyId(body, "itemId");
  const side = readSide(readBodyValue(body, "side"));
  const quantity = readQuantity(readBodyValue(body, "quantity"));

  const result =
    side === "buy"
      ? await service.buy(playerId, merchantId, itemId, quantity)
      : await service.sell(playerId, merchantId, itemId, quantity);
  if (!result.success || !result.data) throw engineError(result.error);

  const data = result.data as TradeActionData;
  const itemName = service.config.items[itemId]?.displayName ?? itemId;
  const money = formatMoney(service.config, data.total);
  const partial = data.partial
    ? ` (partial fill of ${data.requested} requested)`
    : "";
  const message =
    side === "buy"
      ? `Bought ${data.filled} ${itemName} for ${money}${partial}.`
      : `Sold ${data.filled} ${itemName} for ${money}${partial}.`;

  return {
    ok: true,
    message,
    quote: data.quote,
    fillQuantity: data.filled,
    total: data.total,
    events: result.events,
    sequence: result.sequence,
  };
}

async function gather(
  service: EconomyService,
  playerId: string,
  body: unknown,
): Promise<EconomyGatherResponse> {
  const resourceId = readBodyId(body, "resourceId");
  const resource = service.config.resources.nodes[resourceId];
  if (!resource) {
    throw new EconomyHttpError(
      400,
      "unknown_resource",
      `Unknown resource "${resourceId}"`,
    );
  }

  const result = await service.gather(playerId, resourceId);
  if (!result.success || !result.data) throw engineError(result.error);
  const data = result.data as GatherActionData;
  const player = playerState(service, playerId);
  const itemName = service.config.items[data.itemId]?.displayName ?? data.itemId;

  return {
    ok: true,
    message: `Gathered ${data.quantity} ${itemName} for ${data.staminaCost} stamina.`,
    itemId: data.itemId,
    quantity: data.quantity,
    staminaSpent: data.staminaCost,
    stamina: player?.stamina ?? 0,
    durability: data.toolDurability,
    remainingNodes: data.remainingNodes,
  };
}

async function craft(
  service: EconomyService,
  playerId: string,
  body: unknown,
): Promise<EconomyCraftResponse> {
  const recipeId = readBodyId(body, "recipeId");
  const quantityValue = readBodyValue(body, "quantity");
  const quantity =
    quantityValue === undefined ? 1 : readQuantity(quantityValue);

  const result = await service.craft(playerId, recipeId, quantity);
  if (!result.success || !result.data) throw engineError(result.error);
  const data = result.data as CraftActionData;
  const outputs = Object.entries(data.outputs)
    .map(([itemId, amount]) => {
      const name = service.config.items[itemId]?.displayName ?? itemId;
      return `${amount}× ${name}`;
    })
    .join(", ");

  return {
    ok: true,
    message: `Crafted ${outputs} for ${data.staminaCost} stamina.`,
    recipeId,
    outputs: data.outputs,
    staminaSpent: data.staminaCost,
  };
}

async function invest(
  service: EconomyService,
  playerId: string,
  body: unknown,
): Promise<EconomyInvestResponse> {
  const merchantId = readBodyId(body, "merchantId");
  const state = service.snapshot();
  const merchant = state.merchants[merchantId];
  if (!merchant) {
    throw new EconomyHttpError(
      400,
      "unknown_merchant",
      `Unknown merchant "${merchantId}"`,
    );
  }

  const amountValue = readBodyValue(body, "amount");
  const required = Math.max(
    0,
    Math.ceil(merchant.reserve * 2 - merchant.cash),
  );
  const amount =
    amountValue === undefined ? required : readPositiveAmount(amountValue);
  if (amount <= 0) {
    throw new EconomyHttpError(
      400,
      "merchant_not_bankrupt",
      `${merchant.displayName} is already trading`,
    );
  }

  const result = await service.invest(playerId, merchantId, amount);
  if (!result.success || !result.data) throw engineError(result.error);
  const data = result.data as InvestActionData;
  const after = service.snapshot().merchants[merchantId];

  return {
    ok: true,
    message: `${merchant.displayName} reopened with ${formatMoney(
      service.config,
      data.investment.amount,
    )}.`,
    merchantId,
    amount: data.investment.amount,
    merchantCash: after?.cash ?? merchant.cash,
    reopened: Boolean(after?.open) && !after?.bankrupt,
  };
}

async function repair(
  service: EconomyService,
  playerId: string,
  body: unknown,
): Promise<EconomyRepairResponse> {
  const player = playerState(service, playerId);
  const requested = optionalBodyId(body, "toolItemId");
  if (requested && player?.equippedTool && requested !== player.equippedTool) {
    throw new EconomyHttpError(
      400,
      "tool_not_equipped",
      "Only the equipped tool can be repaired",
    );
  }

  const result = await service.repair(playerId);
  if (!result.success || !result.data) throw engineError(result.error);
  const data = result.data as {
    itemId: ItemId;
    restored: number;
    cost: number;
  };
  const item = service.config.items[data.itemId];
  const after = playerState(service, playerId);

  return {
    ok: true,
    message: `${item?.displayName ?? data.itemId} repaired for ${formatMoney(
      service.config,
      data.cost,
    )}.`,
    toolItemId: data.itemId,
    cost: data.cost,
    durability:
      after?.toolDurability?.[data.itemId] ??
      item?.tool?.maxDurability ??
      null,
  };
}

async function eat(
  service: EconomyService,
  playerId: string,
  body: unknown,
): Promise<EconomyEatResponse> {
  const itemId = readBodyId(body, "itemId");
  const result = await service.eat(playerId, itemId);
  if (!result.success || !result.data) throw engineError(result.error);
  const data = result.data as { itemId: ItemId; restored: number };
  const item = service.config.items[data.itemId];

  return {
    ok: true,
    message: `Ate ${item?.displayName ?? data.itemId} · stamina +${data.restored}`,
    itemId: data.itemId,
    staminaRestored: data.restored,
  };
}

async function fastForward(
  service: EconomyService,
  body: unknown,
): Promise<EconomyFastForwardResponse> {
  const daysValue = readBodyValue(body, "days");
  const days =
    daysValue === undefined
      ? service.config.fastForward.days
      : readDays(daysValue, service.config);
  const result = await service.fastForward(days);
  if (!result.success) throw engineError(result.error);
  // Presentation only: walk the visible server-authoritative bots across the
  // same accelerated window the initiating client is revealing. A new run
  // cancels any previous playback inside startBotPlayback.
  startBotPlayback(result.events, {
    fromTime: result.fromTime,
    toTime: result.toTime,
  });
  return result;
}

function buildEvents(
  service: EconomyService,
  url: URL,
): EconomyEventsResponse {
  const raw = url.searchParams.get("since") ?? "0";
  if (!/^\d+$/.test(raw)) {
    throw new EconomyHttpError(
      400,
      "invalid_since",
      "since must be a non-negative event sequence",
    );
  }
  const since = Number(raw);
  const events = service.eventsSince(since);
  return {
    events,
    sequence: service.engine.sequence,
    firstRetainedSequence: service.engine.firstRetainedSequence,
  };
}

function buildOrders(service: EconomyService): EconomyOrderBoardEntryResponse[] {
  const state = service.snapshot();
  const config = service.config;
  return state.orders
    .filter((order) => order.status === "open" && order.remaining > 0)
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
    .map((order) => ({
      id: order.id,
      side: "buy" as const,
      merchantId: order.issuer,
      merchantName: order.issuer,
      itemId: order.itemId,
      itemName: config.items[order.itemId]?.displayName ?? order.itemId,
      quantity: order.remaining,
      unitPrice: order.unitReward,
    }));
}

function buildRecap(service: EconomyService) {
  const state = service.snapshot();
  const config = service.config;
  const events = service.eventsSince(0);
  const spectators = service.spectatorSnapshot();
  const merchants = Object.values(state.merchants);
  const total = merchants.length;
  const open = merchants.filter(
    (merchant) => merchant.open && !merchant.bankrupt,
  ).length;
  const health = townHealth(open, total);

  const bankruptcyNames = unique(
    events
      .filter((event) => event.type === "merchant.bankrupt")
      .map((event) => event.actor.displayName ?? event.actor.id),
  );
  if (bankruptcyNames.length === 0) {
    for (const merchant of merchants) {
      if (merchant.bankruptAt !== null) {
        bankruptcyNames.push(merchant.displayName);
      }
    }
  }

  const investments = state.investments.map((investment) => ({
    merchantId: investment.merchantId,
    displayName:
      config.merchants[investment.merchantId]?.displayName ??
      investment.merchantId,
    amount: investment.amount,
  }));

  const playerTrades = events.filter(
    (event) => event.type === "trade.buy" || event.type === "trade.sell",
  );
  const buyCount = playerTrades.filter(
    (event) => event.type === "trade.buy",
  ).length;
  const sellCount = playerTrades.filter(
    (event) => event.type === "trade.sell",
  ).length;
  const volume = events.reduce(
    (sum, event) => sum + (event.quantity ?? 0),
    0,
  );
  const value = roundMoney(
    events.reduce(
      (sum, event) => sum + (event.price ?? 0) * (event.quantity ?? 0),
      0,
    ),
    config,
  );

  const topMovers = topMoversFrom(service, spectators);
  const leader = topMovers[0];
  const headline =
    health === "critical"
      ? "Market square in crisis as stalls close"
      : health === "strained"
        ? "Trading thins as cash runs short"
        : leader && leader.changePct > 8
          ? `${leader.displayName} leads a firm market`
          : health === "thriving"
            ? "Ironblock holds a steady market"
            : "Stalls steady after a mixed week";

  const standfirst =
    `${playerTrades.length} player trades moved ${volume} units for ` +
    `${value.toFixed(config.currency.decimals)} ${config.currency.symbol}. ` +
    `${open}/${total} stalls are open, ${bankruptcyNames.length} closed below reserve and ` +
    `${investments.length} investment${investments.length === 1 ? "" : "s"} reopened a counter. ` +
    `The caravan made ${state.caravan.arrivals} deliveries.`;

  return {
    headline,
    standfirst,
    generatedAtDay: state.day,
    topMovers,
    trades: {
      count: playerTrades.length,
      buyCount,
      sellCount,
      volume,
      value,
    },
    bankruptcies: bankruptcyNames,
    investments,
    caravan: {
      arrivals: state.caravan.arrivals,
      note:
        state.caravan.arrivals > 0
          ? "North Road caravans restocked the square from outside town."
          : "No caravan reached the square this session.",
    },
    sinks: {
      rent: roundMoney(state.stats.sinks.rent, config),
      tax: roundMoney(state.stats.sinks.salesTax, config),
      repairs: roundMoney(state.stats.sinks.repairs, config),
      total: roundMoney(state.stats.sinks.total, config),
    },
    merchants: { open, total, health },
  };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function recentEvents(service: EconomyService): SequencedMarketEvent[] {
  const sample = Math.max(
    1,
    Math.min(
      SNAPSHOT_EVENT_LIMIT,
      Math.floor(service.config.reporting.eventSampleSize) ||
        SNAPSHOT_EVENT_LIMIT,
    ),
  );
  const events = service.eventsSince(0);
  return events.slice(-sample);
}

function merchantsInStallOrder(
  config: EconomyConfig,
  merchants: Record<string, MerchantRuntimeState>,
): MerchantRuntimeState[] {
  return Object.values(merchants).sort((left, right) => {
    const leftSlot = config.merchants[left.id]?.stallSlot ?? 0;
    const rightSlot = config.merchants[right.id]?.stallSlot ?? 0;
    return leftSlot - rightSlot || left.id.localeCompare(right.id);
  });
}

function playerState(
  service: EconomyService,
  playerId: string,
): PlayerRuntimeState | null {
  return service.engine.getPlayer(playerId);
}

function townHealth(open: number, total: number) {
  const ratio = open / Math.max(1, total);
  if (ratio >= 1) return "thriving" as const;
  if (ratio >= 0.75) return "stable" as const;
  if (ratio >= 0.4) return "strained" as const;
  return "critical" as const;
}

function topMoversFrom(
  service: EconomyService,
  spectators: ReturnType<EconomyService["spectatorSnapshot"]>,
) {
  const config = service.config;
  const movers: Array<{
    itemId: ItemId;
    displayName: string;
    changePct: number;
    from: number;
    to: number;
  }> = [];

  for (const item of Object.values(config.items)) {
    const asks = spectators.merchants
      .filter((merchant) =>
        config.merchants[merchant.id]?.sells.includes(item.id),
      )
      .map((merchant) => merchant.askPrices[item.id])
      .filter((value): value is number => Number.isFinite(value) && value > 0);
    if (asks.length === 0) continue;
    const average = asks.reduce((sum, value) => sum + value, 0) / asks.length;
    const changePct =
      ((average - item.baseValue) / Math.max(0.01, item.baseValue)) * 100;
    movers.push({
      itemId: item.id,
      displayName: item.displayName,
      changePct: Math.round(changePct * 10) / 10,
      from: item.baseValue,
      to: roundMoney(average, config),
    });
  }

  return movers
    .filter((mover) => Math.abs(mover.changePct) >= 0.5)
    .sort(
      (left, right) =>
        Math.abs(right.changePct) - Math.abs(left.changePct),
    )
    .slice(0, Math.max(1, Math.floor(config.reporting.topMovers)));
}

function roundMoney(value: number, config: EconomyConfig): number {
  const scale = 10 ** config.currency.decimals;
  return Math.round(value * scale) / scale;
}

function formatMoney(config: EconomyConfig, value: number): string {
  return `${value.toFixed(config.currency.decimals)} ${config.currency.symbol}`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

class EconomyHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "EconomyHttpError";
  }
}

function engineError(error?: EconomyActionError): EconomyHttpError {
  return new EconomyHttpError(
    400,
    error?.code ?? "ACTION_FAILED",
    error?.message ?? "The market rejected that action",
  );
}

function loadConfiguredAuth(): ServerAuthConfig {
  try {
    return loadServerAuthConfig();
  } catch {
    throw new EconomyHttpError(
      500,
      "CONFIGURATION",
      "NEAR Auth is not configured on this server",
    );
  }
}

function isEconomyPath(pathname: string): boolean {
  return pathname === ROUTE_MARKER || pathname.includes(`${ROUTE_MARKER}/`);
}

function normalizeRoute(pathname: string): string | null {
  const markerIndex = pathname.indexOf(ROUTE_MARKER);
  const routePath =
    markerIndex >= 0
      ? pathname.slice(markerIndex + ROUTE_MARKER.length) || "/"
      : pathname;
  const normalized = routePath.replace(/\/+$/, "") || "/";
  const routes = new Set([
    "/snapshot",
    "/quote",
    "/trade",
    "/gather",
    "/craft",
    "/invest",
    "/repair",
    "/eat",
    "/fast-forward",
    "/events",
    "/orders",
    "/recap",
  ]);
  return routes.has(normalized) ? normalized : null;
}

function requireJson(req: IncomingMessage): void {
  const contentType = String(req.headers["content-type"] ?? "");
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new EconomyHttpError(
      415,
      "INVALID_REQUEST",
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

function readBodyValue(body: unknown, key: string): unknown {
  if (typeof body !== "object" || body === null) return undefined;
  return (body as Record<string, unknown>)[key];
}

function readBodyId(body: unknown, key: string): string {
  const value = readBodyValue(body, key);
  return readId(value, key);
}

function optionalBodyId(body: unknown, key: string): string | undefined {
  const value = readBodyValue(body, key);
  if (value === undefined || value === null) return undefined;
  return readId(value, key);
}

function readQueryId(url: URL, key: string): string {
  return readId(url.searchParams.get(key), key);
}

function readId(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new EconomyHttpError(
      400,
      "INVALID_REQUEST",
      `Missing ${label}`,
    );
  }
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_ID_LENGTH ||
    !ID_PATTERN.test(trimmed)
  ) {
    throw new EconomyHttpError(
      400,
      "INVALID_REQUEST",
      `${label} is not a valid identifier`,
    );
  }
  return trimmed;
}

function readSide(value: unknown): TradeSide {
  if (value === "buy" || value === "sell") return value;
  throw new EconomyHttpError(
    400,
    "INVALID_REQUEST",
    "side must be buy or sell",
  );
}

function readQuantity(value: unknown): number {
  const number =
    typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (
    typeof number !== "number" ||
    !Number.isInteger(number) ||
    number <= 0 ||
    number > MAX_QUANTITY
  ) {
    throw new EconomyHttpError(
      400,
      "INVALID_REQUEST",
      `quantity must be an integer between 1 and ${MAX_QUANTITY}`,
    );
  }
  return number;
}

function readPositiveAmount(value: unknown): number {
  const number =
    typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (
    typeof number !== "number" ||
    !Number.isFinite(number) ||
    number <= 0 ||
    number > 1_000_000_000
  ) {
    throw new EconomyHttpError(
      400,
      "INVALID_REQUEST",
      "amount must be a positive number",
    );
  }
  return number;
}

function readDays(value: unknown, config: EconomyConfig): number {
  const number = value;
  const max = Math.max(1, Math.floor(config.fastForward.maxDays));
  if (
    typeof number !== "number" ||
    !Number.isInteger(number) ||
    number <= 0 ||
    number > max
  ) {
    throw new EconomyHttpError(
      400,
      "INVALID_REQUEST",
      `days must be an integer between 1 and ${max}`,
    );
  }
  return number;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      throw new EconomyHttpError(
        413,
        "INVALID_REQUEST",
        "Request body is too large",
      );
    }
    chunks.push(buffer);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new EconomyHttpError(
      400,
      "INVALID_REQUEST",
      "Request body is not valid JSON",
    );
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return;
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}
