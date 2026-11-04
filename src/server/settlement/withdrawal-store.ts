import type { WithdrawalStatus, WithdrawalView } from "../../shared/settlement/types";
import { SettlementError } from "./errors";

/**
 * Durable-record seam for withdrawals. Swap the in-memory adapter for the
 * database-backed implementation without touching the service logic.
 *
 * Idempotency contract: at most one record per (playerId, requestId). Losing a
 * request may drop a duplicate, then the client retries and gets a fresh
 * record; storing a duplicate must be impossible.
 */
export interface WithdrawalRecord extends WithdrawalView {
  /** Ledger hold that reserves the amount for this record. */
  holdId?: string;
  /** Roll-flag used by reconcile: hold released after failure. */
  updatedAt?: string;
}

export interface WithdrawalStore {
  get(id: string): Promise<WithdrawalRecord | undefined>;
  get(playerId: string, requestId: string): Promise<WithdrawalRecord | undefined>;
  findByPlayer(playerId: string, limit?: number): Promise<WithdrawalRecord[]>;
  insert(record: WithdrawalRecord): Promise<WithdrawalRecord>;
  update(id: string, patch: Partial<Omit<WithdrawalRecord, "id">>): Promise<WithdrawalRecord>;
}

/** Id generator seam for tests. */
export type WithdrawalIdFactory = () => string;

export class InMemoryWithdrawalStore implements WithdrawalStore {
  private readonly byId = new Map<string, WithdrawalRecord>();
  private readonly byRequest = new Map<string, string>();

  constructor(private readonly newId: WithdrawalIdFactory = defaultId) {}

  async get(idOrPlayer: string, requestId?: string): Promise<WithdrawalRecord | undefined> {
    if (requestId === undefined) return this.byId.get(idOrPlayer);
    const id = this.byRequest.get(`${idOrPlayer}\u0000${requestId}`);
    return id ? this.byId.get(id) : undefined;
  }

  async findByPlayer(playerId: string, limit = 50): Promise<WithdrawalRecord[]> {
    const records = [...this.byId.values()]
      .filter((r) => r.playerId === playerId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return records.slice(0, clampLimit(limit));
  }

  async insert(record: WithdrawalRecord): Promise<WithdrawalRecord> {
    const requestKey = `${record.playerId}\u0000${record.requestId}`;
    const existingId = this.byRequest.get(requestKey);
    if (existingId) {
      // Idempotency conflict: the caller should re-read the existing record.
      throw new SettlementError(
        "CONFLICT",
        409,
        `Withdrawal already exists for (${record.playerId}, ${record.requestId})`,
      );
    }
    if (this.byId.has(record.id)) {
      throw new SettlementError("CONFLICT", 409, `Withdrawal id ${record.id} already exists`);
    }
    const stored: WithdrawalRecord = { ...record };
    this.byId.set(stored.id, stored);
    this.byRequest.set(requestKey, stored.id);
    return stored;
  }

  async update(id: string, patch: Partial<Omit<WithdrawalRecord, "id">>): Promise<WithdrawalRecord> {
    const stored = this.byId.get(id);
    if (!stored) throw new SettlementError("CONFLICT", 409, `Unknown withdrawal ${id}`);
    const updated: WithdrawalRecord = { ...stored, ...patch, id };
    this.byId.set(id, updated);
    return updated;
  }

  /** Test helper. */
  get size(): number {
    return this.byId.size;
  }
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 50;
  return Math.max(1, Math.min(200, Math.floor(limit)));
}

function defaultId(): string {
  return `wd_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

export function recordToView(record: WithdrawalRecord): WithdrawalView {
  const { holdId: _holdId, updatedAt: _updatedAt, ...view } = record;
  return view;
}
