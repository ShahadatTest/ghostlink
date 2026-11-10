#!/usr/bin/env bash
# Proves the self-hosting runner end to end on a local validator: starts the
# five services through scripts/selfhost.sh as separate processes, waits for
# readiness and drives a real flow through their public HTTP APIs (register
# through the relayer, see it in the indexer, take a census snapshot and see
# the fee collected), shows the fee with the fee tool, then stops everything.
#
#   bash scripts/selfhost-proof.sh [<work directory>]
#
# The work directory (default ~/.ghostlink-selfhost-proof, outside the
# checkout) keeps the validator ledger, the upgrade authority keypair, the
# runner's configuration and its state. The first run starts a fresh validator
# with the programs and lets the runner initialize; a later run restarts the
# validator on the same ledger and the runner reuses its state. Delete the
# directory for a clean start.
#
# Linux/WSL after `bash scripts/build-programs.sh` (or `--deployment` for the
# manifest in GHOSTLINK_DEPLOYMENT, a localnet manifest) and
# `pnpm install --frozen-lockfile && pnpm -r build`. Ports: the validator RPC
# GHOSTLINK_TEST_RPC_PORT (default 18899, plus the next two) and the services
# from GHOSTLINK_TEST_PORT_BASE (default 28787, plus the next four, and each
# plus 10000 for the operator ports).
set -euo pipefail
WORK="$(realpath -m "${1:-$HOME/.ghostlink-selfhost-proof}")"
if [ -n "${GHOSTLINK_DEPLOYMENT:-}" ]; then GHOSTLINK_DEPLOYMENT="$(realpath "$GHOSTLINK_DEPLOYMENT")"; fi
cd "$(dirname "$0")/.."
. scripts/lib/local-validator.sh
case "$WORK/" in "$(pwd)/"*) echo "the work directory must be outside this checkout" >&2; exit 1 ;; esac

PORT="${GHOSTLINK_TEST_RPC_PORT:-18899}"
URL="http://127.0.0.1:$PORT"
BASE="${GHOSTLINK_TEST_PORT_BASE:-28787}"
CONFIG="$WORK/selfhost.env"
mkdir -p "$WORK"
chmod 700 "$WORK"

if [ -n "${GHOSTLINK_DEPLOYMENT:-}" ]; then
  [ "$(node scripts/deployment.mjs cluster "$GHOSTLINK_DEPLOYMENT")" = localnet ] || { echo "the proof needs a localnet deployment manifest" >&2; exit 1; }
  DEPLOY_DIR="$(node scripts/deployment.mjs artifacts "$GHOSTLINK_DEPLOYMENT")"
  SOURCE_MANIFEST="$GHOSTLINK_DEPLOYMENT"
else
  DEPLOY_DIR="${CARGO_TARGET_DIR:-target}/deploy"
  SOURCE_MANIFEST=""
fi
MANIFEST="$WORK/manifest.json"

FRESH=0
if [ ! -d "$WORK/ledger" ]; then
  FRESH=1
  [ ! -e "$WORK/state" ] || { echo "$WORK/state exists without a ledger: it belongs to another chain; use a new work directory" >&2; exit 1; }
  node scripts/deployment.mjs manifest $SOURCE_MANIFEST > "$MANIFEST"
  solana-keygen new --no-bip39-passphrase --silent --force --outfile "$WORK/authority.json" >/dev/null
else
  [ -z "$SOURCE_MANIFEST" ] || [ "$(node scripts/deployment.mjs manifest "$SOURCE_MANIFEST")" = "$(cat "$MANIFEST")" ] ||
    { echo "$WORK was made for another manifest; use a new work directory" >&2; exit 1; }
fi
read -r REGISTRY_ID CENSUS_ID POCKET_ID <<< "$(node scripts/deployment.mjs ids "$MANIFEST")"

cleanup() {
  [ ! -f "$CONFIG" ] || bash scripts/selfhost.sh stop --config "$CONFIG" || true
  stop_validator
}
trap cleanup EXIT

