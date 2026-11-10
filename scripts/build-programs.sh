#!/usr/bin/env bash
# Builds the programs.
#
#   bash scripts/build-programs.sh
#       Every binary the local validator and LiteSVM tests use, with the
#       committed (built-in) program IDs, into ${CARGO_TARGET_DIR:-target}/deploy.
#
#   bash scripts/build-programs.sh --deployment <manifest.json>
#       registry, census and pocket for a deployment manifest's own program
#       IDs (docs/DEPLOYMENTS.md). This checkout is never edited: the Rust
#       workspace is copied to ${CARGO_TARGET_DIR:-target}/deployments/<pocket
#       program ID>/src, the manifest's IDs are written into the copy and
#       checked, and the programs land in .../deploy beside a copy of the
#       manifest. A mainnet-beta manifest builds the registry with its
#       `mainnet` feature. Needs Node and a built @ghostlink/common.
set -euo pipefail
cd "$(dirname "$0")/.."
TOOLS="${PLATFORM_TOOLS:-v1.52}"

if [ "$#" -eq 0 ]; then
  for program in registry census pocket cpi-caller; do
    cargo-build-sbf --manifest-path "programs/$program/Cargo.toml" \
      --tools-version "$TOOLS"
  done
  exit 0
fi

if [ "$#" -ne 2 ] || [ "$1" != "--deployment" ]; then
  echo "usage: scripts/build-programs.sh [--deployment <manifest.json>]" >&2
  exit 2
fi
MANIFEST="$2"
# Validates the manifest and verifying keys, copies the workspace and rewrites the IDs.
WORK="$(node scripts/deployment.mjs prepare-build "$MANIFEST")"
CLUSTER="$(node scripts/deployment.mjs cluster "$MANIFEST")"
for program in registry census pocket; do
  features=()
  if [ "$program" = registry ] && [ "$CLUSTER" = mainnet-beta ]; then features=(--features mainnet); fi
  CARGO_TARGET_DIR="$WORK/target" cargo-build-sbf \
    --manifest-path "$WORK/src/programs/$program/Cargo.toml" \
    --tools-version "$TOOLS" --sbf-out-dir "$WORK/deploy" "${features[@]}"
done
node scripts/deployment.mjs stamp "$MANIFEST"
