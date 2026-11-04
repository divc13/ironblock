# Ironblock NEP-245 items contract

One NEP-245 multi-token contract for the Ironblock game economy. All 11 item
types live in a single contract on NEAR testnet. Item metadata and genesis
supplies are compiled into the contract; the owner can mint the genesis supply
to the treasury exactly once. There is no public mint and no burn.

## Testnet deployment

| Field | Value |
| --- | --- |
| Network | NEAR testnet |
| Contract | [`ironblock-items.testnet`](https://explorer.testnet.near.org/accounts/ironblock-items.testnet) |
| Owner | `ironblock-items.testnet` |
| Treasury | [`ironblock-treasury.testnet`](https://explorer.testnet.near.org/accounts/ironblock-treasury.testnet) |
| Initialization | [`new(owner, treasury)`](https://explorer.testnet.near.org/transactions/7VriKWbsju8nCZVLfRQxhdH4zchn9UPURxeVf4gK3WeM) |
| Genesis mint | [`mint_genesis()`](https://explorer.testnet.near.org/transactions/B4jKAnmvKZmVXQB9QDRSGg6dL3jsvQkQQmLiZqwSSwF8) |
| Final code redeploy | [`without_init`](https://explorer.testnet.near.org/transactions/41WyQp1gHnVapRtvVFRmfXHfozQyxVMGSjQAN79t6Rym) |
| Toolkit validation redeploy | [`without_init`](https://explorer.testnet.near.org/transactions/DAxzGc8YwnbRzfsnkyTdALyPPmp4D1E868fAjJcoW6eM) |
| Wasm SHA-256 | `1295311b3fcc1363efbdd120e454ac997f8568028e32c8ee90840e862b3ac487` |
| Wasm size | 251,011 bytes |

NEARBlocks mirrors:
[contract](https://testnet.nearblocks.io/address/ironblock-items.testnet) and
[treasury](https://testnet.nearblocks.io/address/ironblock-treasury.testnet).

The machine-readable deployment record is in
[`deployments/testnet.json`](deployments/testnet.json). The smoke test moved
1 `iron_ore` from the treasury to the contract account and back, so the treasury
still holds the full genesis supply.

## Item catalogue

All items use **0 decimals** and integer base units.

| Token ID | Display name | Symbol | Genesis supply |
| --- | --- | --- | ---: |
| `iron_ore` | Iron Ore | IORE | 100,000 |
| `iron_ingot` | Iron Ingot | IING | 25,000 |
| `grain` | Grain | GRN | 100,000 |
| `flour` | Flour | FLR | 25,000 |
| `timber` | Timber | TMB | 100,000 |
| `plank` | Plank | PLK | 25,000 |
| `wool` | Wool | WOL | 100,000 |
| `cloth` | Cloth | CLT | 25,000 |
| `pickaxe` | Pickaxe | PCK | 1,000 |
| `hoe` | Hoe | HOE | 1,000 |
| `axe` | Axe | AXE | 1,000 |
| **Total** | | | **503,000** |

Each item has a display name, description and a self-contained SVG icon encoded
as a base64 `data:image/svg+xml;base64,...` URI. Icons are generated from
`icons/*.svg` by `scripts/generate_icons.py` and embedded in `src/icons.rs`.

## Implemented interfaces

### Administration and operations

| Method | Access | Notes |
| --- | --- | --- |
| `new(owner_id, treasury_id)` | initializer | Runs once at deployment. |
| `mint_genesis()` | owner | One-time mint of every fixed supply to the treasury. Panics after the first success. |
| `propose_owner(new_owner_id)` | owner | Starts two-step ownership transfer. |
| `accept_owner()` | proposed owner | Completes ownership transfer. |
| `get_config()` | view | Owner, treasury, pending owner, `genesis_minted`, token count. |
| `get_items()` / `get_item(token_id)` | view | Convenience item metadata plus current supply. |

### NEP-245 core

| Method | Notes |
| --- | --- |
| `mt_transfer(receiver_id, token_id, amount, approval, memo)` | Direct transfer. Requires exactly 1 yoctoNEAR. `approval` must be `null`. |
| `mt_batch_transfer(receiver_id, token_ids, amounts, approvals, memo)` | Batch direct transfer. Requires exactly 1 yoctoNEAR. Approvals must be absent or all `null`. |
| `mt_transfer_call(receiver_id, token_id, amount, approval, memo, msg)` | Transfer, call `mt_on_transfer` on the receiver, then settle/refund. Requires 1 yoctoNEAR and at least 40 Tgas. |
| `mt_batch_transfer_call(receiver_id, token_ids, amounts, approvals, memo, msg)` | Batched `mt_transfer_call`. |
| `mt_balance_of(account_id, token_id)` | Returns `"0"` for unknown tokens. |
| `mt_batch_balance_of(account_id, token_ids)` | Batch balances. |
| `mt_supply(token_id)` | `null` for unknown token IDs. |
| `mt_batch_supply(token_ids)` | `null` entries for unknown token IDs. |
| `mt_token(token_ids)` | Core token view. `owner_id` is `null` because items are fungible-like. |
| `mt_tokens(from_index, limit)` | Paginated enumeration of all 11 tokens. |
| `mt_tokens_for_owner(account_id, from_index, limit)` | Held tokens only; scans the fixed 11-item set. |

### NEP-245 metadata extension

| Method | Notes |
| --- | --- |
| `mt_metadata_contract()` | `spec: "mt-1.0.0"`, contract name. |
| `mt_metadata_token_all(token_ids)` | Combined base + instance metadata. |
| `mt_metadata_token_by_token_id(token_ids)` | Instance metadata. |
| `mt_metadata_base_by_token_id(token_ids)` | Base metadata by token ID. |
| `mt_metadata_base_by_metadata_id(base_metadata_ids)` | Base metadata by metadata ID (same as token ID here). |
| `mt_tokens_base_metadata_all(from_index, limit)` | Paginated base metadata. |

### Convenience views and callback

| Method | Notes |
| --- | --- |
| `mt_metadata(token_id)` | Flattened name/symbol/description/icon/decimals/supply object. |
| `mt_batch_metadata(token_ids)` | Batch version of `mt_metadata`; unknown IDs yield `null`. |
| `mt_resolve_transfer(sender_id, receiver_id, token_ids, amounts)` | Private settlement callback for `*_transfer_call`; not callable by users. Returns the amount actually spent per token. |

The complete method list is in [`src/lib.rs`](src/lib.rs).

## Events

The contract emits NEP-297-style logs:

```text
EVENT_JSON:{"standard":"nep245","version":"1.0.0","event":"mt_mint","data":[...]}
EVENT_JSON:{"standard":"nep245","version":"1.0.0","event":"mt_transfer","data":[...]}
```

A `*_transfer_call` refund emits an `mt_transfer` event from the receiver back to
the sender with the memo `transfer_call refund`. Indexers should treat event logs
as the authoritative transfer feed.

## Build and test

Prerequisites: stable Rust with the `wasm32-unknown-unknown` target. The pinned
`near-sdk` version is `5.30.0`.

```bash
cd contracts/nep245

# Unit tests (19 tests)
cargo test

# Reproducible release wasm build
./scripts/build.sh
# or directly:
RUSTFLAGS='-C link-arg=-s' cargo build --locked --target wasm32-unknown-unknown --release
```

The build output is
`target/wasm32-unknown-unknown/release/ironblock_nep245.wasm`.

Tests cover genesis supply, single and batch transfers, balance and supply
conservation, unauthorized mint and transfer rejection, metadata and decimals,
implicit/hex account transfers, pagination, approvals rejection, and
`transfer_call` success, partial refund, failure and malformed-result paths.

## Deployment toolkit

The scripts use [near-cli-rs](https://github.com/near/near-cli-rs) and its
keychain. No private key or seed phrase is stored in this repository. `.env` is
git-ignored; only `.env.example` is committed.

Prerequisites:

- `cargo` + `rustup` (for the wasm target)
- `near` (near-cli-rs 0.30.x; testnet has been validated with 0.30.1)
- `jq` for `verify.sh`

Setup:

```bash
cd contracts/nep245
cp .env.example .env
$EDITOR .env
```

Typical testnet run:

```bash
# 1. Create contract + treasury accounts through the testnet faucet.
#    Existing accounts are left unchanged. Generated keys go to the near-cli
#    keychain, not to this repository.
./scripts/create-testnet-account.sh

# 2. Build the release wasm.
./scripts/build.sh

# 3. Deploy. A fresh account is initialized with new(owner, treasury).
#    An already-initialized contract is upgraded without re-initializing.
./scripts/deploy.sh --build

# 4. Mint the fixed genesis supply to the treasury (idempotent).
./scripts/mint-genesis.sh

# 5. Verify config, metadata, supplies and treasury balances.
./scripts/verify.sh
```

After gameplay has distributed tokens away from the treasury, use:

```bash
./scripts/verify.sh --allow-distributed
```

`deploy.sh` signs the deployment with the contract account's key from the
near-cli keychain. `mint-genesis.sh` and ownership calls sign as
`OWNER_ACCOUNT_ID`, whose key must also be in the keychain. A separate owner
account is supported; set `OWNER_ACCOUNT_ID` in `.env` and put its key in the
keychain. `create-testnet-account.sh` only creates a separate owner when
`CREATE_OWNER_ACCOUNT=1` is set.

For mainnet, create the accounts yourself, put the keys in a secure signer, set
`NEAR_NETWORK=mainnet`, and update the account IDs. The faucet script refuses to
run off testnet.

## Security notes and limitations

- **Fixed supply.** Genesis supplies and item definitions are compile-time
  constants. There is no public mint, no owner-configurable inflation and no
  burn. The owner can only perform the one-time genesis mint.
- **Owner powers.** The owner can mint genesis once and transfer ownership. It
  cannot change item metadata or supplies. Ownership transfer is two-step.
- **Contract upgrades.** The contract account's full-access key controls code
  upgrades. That key is the real admin authority and must be kept secure. The
  testnet deployment uses a hot keychain key, which is acceptable for testnet
  only; use a multisig/cold key for production.
- **Direct transfers.** All transfers are sender-authorized. The methods reject
  a sender equal to the receiver, zero amounts, unknown token IDs, and duplicate
  token IDs that would bypass the aggregate balance check.
- **No approvals.** `mt_approve` / `mt_revoke_approval` are not implemented.
  `approval` and `approvals` arguments must be `null` (or omitted). The game
  server cannot pull items from a player's account; it can only transfer items
  it owns (for example, from the treasury or merchant accounts).
- **No receiver registration / storage deposits.** Transfers do not require the
  receiver to register, so implicit and hex accounts work out of the box. The
  contract pays storage for each `(account, token_id)` balance entry. Because the
  token set is fixed at 11, this is bounded per account but not globally: a
  funded attacker can create many account/token entries with 1-yocto transfers
  and consume the contract's storage balance. This is a deliberate testnet
  trade-off. Before mainnet, add receiver registration/storage deposits, an
  allowlist, or another anti-spam mechanism, and monitor the contract balance.
- **No burn.** Item sinks must be implemented by transferring items to a burn or
  escrow account, not by burning supply.
- **1 yoctoNEAR guard.** Every transfer method requires exactly 1 yoctoNEAR to
  prevent accidental function-call access-key use and replay-style confusion.
- **`transfer_call` trust boundary.** The receiver is called with 20 Tgas and the
  settlement callback with 10 Tgas; callers must attach at least 40 Tgas. A
  failed, malformed, oversized, or wrong-length receiver result is treated as a
  full refund, not as an error that strands tokens. The callback is private.
- **Testnet data only.** This deployment is for the hackathon and testnet. No
  real money is custodied.

## Integration notes

- Use contract ID `ironblock-items.testnet` on NEAR testnet. The repository's
  root `.env.example` still has the scaffold placeholder
  `items.ironblock.testnet`; set `VITE_NEP245_CONTRACT_ID` to the deployed ID
  when wiring the frontend.
- Amounts are integer base units and zero decimals, so `"25"` means 25 items,
  not 0.25. NEP-245 JSON responses encode `U128` amounts as decimal strings.
- For writes, attach exactly `1` yoctoNEAR to `mt_transfer`,
  `mt_batch_transfer`, `mt_transfer_call` and `mt_batch_transfer_call`. Use at
  least 40 Tgas for `transfer_call` variants.
- The server-authoritative game should keep the treasury key server-side. Never
  ship it to the browser. Players can hold items in their own NEAR accounts and
  transfer them directly; merchant/treasury accounts are controlled by the game
  server.
- For `mt_transfer_call`, the receiver must expose:

  ```rust
  fn mt_on_transfer(
      sender_id: AccountId,
      previous_owner_ids: Vec<AccountId>,
      token_ids: Vec<TokenId>,
      amounts: Vec<U128>,
      msg: String,
  ) -> Vec<U128>; // unused amounts, same length as token_ids
  ```

  Returning all amounts refunds the whole transfer. The settlement callback also
  refunds everything if the receiver call fails.
- Subscribe to `EVENT_JSON:` logs for mint/transfer indexing. The contract's
  `get_items`, `mt_metadata`, `mt_batch_balance_of` and `mt_batch_supply` views
  cover the common dashboard and server reconciliation needs.

## Layout

```text
contracts/nep245/
  Cargo.toml / Cargo.lock
  src/lib.rs              contract implementation
  src/tests.rs            unit tests
  src/icons.rs            generated SVG data URLs
  icons/*.svg             source icons
  scripts/                build, account creation, deploy, mint, verify
  deployments/            public testnet deployment record
  .env.example            committed configuration template
```
