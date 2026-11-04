/**
 * Shapes returned by the deployed `v2.ironblock-items.testnet` contract
 * (see contracts/nep245/src/lib.rs). Amounts are snake_case JSON with U128
 * values encoded as decimal strings.
 */

export interface ContractConfigView {
  owner_id: string;
  treasury_id: string;
  proposed_owner_id?: string | null;
  genesis_minted: boolean;
  token_count: number;
}

/** Shape of `get_items()` / `get_item()` from the deployed contract. */
export interface ContractItemView {
  token_id: string;
  name: string;
  symbol: string;
  description: string;
  /** base64 data-URL SVG icon. */
  icon: string;
  decimals: number;
  supply: string;
}

export interface MtTransferArgs {
  receiver_id: string;
  token_id: string;
  /** Decimal U128 string. */
  amount: string;
  approval: null;
  memo: string;
}

export interface NearAccountView {
  amount: string;
  code_hash: string;
}
