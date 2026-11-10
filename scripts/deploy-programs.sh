#!/usr/bin/env bash
# Deploys registry, census and pocket for a deployment manifest with the
# operator's own keys, checks that each deployed program is exactly the
# local build, then creates the registry and census trees. See
# docs/DEPLOYMENTS.md; nothing here is run by CI or by the maintainers.
#
#   bash scripts/deploy-programs.sh --deployment <manifest.json> --keys <dir> \
#     --url <rpc> --payer <keypair.json> [--confirm <cluster>]
#
# Refuses, before sending anything:
# - a manifest naming any built-in program ID: those addresses are the
#   preserved V1 deployment on devnet, and no V2 build may replace them;
# - program keypairs in <dir> that are not the manifest's, a <dir> or payer
#   inside this checkout, or a payer that is one of the program keys;
# - programs not built for exactly this manifest
#   (scripts/build-programs.sh --deployment <manifest.json>);
# - an RPC whose genesis is not the manifest's cluster and genesis;
# - on devnet or mainnet-beta, a run without --confirm <cluster>.
#
# The payer pays for the deployment and becomes each program's upgrade
# authority. Deploying to an existing program ID upgrades it, which only its
# upgrade authority can do.
set -euo pipefail

usage() {
  echo "usage: scripts/deploy-programs.sh --deployment <manifest.json> --keys <dir> --url <rpc> --payer <keypair.json> [--confirm <cluster>]" >&2
  exit 2
}
MANIFEST="" KEYS="" URL="" PAYER="" CONFIRM=""
while [ "$#" -gt 0 ]; do
  [ "$#" -ge 2 ] || usage
  case "$1" in
    --deployment) MANIFEST="$(realpath "$2")" ;;
    --keys) KEYS="$(realpath "$2")" ;;
    --url) URL="$2" ;;
    --payer) PAYER="$(realpath "$2")" ;;
    --confirm) CONFIRM="$2" ;;
    *) usage ;;
  esac
  shift 2
done
[ -n "$MANIFEST" ] && [ -n "$KEYS" ] && [ -n "$URL" ] && [ -n "$PAYER" ] || usage
cd "$(dirname "$0")/.."

PLAN="$(node scripts/deployment.mjs deploy-check "$MANIFEST" --keys "$KEYS" --url "$URL" --payer "$PAYER")"
field() { sed -n "s/^$1 //p" <<< "$PLAN"; }
CLUSTER="$(field cluster)"
PROGRAMS="$(field programs)"
echo "== deployment plan =="
echo "$PLAN"
if [ "$CLUSTER" != localnet ] && [ "$CONFIRM" != "$CLUSTER" ]; then
  echo "This deploys to $CLUSTER with real fees. Review the plan above, then re-run with --confirm $CLUSTER." >&2
  exit 1
fi

for program in registry census pocket; do
  echo "== deploying $program =="
  solana program deploy --url "$URL" --keypair "$PAYER" \
    --program-id "$KEYS/$program.keypair.json" "$PROGRAMS/ghostlink_$program.so"
  bash scripts/verify-program.sh "$PROGRAMS/ghostlink_$program.so" "$(field "$program")" "$URL"
done

echo "== creating trees =="
node scripts/deployment.mjs initialize "$MANIFEST" --url "$URL" --payer "$PAYER"
echo "Deployed. Configure clients and services with GHOSTLINK_DEPLOYMENT=$MANIFEST (docs/DEPLOYMENTS.md)."
