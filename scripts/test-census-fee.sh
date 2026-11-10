#!/usr/bin/env bash
# Tests the census snapshot fee tool (node scripts/deployment.mjs fee ...)
# against a disposable local validator whose census program is upgradeable,
# as `solana program deploy` leaves it: show, set (including zero), withdraw
# and every refusal the tool promises before it sends anything.
#
# Linux/WSL, from any directory, after:
#   bash scripts/build-programs.sh        (default build: the built-in IDs)
#   pnpm install --frozen-lockfile && pnpm -r build
# GHOSTLINK_TEST_RPC_PORT picks the validator's RPC port (default 18899; it
# also uses the next two ports). Everything it creates lives in a temporary
# directory outside the checkout and is removed on exit.
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/lib/local-validator.sh

PORT="${GHOSTLINK_TEST_RPC_PORT:-18899}"
URL="http://127.0.0.1:$PORT"
DEPLOY_DIR="${CARGO_TARGET_DIR:-target}/deploy"
for program in registry census pocket; do
  [ -f "$DEPLOY_DIR/ghostlink_$program.so" ] || { echo "missing $DEPLOY_DIR/ghostlink_$program.so; run scripts/build-programs.sh" >&2; exit 1; }
done

WORK="$(mktemp -d "${TMPDIR:-/tmp}/ghostlink-fee-test.XXXXXX")"
trap 'stop_validator; rm -rf "$WORK"' EXIT
solana-keygen new --no-bip39-passphrase --silent --outfile "$WORK/authority.json" >/dev/null
solana-keygen new --no-bip39-passphrase --silent --outfile "$WORK/other.json" >/dev/null
AUTHORITY="$(solana-keygen pubkey "$WORK/authority.json")"
OTHER="$(solana-keygen pubkey "$WORK/other.json")"
MANIFEST="$WORK/manifest.json"
node scripts/deployment.mjs manifest > "$MANIFEST"
# The same deployment pinned to a chain that is not this validator's.
node -e 'const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); m.genesisHash = process.argv[2]; console.log(JSON.stringify(m));' \
  "$MANIFEST" "$OTHER" > "$WORK/pinned-elsewhere.json"
read -r REGISTRY_ID CENSUS_ID POCKET_ID <<< "$(node scripts/deployment.mjs ids "$MANIFEST")"

echo "== starting validator on $URL =="
start_validator "$WORK/ledger" "$PORT" --reset \
  --bpf-program "$REGISTRY_ID" "$DEPLOY_DIR/ghostlink_registry.so" \
  --upgradeable-program "$CENSUS_ID" "$DEPLOY_DIR/ghostlink_census.so" "$WORK/authority.json" \
  --bpf-program "$POCKET_ID" "$DEPLOY_DIR/ghostlink_pocket.so"
solana airdrop 10 "$AUTHORITY" -u "$URL" >/dev/null
solana airdrop 10 "$OTHER" -u "$URL" >/dev/null

PASSED=0
# check <ok|fail> <extended regex the output must match> <command...>
check() {
  local want="$1" pattern="$2" output status=0
  shift 2
  output="$("$@" 2>&1)" || status=$?
  if { [ "$want" = ok ] && [ "$status" -ne 0 ]; } || { [ "$want" = fail ] && [ "$status" -eq 0 ]; } || ! grep -qE -- "$pattern" <<< "$output"; then
    echo "FAILED: expected $want matching /$pattern/ from: $*" >&2
    echo "exit $status, output:" >&2
    echo "$output" >&2
    exit 1
  fi
  PASSED=$((PASSED + 1))
  echo "ok $PASSED: $want /$pattern/"
}
fee() { node scripts/deployment.mjs fee "$@"; }
balance() { solana balance "$1" -u "$URL" --lamports | cut -d' ' -f1; }

echo "== refusals before the trees exist =="
check fail "the census tree is not initialized" fee show "$MANIFEST" --url "$URL"
check fail "usage: fee show" fee show "$MANIFEST" --url "$URL" --authority "$WORK/authority.json"
check fail "usage: fee show" fee set "$MANIFEST" 5 --url "$URL"

node scripts/deployment.mjs initialize "$MANIFEST" --url "$URL" --payer "$WORK/authority.json"

