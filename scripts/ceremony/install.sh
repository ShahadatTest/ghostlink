#!/usr/bin/env bash
# Installs a sealed ceremony's keys into this checkout, in the places
# scripts/build-circuits.sh fills with throwaway keys:
#
#   scripts/ceremony/install.sh <ceremony-dir> <min-contributions>
#
#   circuits/keys/<circuit>_vk.json      verifying keys            committed
#   packages/verify/keys/login_vk.json   server login key          committed
#   circuits/keys/*proof*.json, owner_actions.json  fixture proofs committed
#   programs/verifier/src/vks/*_vk.rs    Rust verifying keys       committed
#   circuits/build/<circuit>_final.zkey, <circuit>_js/, .r1cs, .sym   ignored
#
# It verifies the sealed ceremony first and recompiles the circuits from
# this checkout. Proving code reads circuits/build/<circuit>_dev.zkey unless
# GHOSTLINK_ZKEY_SUFFIX=final is set, so the stale dev keys are deleted.
#
# Installing is a protocol change: every existing proof stops verifying,
# and the programs must be rebuilt and redeployed with the new keys.
source "$(dirname "$0")/common.sh"

usage="usage: install.sh <ceremony-dir> <min-contributions>"
DIR="${1:?$usage}"
MIN="${2:?$usage}"
command -v cargo >/dev/null || die "cargo is needed to regenerate the Rust verifying keys"
[ -f "$REPO_ROOT/packages/common/dist/index.js" ] \
  || die "build @ghostlink/common first: pnpm --filter @ghostlink/common build"

"$(dirname "$0")/verify.sh" "$DIR" "$MIN" final

BUILD="$REPO_ROOT/circuits/build"
for c in "${CIRCUITS[@]}"; do
  echo "== installing $c =="
  compile_circuit "$c" "$BUILD" --wasm --sym
  [ "$(sha256_of "$BUILD/$c.r1cs")" = "$(json_get "$DIR/manifest.json" "circuits.$c.r1cs_sha256")" ] \
    || die "$c: the compiled r1cs changed since verification"
  cp "$DIR/$c/${c}_final.zkey" "$BUILD/${c}_final.zkey"
  rm -f "$BUILD/${c}_dev.zkey"
  cp "$DIR/final/${c}_vk.json" "$REPO_ROOT/circuits/keys/${c}_vk.json"
done
cp "$REPO_ROOT/circuits/keys/login_vk.json" "$REPO_ROOT/packages/verify/keys/login_vk.json"

echo "== proving the fixture inputs with the ceremony keys =="
(cd "$REPO_ROOT" && GHOSTLINK_ZKEY_SUFFIX=final node circuits/scripts/prove-fixtures.mjs)

echo "== regenerating the Rust verifying keys =="
(cd "$REPO_ROOT" && cargo run --quiet -p ghostlink-verifier --bin gen-vk --features circom-vk)

echo "Installed. Run the test suites with GHOSTLINK_ZKEY_SUFFIX=final, rebuild"
echo "the programs, and commit the changed keys and fixtures together."
