/**
 * Public settlement DTOs shared by the browser client and the server.
 *
 * These types contain no secrets and no key material. The treasury signer and
 * the ledger stay server-side.
 */

/** A canonical decimal amount string (U128 style). `0` decimals on chain. */
export type NftAmount = string;

/** Lifecycle of a withdrawal. See README for the exact state machine. */
export type WithdrawalStatus =
  | "pending" // created, hold taken, transfer not yet broadcast
  | "submitted" // broadcast accepted by RPC, waiting for FINAL
  | "confirmed" // tx FINAL on testnet; ledger debit committed
  | "failed" // refused before broadcast or failed on chain
  | "refunded"; // hold released after an on-chain failure

/** Read-only server view of one withdrawal record. */
export interface WithdrawalView {
  id: string;
  playerId: string;
  requestId: string;
  tokenId: string;
  amount: NftAmount;
  receiverId: string;
  status: WithdrawalStatus;
  txHash?: string;
  explorerUrl?: string;
  /** Safe, user-facing error code. Never key material. */
  errorCode?: string;
  /** Safe, user-facing message. Never key material or raw RPC errors. */
  errorMessage?: string;
  /** NEP-245 chain contract used for the transfer. */
  contractId: string;
  /** NEAR testnet only. */
  network: "testnet";
  /** ISO timestamps. */
  createdAt: string;
  submittedAt?: string;
  confirmedAt?: string;
  failedAt?: string;
  refundedAt?: string;
  /** True when a repeated requestId returned an earlier record. */
  replayed?: boolean;
}

export interface LedgerBalanceView {
  tokenId: string;
  available: string;
  held: string;
  debited: string;
}

/** Player-scoped ledger snapshot used by proof UIs and tests. */
export interface LedgerSnapshot {
  playerId: string;
  balances: LedgerBalanceView[];
}

/** Public item metadata strip for the withdraw panel. */
export interface ItemInfo {
  tokenId: string;
  title?: string;
  symbol?: string;
  decimals: number;
  supply?: string;
}

/** Response of `GET /api/settlement/onchain/:account`. */
export interface OnchainAccountView {
  accountId: string;
  contractId: string;
  network: "testnet";
  balances: Record<string, NftAmount>;
  items: ItemInfo[];
  /** Included when the queried account is the configured treasury. */
  treasuryNearBalance?: string;
}

/** Response of `GET /api/settlement/health`. */
export interface SettlementHealth {
  status: "ok" | "degraded";
  service: "settlement";
  network: "testnet";
  contractId: string;
  treasuryAccountId: string;
  treasuryKey: "unavailable" | "available";
  ledger: "in-memory" | "connected";
  detail?: string;
}

/** Body of `POST /api/settlement/withdraw`. */
export interface WithdrawRequest {
  requestId: string;
  tokenId: string;
  amount: NftAmount | number;
  /**
   * Must equal the logged-in player's MPC-derived implicit account. Kept as a
   * parameter so the protocol is explicit, never trusted from the client.
   */
  receiver?: string;
}
