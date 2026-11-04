#!/usr/bin/env bash
# Settlement helper: transfer tokens out of the treasury with mt_transfer.
#
# Usage:
#   ./scripts/treasury-withdraw.sh <receiver_id> <token_id> <amount> [memo]
#
# The treasury key must be in the near-cli-rs keychain under TREASURY_ACCOUNT_ID.
# The script never reads, prints or stores a private key. Every call attaches the
# required 1 yoctoNEAR and waits for the transaction to reach final execution.
set -euo pipefail

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"

case "${1:-}" in
    -h|--help)
        printf 'usage: %s <receiver_id> <token_id> <amount> [memo]\n\n' "$0"
        printf '  receiver_id  NEAR account (named or implicit/hex) receiving the tokens\n'
        printf '  token_id     one of the 13 Ironblock token IDs\n'
        printf '  amount       positive integer in base units (0 decimals)\n'
        printf '  memo         optional settlement reference / idempotency key\n'
        exit 0
        ;;
esac

[[ "$#" -ge 3 && "$#" -le 4 ]] || die \
    "usage: $0 <receiver_id> <token_id> <amount> [memo]"

RECEIVER_ID="$1"
TOKEN_ID="$2"
AMOUNT="$3"
MEMO="${4:-}"

require_cmd "$NEAR_CLI"
require_cmd jq
require_var CONTRACT_ACCOUNT_ID
require_var TREASURY_ACCOUNT_ID

[[ -n "$RECEIVER_ID" ]] || die "receiver_id must not be empty"
[[ "$AMOUNT" =~ ^[0-9]+$ ]] || die "amount must be a positive integer"
[[ "$AMOUNT" != "0" ]] || die "amount must be greater than zero"
[[ "$RECEIVER_ID" != "$TREASURY_ACCOUNT_ID" ]] || \
    die "receiver_id must differ from the treasury"

ITEM_ARGS="$(jq -nc --arg id "$TOKEN_ID" '{token_id: $id}')"
ITEM="$(near_call_view get_item "$ITEM_ARGS")" || die "could not read item $TOKEN_ID"
[[ "$ITEM" != "null" ]] || die "unknown token_id: $TOKEN_ID"

ARGS="$(jq -nc \
    --arg receiver_id "$RECEIVER_ID" \
    --arg token_id "$TOKEN_ID" \
    --arg amount "$AMOUNT" \
    --arg memo "$MEMO" \
    '{receiver_id: $receiver_id, token_id: $token_id, amount: $amount, approval: null, memo: (if $memo == "" then null else $memo end)}')"

say "Withdrawing $AMOUNT $TOKEN_ID from $TREASURY_ACCOUNT_ID to $RECEIVER_ID"
[[ -z "$MEMO" ]] || say "Memo: $MEMO"
near_call_tx mt_transfer "$ARGS" 100Tgas '1 yoctoNEAR' "$TREASURY_ACCOUNT_ID"
say "Transfer sent. Wait for final execution and verify with mt_balance_of before crediting."
