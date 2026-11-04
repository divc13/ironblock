#!/usr/bin/env bash
# Deploy the contract. A fresh account is initialized with new(owner, treasury);
# an account that already answers get_config is upgraded without re-initializing.
set -euo pipefail

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"

BUILD=0
case "${1:-}" in
    --build) BUILD=1 ;;
    -h|--help)
        printf 'usage: %s [--build]\n\n' "$0"
        printf '  --build   rebuild the wasm before deploying\n'
        exit 0
        ;;
    '') ;;
    *) die "unknown argument: $1 (expected --build)" ;;
esac

require_cmd "$NEAR_CLI"
require_var CONTRACT_ACCOUNT_ID

account_exists "$CONTRACT_ACCOUNT_ID" || die \
    "account $CONTRACT_ACCOUNT_ID does not exist; run ./scripts/create-testnet-account.sh first"

if [[ "$BUILD" -eq 1 || ! -f "$WASM_PATH" ]]; then
    "$(dirname "${BASH_SOURCE[0]}")/build.sh"
fi

[[ -f "$WASM_PATH" ]] || die "wasm not found at $WASM_PATH; run ./scripts/build.sh"
say "Deploying $WASM_PATH"
say "SHA-256: $(sha256_file "$WASM_PATH")"

if contract_is_initialized; then
    say "Existing initialized contract detected: upgrading code without init"
    "$NEAR_CLI" contract deploy "$CONTRACT_ACCOUNT_ID" use-file "$WASM_PATH" \
        without-init-call network-config "$NEAR_NETWORK" sign-with-keychain send
    say "Upgrade sent. Existing owner, treasury, balances and supplies are preserved."
    say "Run ./scripts/verify.sh --allow-distributed if tokens have already been distributed."
else
    require_var OWNER_ACCOUNT_ID
    require_var TREASURY_ACCOUNT_ID

    INIT_ARGS="$(printf '{"owner_id":"%s","treasury_id":"%s"}' \
        "$OWNER_ACCOUNT_ID" "$TREASURY_ACCOUNT_ID")"

    say "Fresh deployment: initializing owner=$OWNER_ACCOUNT_ID treasury=$TREASURY_ACCOUNT_ID"
    "$NEAR_CLI" contract deploy "$CONTRACT_ACCOUNT_ID" use-file "$WASM_PATH" \
        with-init-call new json-args "$INIT_ARGS" prepaid-gas 100Tgas \
        attached-deposit "0 NEAR" network-config "$NEAR_NETWORK" \
        sign-with-keychain send
    say "Deployment and initialization sent."
    say "Next: ./scripts/mint-genesis.sh"
fi
