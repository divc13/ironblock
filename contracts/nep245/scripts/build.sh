#!/usr/bin/env bash
# Build the release wasm used by the deployment scripts.
set -euo pipefail

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"

require_cmd cargo

if command -v rustup >/dev/null 2>&1; then
    rustup target add wasm32-unknown-unknown >/dev/null
fi

say "Building ironblock-nep245 release wasm"
cd "$CONTRACT_DIR"

if [[ -n "${RUSTFLAGS:-}" ]]; then
    export RUSTFLAGS="$RUSTFLAGS -C link-arg=-s"
else
    export RUSTFLAGS="-C link-arg=-s"
fi

cargo build --locked --target wasm32-unknown-unknown --release

[[ -f "$WASM_PATH" ]] || die "build finished but wasm was not found at $WASM_PATH"

say "Wasm: $WASM_PATH"
say "Size: $(file_size "$WASM_PATH") bytes"
say "SHA-256: $(sha256_file "$WASM_PATH")"
