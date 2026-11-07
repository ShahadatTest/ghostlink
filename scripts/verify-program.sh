#!/usr/bin/env bash
# Checks that a deployed program is exactly a local build.
#
#   scripts/verify-program.sh <path/to/program.so> <program-id> [rpc-url]
#
# Compares the executable hash of the local .so with the hash of the
# program data on chain. Uses solana-verify when installed (the tool the
# Solana verified-builds registry uses); otherwise computes the same
# value itself: SHA-256 of the program bytes with trailing zero padding
# removed, since on-chain program data is padded to its allocated size.
#
# For a reproducible build a third party can match, build in Docker:
#   solana-verify build --library-name ghostlink_pocket
# solana-verify picks its build image from [workspace.metadata.cli] in the
# root Cargo.toml or from --base-image; pin the Agave release CI builds with.
# Publish the commit; anyone then runs:
#   solana-verify verify-from-repo -u <rpc> --program-id <id> \
#     https://github.com/Ghostlink-Labs/ghostlink --commit-hash <commit> \
#     --library-name ghostlink_pocket --mount-path programs/pocket
#
# A match says nothing about who may upgrade the program next; check its
# upgrade authority with `solana program show <program-id>`.
set -euo pipefail

SO="${1:?usage: verify-program.sh <program.so> <program-id> [rpc-url]}"
PROGRAM_ID="${2:?usage: verify-program.sh <program.so> <program-id> [rpc-url]}"
RPC="${3:-https://api.devnet.solana.com}"
[ -f "$SO" ] || { echo "missing $SO" >&2; exit 1; }

# SHA-256 of a file's bytes after stripping trailing zero bytes.
trimmed_sha256() {
  python3 - "$1" <<'PY'
import hashlib, sys
data = open(sys.argv[1], "rb").read().rstrip(b"\x00")
print(hashlib.sha256(data).hexdigest())
PY
}

if command -v solana-verify >/dev/null 2>&1; then
  local_hash="$(solana-verify get-executable-hash "$SO")"
  chain_hash="$(solana-verify get-program-hash -u "$RPC" "$PROGRAM_ID")"
else
  tmp="$(mktemp)"
  trap 'rm -f "$tmp"' EXIT
  solana program dump -u "$RPC" "$PROGRAM_ID" "$tmp" >/dev/null
  local_hash="$(trimmed_sha256 "$SO")"
  chain_hash="$(trimmed_sha256 "$tmp")"
fi

echo "local:    $local_hash  ($SO)"
echo "on-chain: $chain_hash  ($PROGRAM_ID)"
if [ "$local_hash" = "$chain_hash" ]; then
  echo "MATCH: the deployed program is this build"
else
  echo "MISMATCH: the deployed program is not this build" >&2
  exit 1
fi
