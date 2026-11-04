#!/usr/bin/env bash
# Call the one-time genesis mint as the owner. Safe to re-run: it exits early if
# the on-chain state says genesis has already been minted.
set -euo pipefail

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"

require_cmd "$NEAR_CLI"
require_var CONTRACT_ACCOUNT_ID
require_var OWNER_ACCOUNT_ID

CONFIG="$(near_call_view get_config '{}')" || die \
    "could not read get_config; deploy and initialize the contract first"

if printf '%s' "$CONFIG" | grep -Eq '"genesis_minted"[[:space:]]*:[[:space:]]*true'; then
    say "Genesis supply is already minted; nothing to do."
    exit 0
fi

say "Minting fixed genesis supply to $TREASURY_ACCOUNT_ID (signer: $OWNER_ACCOUNT_ID)"
near_call_tx mint_genesis '{}' 100Tgas '0 NEAR' "$OWNER_ACCOUNT_ID"
say "Genesis mint sent. Run ./scripts/verify.sh"
