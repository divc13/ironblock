#!/usr/bin/env bash
# Shared helpers for the NEP-245 deployment scripts.
#
# This file is sourced by the other scripts. It loads contracts/nep245/.env when
# present. The .env file is git-ignored and must contain account IDs only; keys
# live in the near-cli-rs keychain or another signer.

set -euo pipefail

_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACT_DIR="$(cd "$_SCRIPT_DIR/.." && pwd)"

if [[ -f "$CONTRACT_DIR/.env" ]]; then
    set -a
    # shellcheck disable=SC1091
    . "$CONTRACT_DIR/.env"
    set +a
fi

NEAR_CLI="${NEAR_CLI:-near}"
NEAR_NETWORK="${NEAR_NETWORK:-testnet}"
CONTRACT_ACCOUNT_ID="${CONTRACT_ACCOUNT_ID:-}"
OWNER_ACCOUNT_ID="${OWNER_ACCOUNT_ID:-$CONTRACT_ACCOUNT_ID}"
TREASURY_ACCOUNT_ID="${TREASURY_ACCOUNT_ID:-}"
WASM_PATH="${WASM_PATH:-$CONTRACT_DIR/target/wasm32-unknown-unknown/release/ironblock_nep245.wasm}"

# Treat a relative WASM_PATH as relative to the contract directory, not the
# caller's current working directory.
case "$WASM_PATH" in
    /*) ;;
    *) WASM_PATH="$CONTRACT_DIR/$WASM_PATH" ;;
esac

say() {
    printf '==> %s\n' "$*"
}

warn() {
    printf 'warning: %s\n' "$*" >&2
}

die() {
    printf 'error: %s\n' "$*" >&2
    exit 1
}

require_cmd() {
    command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

# require_var takes the *name* of a variable, so it never echoes the value.
require_var() {
    local name="$1"
    local value
    eval "value=\${$name:-}"
    [[ -n "$value" ]] || die "missing $name; copy .env.example to .env and set it"
}

account_exists() {
    "$NEAR_CLI" account view-account-summary "$1" \
        network-config "$NEAR_NETWORK" now >/dev/null 2>&1
}

# Read-only contract call with stable, parseable JSON output.
near_call_view() {
    local method="$1"
    local args="${2:-}"
    [[ -n "$args" ]] || args='{}'
    "$NEAR_CLI" --quiet contract call-function as-read-only "$CONTRACT_ACCOUNT_ID" \
        "$method" json-args "$args" network-config "$NEAR_NETWORK" now
}

# Transaction call. The caller must already have the signer key in the
# near-cli-rs keychain.
near_call_tx() {
    local method="$1"
    local args="$2"
    local gas="${3:-100Tgas}"
    local deposit="${4:-0 NEAR}"
    local signer="$5"
    "$NEAR_CLI" contract call-function as-transaction "$CONTRACT_ACCOUNT_ID" \
        "$method" json-args "$args" prepaid-gas "$gas" attached-deposit "$deposit" \
        sign-as "$signer" network-config "$NEAR_NETWORK" sign-with-keychain send
}

contract_is_initialized() {
    near_call_view get_config '{}' >/dev/null 2>&1
}

sha256_file() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print $1}'
    else
        shasum -a 256 "$1" | awk '{print $1}'
    fi
}

file_size() {
    wc -c <"$1" | tr -d ' '
}

explorer_tx_url() {
    case "$NEAR_NETWORK" in
        testnet*) printf 'https://explorer.testnet.near.org/transactions/%s\n' "$1" ;;
        mainnet*) printf 'https://explorer.near.org/transactions/%s\n' "$1" ;;
        *) printf '(no explorer mapping for network %s)\n' "$NEAR_NETWORK" ;;
    esac
}
