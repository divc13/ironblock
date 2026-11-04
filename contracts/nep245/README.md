# Ironblock NEP-245 items contract

One NEP-245 multi-token contract for the Ironblock game economy. All 13 item
types live in a single contract on NEAR testnet. Item metadata and genesis
supplies are compiled into the contract; the owner can mint the genesis supply
to the treasury exactly once. There is no public mint and no burn.

The earlier 11-token deployment at `ironblock-items.testnet` is superseded by
the final v2 deployment below. The old contract remains on chain for history,
but game and frontend integrations must use `v2.ironblock-items.testnet`.

## Testnet deployment

| Field | Value |
| --- | --- |
| Network | NEAR testnet |
| Contract | [`v2.ironblock-items.testnet`](https://explorer.testnet.near.org/accounts/v2.ironblock-items.testnet) |
| Owner | `v2.ironblock-items.testnet` |
| Treasury | [`v2.ironblock-treasury.testnet`](https://explorer.testnet.near.org/accounts/v2.ironblock-treasury.testnet) |
| Contract account creation | [`7mkJ6SY...`](https://explorer.testnet.near.org/transactions/7mkJ6SY695oUhaqq5AnuxTX7c4RMh2tCHEeVgR1sxvaW) |
| Treasury account creation | [`HuLqWFt...`](https://explorer.testnet.near.org/transactions/HuLqWFtUR1kwUVGi5cfT4rCXtn2Cq5sBU75ZXvAgRP9j) |
| Deploy + `new(owner, treasury)` | [`BxKHVgr...`](https://explorer.testnet.near.org/transactions/BxKHVgr4v7szRQsieGHJiT2HjYuz6BC2P1T8NM8DVoWd) |
| Genesis mint | [`2N4JBAH...`](https://explorer.testnet.near.org/transactions/2N4JBAHRuLaFJVi5g1JnmzLZDZpSuXKsKYt9nsRgUfHk) |
| Implicit-account settlement smoke test | [`3DTv9uJ...`](https://explorer.testnet.near.org/transactions/3DTv9uJQrADyMgqrztg5awhKpBQojWdchJTHosx52Q5r) |
| Wasm SHA-256 | `51e745dadd1921fd9ea4e1f52f6112bc948da96fbcad2c106bb91e884cec95c4` |
| Wasm size | 253,936 bytes |

NEARBlocks mirrors:
[contract](https://testnet.nearblocks.io/address/v2.ironblock-items.testnet) and
[treasury](https://testnet.nearblocks.io/address/v2.ironblock-treasury.testnet).

The machine-readable deployment record is in
[`deployments/testnet.json`](deployments/testnet.json). The smoke test sent
1 `bread` from the treasury to a fresh 64-hex implicit account with no receiver
registration, then verified the receiver balance was `"1"`. The treasury
therefore holds 24,999 `bread` and the full supply of the other 12 tokens.

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
| `bread` | Bread | BREAD | 25,000 |
| `cloak` | Cloak | CLOAK | 5,000 |
| **Total** | | | **533,000** |

`bread` is a processed staple aligned with the 25,000 `flour` supply. `cloak`
is a scarcer crafted wearable; 5,000 leaves room for tailoring sinks without
starving the merchant economy.

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
| `mt_token(token_ids)` | Core token view with `base_metadata_id` and `token_metadata`. |
| `mt_tokens(from_index, limit)` | Paginated enumeration of all 13 tokens, including metadata. |
| `mt_tokens_for_owner(account_id, from_index, limit)` | Held tokens only; scans the fixed 13-item set. |

`Token` views now contain:

```json
{
  "token_id": "bread",
  "owner_id": null,
  "base_metadata_id": "bread",
  "token_metadata": {
    "title": "Bread",
    "description": "A fresh loaf that restores stamina when eaten.",
    "media": "data:image/svg+xml;base64,...",
    "media_hash": null,
    "issued_at": null,
    "expires_at": null,
    "starts_at": null,
    "updated_at": null,
    "extra": null,
    "reference": null,
    "reference_hash": null
  }
}
```

`mt_tokens` returns all 13 token views in about 14 KB of JSON, which is
reasonable for dashboards and server reconciliation. Paginate with
`from_index`/`limit` if a client needs smaller responses.

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

# Unit tests (20 tests)
cargo test --locked

# Release wasm build used for deployment
./scripts/build.sh
```

The build output is
`target/wasm32-unknown-unknown/release/ironblock_nep245.wasm`.

### Reproducibility note

Use `scripts/build.sh` (or the exact command it wraps), not a plain
`cargo build --release`. The build needs:

```bash
RUSTFLAGS='-C link-arg=-s' \
  cargo build --locked --target wasm32-unknown-unknown --release
```

The expected SHA-256 for this commit's source is:

```text
51e745dadd1921fd9ea4e1f52f6112bc948da96fbcad2c106bb91e884cec95c4
```

The deployed testnet contract reports this same checksum. A plain `cargo build`
without the `-s` link argument is not the deployment artifact and may produce a
different hash.

Tests cover genesis supply, single and batch transfers, balance and supply
conservation, unauthorized mint and transfer rejection, metadata and decimals,
all 13 token definitions, implicit/hex account transfers, pagination, token view
metadata, approvals rejection, and `transfer_call` success, partial refund,
failure, malformed-result and oversized-result paths.

## Deployment toolkit

The scripts use [near-cli-rs](https://github.com/near/near-cli-rs) and its
keychain. No private key or seed phrase is stored in this repository. `.env` is
git-ignored; only `.env.example` is committed.

Prerequisites:

- `cargo` + `rustup` (for the wasm target)
- `near` (near-cli-rs 0.30.x; testnet has been validated with 0.30.1)
- `jq` for the verification and withdrawal scripts

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

# 5. Verify config, metadata, token views, supplies and treasury balances.
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

The final v2 accounts were created as funded subaccounts of the earlier
`ironblock-items.testnet` and `ironblock-treasury.testnet` accounts, which keeps
the deployment pair together and avoids faucet limits. On a clean network, use
the faucet script with available top-level IDs, or create subaccounts from a
funded parent with near-cli-rs and save their keys to the keychain.

For mainnet, create the accounts yourself, put the keys in a secure signer, set
`NEAR_NETWORK=mainnet`, and update the account IDs. The faucet script refuses to
run off testnet.

## Settlement operations

The settlement agent withdraws items from the treasury with the helper script:

```bash
./scripts/treasury-withdraw.sh <receiver_id> <token_id> <amount> [memo]

# Example:
./scripts/treasury-withdraw.sh alice.testnet bread 25 "order-2026-11-04-001"
```

The script checks that the token exists, rejects zero amounts, requires the
receiver to differ from the treasury, attaches exactly 1 yoctoNEAR, and signs
with `TREASURY_ACCOUNT_ID`. It only requires the treasury key; the owner key is
not needed for withdrawals. On testnet the key is in the near-cli-rs keychain.
In production, keep the treasury key in an isolated signer/KMS or multisig and
never ship it to the browser or commit it.

- **Finality:** near-cli-rs waits for final execution by default. Credit a
  withdrawal only after the transaction is `FINAL` and its status is successful,
  or after independently observing the `mt_transfer` event and receiver balance.
- **Memo / idempotency:** the on-chain `memo` is informational; the contract does
  not enforce uniqueness. The settlement agent should store an idempotency key
  with the tx hash before broadcasting, put that key in the memo, and on retry
  check the stored tx hash plus `mt_balance_of`/event history instead of sending
  a duplicate. A re-sent transaction is a new transfer and is not deduplicated
  on chain.
- **Signer expectations:** `TREASURY_ACCOUNT_ID` must be a normal account with a
  full-access key in the configured signer. `OWNER_ACCOUNT_ID` is only needed for
  the one-time genesis mint and ownership changes. Do not print or log the key.
- **No approvals:** the settlement agent cannot pull items from a player's
  account. It can only transfer from accounts it controls, such as the treasury
  and merchant accounts.

The implicit-account smoke test is part of the final deployment record:
`mt_transfer` sent 1 `bread` to a fresh 64-hex account without any receiver
registration, and `mt_balance_of` returned `"1"`.

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
  token set is fixed at 13, this is bounded per account but not globally: a
  funded attacker can create many account/token entries with 1-yocto transfers
  and consume the contract's storage balance. This is a deliberate testnet
  trade-off. Before mainnet, add receiver registration/storage deposits, an
  allowlist, or another anti-spam mechanism, and monitor the contract balance.
- **No burn.** Item sinks must be implemented by transferring items to a burn or
  escrow account, not by burning supply.
- **1 yoctoNEAR guard.** Every transfer method requires exactly 1 yoctoNEAR to
  prevent accidental function-call access-key use and replay-style confusion.
- **`transfer_call` trust boundary.** The receiver is called with 20 Tgas and the
  settlement callback with 10 Tgas; callers must attach at least 40 Tgas.
  Receiver results are capped at 16 KiB. A failed, malformed, oversized, or
  wrong-length result is treated as a full refund, not as an error that strands
  tokens. The callback is private.
- **Testnet data only.** This deployment is for the hackathon and testnet. No
  real money is custodied.

## Integration notes

- Use contract ID `v2.ironblock-items.testnet` and treasury
  `v2.ironblock-treasury.testnet` on NEAR testnet. The root `.env.example` has
  been updated to these final IDs.
- Amounts are integer base units and zero decimals, so `"25"` means 25 items,
  not 0.25. NEP-245 JSON responses encode `U128` amounts as decimal strings.
- For writes, attach exactly `1` yoctoNEAR to `mt_transfer`,
  `mt_batch_transfer`, `mt_transfer_call` and `mt_batch_transfer_call`. Use at
  least 40 Tgas for `transfer_call` variants.
- The server-authoritative game should keep the treasury key server-side. Never
  ship it to the browser. Players can hold items in their own NEAR accounts and
  transfer them directly; merchant/treasury accounts are controlled by the game
  server.
- Token views now include `base_metadata_id` and `token_metadata`. Update any
  strict TypeScript/Rust deserializer or GraphQL schema that was written against
  the old two-field `Token` shape.
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
  refunds everything if the receiver call fails, returns malformed JSON, or
  returns more than 16 KiB.
- Subscribe to `EVENT_JSON:` logs for mint/transfer indexing. The contract's
  `get_items`, `mt_metadata`, `mt_batch_balance_of` and `mt_batch_supply` views
  cover the common dashboard and server reconciliation needs.
- The old `ironblock-items.testnet` contract has only 11 tokens and is
  superseded. Do not mix balances between the old and v2 deployments.

## Layout

```text
contracts/nep245/
  Cargo.toml / Cargo.lock
  src/lib.rs              contract implementation
  src/tests.rs            unit tests
  src/icons.rs            generated SVG data URLs
  icons/*.svg             source icons
  scripts/                build, account creation, deploy, mint, withdraw, verify
  deployments/            public testnet deployment record
  .env.example            committed configuration template
```