if [ "$FRESH" = 1 ]; then
  for program in registry census pocket; do
    [ -f "$DEPLOY_DIR/ghostlink_$program.so" ] || { echo "missing $DEPLOY_DIR/ghostlink_$program.so; build the programs first" >&2; exit 1; }
  done
  echo "== starting a fresh validator on $URL (ledger $WORK/ledger) =="
  # The census is upgradeable, as solana program deploy leaves it, so its fee has an authority.
  start_validator "$WORK/ledger" "$PORT" \
    --bpf-program "$REGISTRY_ID" "$DEPLOY_DIR/ghostlink_registry.so" \
    --upgradeable-program "$CENSUS_ID" "$DEPLOY_DIR/ghostlink_census.so" "$WORK/authority.json" \
    --bpf-program "$POCKET_ID" "$DEPLOY_DIR/ghostlink_pocket.so"
  solana airdrop 5 "$(solana-keygen pubkey "$WORK/authority.json")" -u "$URL" >/dev/null
  node scripts/deployment.mjs initialize "$MANIFEST" --url "$URL" --payer "$WORK/authority.json"
else
  echo "== restarting the validator on its ledger $WORK/ledger =="
  start_validator "$WORK/ledger" "$PORT"
fi

cat > "$CONFIG" <<EOF
# Written by scripts/selfhost-proof.sh.
GHOSTLINK_DEPLOYMENT=$MANIFEST
RPC_URL=$URL
GHOSTLINK_STATE_DIR=$WORK/state
INDEXER_PORT=$BASE
RELAYER_PORT=$((BASE + 1))
SOLVER_PORT=$((BASE + 2))
ACTIONS_PORT=$((BASE + 3))
WATCHER_PORT=$((BASE + 4))
INDEXER_POLL_MS=2000
WATCHER_POLL_MS=1000
EOF

echo "== starting the services (run $([ "$FRESH" = 1 ] && echo 1: fresh state || echo "2+: reusing $WORK/state")) =="
bash scripts/selfhost.sh start --config "$CONFIG"

echo "== funding the relayer and solver payers =="
for svc in relayer solver; do
  field=$([ "$svc" = relayer ] && echo payer || echo solver)
  address="$(node scripts/lib/selfhost.mjs field "$WORK/state/$svc/deployment.json" "scope.$field")"
  if [ "$(solana balance "$address" -u "$URL" --lamports | cut -d' ' -f1)" -lt 1000000000 ]; then
    solana airdrop 5 "$address" -u "$URL" >/dev/null
  fi
  echo "$svc payer $address funded"
done

echo "== waiting for readiness =="
bash scripts/selfhost.sh status --config "$CONFIG" --wait 300

echo "== driving the flow through the public HTTP APIs =="
RPC_URL="$URL" GHOSTLINK_DEPLOYMENT="$MANIFEST" \
  INDEXER_URL="http://127.0.0.1:$BASE" RELAYER_URL="http://127.0.0.1:$((BASE + 1))" SOLVER_URL="http://127.0.0.1:$((BASE + 2))" \
  ACTIONS_URL="http://127.0.0.1:$((BASE + 3))" WATCHER_URL="http://127.0.0.1:$((BASE + 4))" \
  node services/e2e/dist/selfhost-proof.js

echo "== the fee tool sees the collected fees =="
node scripts/deployment.mjs fee show "$MANIFEST" --url "$URL"

echo "== stopping =="
bash scripts/selfhost.sh stop --config "$CONFIG"
if bash scripts/selfhost.sh status --config "$CONFIG" > "$WORK/status-after-stop.txt"; then
  echo "a service still reports ready after stop" >&2; exit 1
fi
grep -q "running" "$WORK/status-after-stop.txt" && { echo "a service is still running after stop:" >&2; cat "$WORK/status-after-stop.txt" >&2; exit 1; }
stop_validator
echo "SELF-HOSTING PROOF PASSED ($([ "$FRESH" = 1 ] && echo "fresh state" || echo "reused state") in $WORK)"
