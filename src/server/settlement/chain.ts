import type {
  ContractConfigView,
  ContractItemView,
} from "./onchain-types";
import type { ItemInfo } from "../../shared/settlement/types";

/**
 * Result of a settlement transfer that reached FINAL execution.
 */
export interface MtTransferResult {
  txHash: string;
  explorerUrl: string;
  explorerAlternativeUrl?: string;
  /** True when the outcome status expected finality (FINAL block). */
  final: boolean;
}

export interface MtTransferInput {
  receiverId: string;
  tokenId: string;
  amount: number;
  memo: string;
}

/**
 * NEP-245 change/view seam used by the settlement service.
 *
 * Unit tests substitute a scripted implementation; the real implementation
 * speaks JSON-RPC to the NEAR testnet through near-api-js.
 */
export interface Nep245Chain {
  /** contract(owner, treasury, genesis_minted, count). */
  getConfig(): Promise<ContractConfigView>;
  /** Item metadata + supply list. */
  getItems(): Promise<ContractItemView[]>;
  /** mt_balance_of -> decimal U128 string ("0" for unknown token). */
  mtBalanceOf(accountId: string, tokenId: string): Promise<string>;
  /** mt_batch_balance_of in tokenIds order. */
  mtBatchBalanceOf(accountId: string, tokenIds: string[]): Promise<string[]>;
  /**
   * Transfer as the treasury and wait for FINAL. Throws on contract panic or
   * failure. Must attach exactly 1 yoctoNEAR.
   */
  mtTransferAsTreasury(input: MtTransferInput): Promise<MtTransferResult>;
  /** Re-check a previously broadcast transaction; only gives a verdict on FINAL. */
  transactionStatus(txHash: string): Promise<"confirmed" | "failed" | "pending">;
  /** Treasury available NEAR balance (yocto). Read-only reconciliation. */
  treasuryNearBalance(): Promise<string>;
}

/** Flatten ContractItemView for clients (icon stripped: icons are heavy). */
export function itemInfoOf(item: ContractItemView): ItemInfo {
  return {
    tokenId: item.token_id,
    title: item.name,
    symbol: item.symbol,
    decimals: item.decimals,
    supply: item.supply,
  };
}
