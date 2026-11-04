#!/usr/bin/env bash
# Verify the deployed contract's configuration, metadata, supplies and, unless
# --allow-distributed is passed, that the treasury still holds the genesis supply.
set -euo pipefail

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"

ALLOW_DISTRIBUTED=0
case "${1:-}" in
    --allow-distributed) ALLOW_DISTRIBUTED=1 ;;
    -h|--help)
        printf 'usage: %s [--allow-distributed]\n\n' "$0"
        printf '  --allow-distributed  skip the treasury balance check after tokens move\n'
        exit 0
        ;;
    '') ;;
    *) die "unknown argument: $1 (expected --allow-distributed)" ;;
esac

require_cmd "$NEAR_CLI"
require_cmd jq
require_var CONTRACT_ACCOUNT_ID
require_var OWNER_ACCOUNT_ID
require_var TREASURY_ACCOUNT_ID

TOKEN_IDS=(
    iron_ore iron_ingot grain flour timber plank wool cloth pickaxe hoe axe
)
EXPECTED_SUPPLIES=(
    100000 25000 100000 25000 100000 25000 100000 25000 1000 1000 1000
)
TOKEN_IDS_JSON='["iron_ore","iron_ingot","grain","flour","timber","plank","wool","cloth","pickaxe","hoe","axe"]'
EXPECTED_SUPPLIES_JSON='["100000","25000","100000","25000","100000","25000","100000","25000","1000","1000","1000"]'
EXPECTED_TOTAL=503000

say "Reading contract config from $CONTRACT_ACCOUNT_ID ($NEAR_NETWORK)"
CONFIG="$(near_call_view get_config '{}')" || die \
    "could not read get_config; is the contract deployed and initialized?"

printf '%s' "$CONFIG" | jq -e \
    --arg owner "$OWNER_ACCOUNT_ID" \
    --arg treasury "$TREASURY_ACCOUNT_ID" \
    '.genesis_minted == true and .token_count == 11 and .owner_id == $owner and .treasury_id == $treasury' \
    >/dev/null || die "unexpected contract config: $CONFIG"

ITEMS="$(near_call_view get_items '{}')" || die "could not read get_items"
[[ "$(printf '%s' "$ITEMS" | jq 'length')" == "${#TOKEN_IDS[@]}" ]] || \
    die "expected ${#TOKEN_IDS[@]} items from get_items"

TOTAL=0
INDEX=0
while [[ "$INDEX" -lt "${#TOKEN_IDS[@]}" ]]; do
    TOKEN_ID="${TOKEN_IDS[$INDEX]}"
    EXPECTED="${EXPECTED_SUPPLIES[$INDEX]}"
    ITEM="$(printf '%s' "$ITEMS" | jq -c --arg id "$TOKEN_ID" \
        'map(select(.token_id == $id)) | if length == 1 then .[0] else empty end')"
    [[ -n "$ITEM" ]] || die "item $TOKEN_ID is missing or duplicated"

    [[ "$(printf '%s' "$ITEM" | jq -r '.supply')" == "$EXPECTED" ]] || \
        die "$TOKEN_ID supply is not $EXPECTED"
    [[ "$(printf '%s' "$ITEM" | jq -r '.decimals')" == "0" ]] || \
        die "$TOKEN_ID does not use 0 decimals"

    for FIELD in name symbol description icon; do
        VALUE="$(printf '%s' "$ITEM" | jq -r ".$FIELD")"
        [[ -n "$VALUE" && "$VALUE" != "null" ]] || die "$TOKEN_ID has no $FIELD"
    done
    ICON="$(printf '%s' "$ITEM" | jq -r '.icon')"
    [[ "$ICON" == "data:image/svg+xml;base64,"* ]] || \
        die "$TOKEN_ID icon is not a self-contained SVG data URL"

    TOTAL=$((TOTAL + EXPECTED))
    INDEX=$((INDEX + 1))
done
[[ "$TOTAL" -eq "$EXPECTED_TOTAL" ]] || die "expected total supply $EXPECTED_TOTAL, got $TOTAL"

CONTRACT_METADATA="$(near_call_view mt_metadata_contract '{}')" || \
    die "could not read mt_metadata_contract"
printf '%s' "$CONTRACT_METADATA" | jq -e \
    '.spec == "mt-1.0.0" and .name == "Ironblock Items"' >/dev/null || \
    die "unexpected contract metadata: $CONTRACT_METADATA"

BATCH_SUPPLY_ARGS="$(jq -nc --argjson ids "$TOKEN_IDS_JSON" '{token_ids: $ids}')"
BATCH_SUPPLY="$(near_call_view mt_batch_supply "$BATCH_SUPPLY_ARGS")" || \
    die "could not read mt_batch_supply"
printf '%s' "$BATCH_SUPPLY" | jq -e --argjson expected "$EXPECTED_SUPPLIES_JSON" \
    '. == $expected' >/dev/null || die "mt_batch_supply does not match genesis supplies"

TOKENS="$(near_call_view mt_tokens '{}')" || die "could not read mt_tokens"
printf '%s' "$TOKENS" | jq -e 'length == 11' >/dev/null || \
    die "mt_tokens did not return 11 tokens"

UNKNOWN_METADATA="$(near_call_view mt_metadata '{"token_id":"not_an_item"}')" || \
    die "could not read mt_metadata for an unknown token"
[[ "$UNKNOWN_METADATA" == "null" ]] || die "unknown token metadata should be null"

if [[ "$ALLOW_DISTRIBUTED" -eq 0 ]]; then
    BALANCE_ARGS="$(jq -nc --arg account "$TREASURY_ACCOUNT_ID" \
        --argjson ids "$TOKEN_IDS_JSON" '{account_id: $account, token_ids: $ids}')"
    TREASURY_BALANCES="$(near_call_view mt_batch_balance_of "$BALANCE_ARGS")" || \
        die "could not read treasury balances"
    printf '%s' "$TREASURY_BALANCES" | jq -e \
        --argjson expected "$EXPECTED_SUPPLIES_JSON" '. == $expected' >/dev/null || \
        die "treasury does not hold the full genesis supply; use --allow-distributed after distributing tokens"
    say "Treasury holds the full genesis supply"
else
    warn "Skipping treasury balance check (--allow-distributed)"
fi

say "Verified 11 tokens; total supply $TOTAL"
say "Owner: $OWNER_ACCOUNT_ID"
say "Treasury: $TREASURY_ACCOUNT_ID"
