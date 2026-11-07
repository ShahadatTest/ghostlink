#!/usr/bin/env bash
# Starts a phase-2 ceremony in <dir>: downloads and checks the perpetual
# Powers of Tau, compiles both circuits from this checkout, and writes the
# initial keys plus a manifest anyone can reproduce.
#
#   scripts/ceremony/init.sh <ceremony-dir>
#
# Run on Linux/WSL with the circom release pinned in common.sh, from the
# frozen (audited) circuit commit: any later change to a .circom file voids
# the ceremony. Keep <dir> outside the repository; its keys are never
# committed.
#
# The initial <circuit>_0000.zkey files have no phase-2 contribution, so
# delta equals gamma and anyone could forge proofs with them. They are only
# the starting point: finalize.sh refuses to seal a chain without the
# required contributions.
source "$(dirname "$0")/common.sh"

DIR="${1:?usage: init.sh <ceremony-dir>}"
require_circom
mkdir -p "$DIR"
DIR="$(cd "$DIR" && pwd)"
case "$DIR/" in
  "$REPO_ROOT/"*) die "keep the ceremony directory outside the repository ($REPO_ROOT)" ;;
esac
[ ! -e "$DIR/manifest.json" ] || die "$DIR already holds a ceremony"
for c in "${CIRCUITS[@]}"; do
  case "$(latest_index "$DIR" "$c")" in
    "" | 0000) ;;
    *) die "$DIR already holds contributions" ;;
  esac
done

# The manifest names the commit everyone recompiles, so the circuits must
# be exactly what that commit contains.
sources=(circuits/lib)
for c in "${CIRCUITS[@]}"; do sources+=("circuits/$c.circom"); done
changes="$(git -C "$REPO_ROOT" status --porcelain -- "${sources[@]}")"
[ -z "$changes" ] || die "commit the circuit sources first: ${sources[*]} have local changes"
COMMIT="$(git -C "$REPO_ROOT" rev-parse HEAD)"

fetch_ptau "$DIR"
echo "phase 1 ok: $PTAU_FILE matches the BLAKE2b digest published by snarkjs"

hashes=()
for c in "${CIRCUITS[@]}"; do
  echo "== compiling $c =="
  compile_circuit "$c" "$DIR/$c" --wasm
  snarkjs r1cs info "$DIR/$c/$c.r1cs" | strip_log | grep -E "Constraints|Public Inputs|Outputs" || true
  hashes+=("$c" "$(sha256_of "$DIR/$c/$c.r1cs")")
  echo "== initial key for $c =="
  out="$(snarkjs groth16 setup "$DIR/$c/$c.r1cs" "$DIR/$PTAU_FILE" "$DIR/$c/${c}_0000.zkey" 2>&1)"
  # snarkjs logs some setup failures (a circuit too big for the Powers of
  # Tau, for one) and still exits 0.
  if [[ "$out" == *ERROR* ]] || [ ! -s "$DIR/$c/${c}_0000.zkey" ]; then
    printf '%s\n' "$out" | strip_log >&2
    die "groth16 setup failed for $c"
  fi
done
mkdir -p "$DIR/attestations"

node -e '
  const [file, commit, circom, snarkjs, ptauFile, ptauUrl, ptauB2, ...pairs] = process.argv.slice(1);
  const circuits = {};
  for (let i = 0; i < pairs.length; i += 2) circuits[pairs[i]] = { r1cs_sha256: pairs[i + 1] };
  const manifest = { commit, circom, snarkjs, ptau: { file: ptauFile, url: ptauUrl, blake2b: ptauB2 }, circuits };
  require("fs").writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
' "$DIR/manifest.json" "$COMMIT" "$CIRCOM_VERSION" "$SNARKJS_VERSION" "$PTAU_FILE" "$PTAU_URL" "$PTAU_B2SUM" "${hashes[@]}"

echo "== initialized =="
cat "$DIR/manifest.json"
echo "Anyone can check out $COMMIT, compile with circom $CIRCOM_VERSION and compare the r1cs hashes above."