echo "== show =="
check ok "fee +100000 lamports per snapshot" fee show "$MANIFEST" --url "$URL"
check ok "authority +$AUTHORITY" fee show "$MANIFEST" --url "$URL"
VAULT="$(fee show "$MANIFEST" --url "$URL" | sed -n 's/^vault  *\([1-9A-HJ-NP-Za-km-z]*\):.*/\1/p')"
[ -n "$VAULT" ] || { echo "FAILED: no vault address in fee show" >&2; exit 1; }

echo "== guards =="
check fail "the upgrade authority keypair must be outside this checkout" fee set "$MANIFEST" 0 --url "$URL" --authority "$(pwd)/authority.json"
check fail "is $OTHER, not the census upgrade authority $AUTHORITY" fee set "$MANIFEST" 0 --url "$URL" --authority "$WORK/other.json"
check fail "--confirm devnet does not match the manifest's cluster localnet" fee set "$MANIFEST" 0 --url "$URL" --authority "$WORK/authority.json" --confirm devnet
check fail "does not match the deployment genesis" fee set "$WORK/pinned-elsewhere.json" 0 --url "$URL" --authority "$WORK/authority.json"
check fail "is not a whole number of lamports" fee set "$MANIFEST" 1.5 --url "$URL" --authority "$WORK/authority.json"
check fail "cannot reach" fee show "$MANIFEST" --url "http://127.0.0.1:$((PORT + 5))"
check ok "fee +100000 lamports" fee show "$MANIFEST" --url "$URL"

echo "== set =="
check ok "a zero fee removes the spam cost" fee set "$MANIFEST" 0 --url "$URL" --authority "$WORK/authority.json"
check ok "fee +0 lamports per snapshot" fee show "$MANIFEST" --url "$URL"
check ok "already 0 lamports; nothing to send" fee set "$MANIFEST" 0 --url "$URL" --authority "$WORK/authority.json"
check ok "relayers refuse fees above RELAYER_MAX_SNAPSHOT_FEE_LAMPORTS" fee set "$MANIFEST" 2000000 --url "$URL" --authority "$WORK/authority.json"
check ok "fee +250000 lamports per snapshot" fee set "$MANIFEST" 250000 --url "$URL" --authority "$WORK/authority.json"

echo "== withdraw =="
check fail "nothing to withdraw" fee withdraw "$MANIFEST" all --to "$OTHER" --url "$URL" --authority "$WORK/authority.json"
# Lamports sent to the vault stand in for collected snapshot fees.
solana transfer --allow-unfunded-recipient -u "$URL" --keypair "$WORK/other.json" "$VAULT" 0.001 >/dev/null
check ok "1000000 withdrawable above rent" fee show "$MANIFEST" --url "$URL"
check fail "only 1000000 lamports are withdrawable" fee withdraw "$MANIFEST" 1000001 --to "$OTHER" --url "$URL" --authority "$WORK/authority.json"
check fail "is not a base58 address" fee withdraw "$MANIFEST" 5 --to "not-an-address" --url "$URL" --authority "$WORK/authority.json"
check fail "must not be the fee vault itself" fee withdraw "$MANIFEST" 5 --to "$VAULT" --url "$URL" --authority "$WORK/authority.json"
before="$(balance "$OTHER")"
check ok "600000 withdrawable above rent" fee withdraw "$MANIFEST" 400000 --to "$OTHER" --url "$URL" --authority "$WORK/authority.json"
[ "$(( $(balance "$OTHER") - before ))" -eq 400000 ] || { echo "FAILED: the recipient did not gain 400000 lamports" >&2; exit 1; }
check ok " 0 withdrawable above rent" fee withdraw "$MANIFEST" all --to "$OTHER" --url "$URL" --authority "$WORK/authority.json"
[ "$(( $(balance "$OTHER") - before ))" -eq 1000000 ] || { echo "FAILED: the recipient did not gain 1000000 lamports in total" >&2; exit 1; }

echo "== immutable program =="
solana program set-upgrade-authority "$CENSUS_ID" --final --upgrade-authority "$WORK/authority.json" --keypair "$WORK/authority.json" -u "$URL" >/dev/null
check ok "authority +none \(immutable program" fee show "$MANIFEST" --url "$URL"
check fail "the census program is immutable" fee set "$MANIFEST" 0 --url "$URL" --authority "$WORK/authority.json"

echo "census fee tool: $PASSED checks passed"
