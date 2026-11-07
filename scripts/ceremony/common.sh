#!/usr/bin/env bash
# Shared settings and helpers for the phase-2 trusted-setup ceremony
# scripts. Sourced by the others, not run directly. Linux or WSL only.
#
# Phase 1 is the perpetual Powers of Tau (Hermez, 2^15): it fits circuits
# whose constraints plus public signals stay below 32,768. The file is
# pinned by the BLAKE2b digest published in the snarkjs README.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CIRCUITS=(login owner)
# The circom release CI installs (.github/workflows/ci.yml). A different
# compiler can produce a different r1cs, and with it different keys.
CIRCOM_VERSION="2.2.3"

PTAU_FILE="powersOfTau28_hez_final_15.ptau"
PTAU_URL="https://circom.info/$PTAU_FILE"
PTAU_B2SUM="982372c867d229c236091f767e703253249a9b432c1710b4f326306bfa2428a17b06240359606cfe4d580b10a5a1f63fbed499527069c18ae17060472969ae6e"

# The final beacon is hashed 2^10 times, the minimum snarkjs accepts.
BEACON_ITERATIONS_EXP=10

die() {
  echo "error: $*" >&2
  exit 1
}

SNARKJS_DIR="$REPO_ROOT/circuits/node_modules/snarkjs"
[ -f "$SNARKJS_DIR/cli.js" ] || die "missing the pinned snarkjs; run pnpm install --frozen-lockfile first"
snarkjs() { node "$SNARKJS_DIR/cli.js" "$@"; }
SNARKJS_VERSION="$(node -p 'require(process.argv[1]).version' "$SNARKJS_DIR/package.json")"

require_circom() {
  local want="${1:-$CIRCOM_VERSION}" got
  command -v circom >/dev/null || die "circom $want is not on PATH"
  got="$(circom --version)"
  [ "$got" = "circom compiler $want" ] || die "need circom $want, found \"$got\""
}

# compile_circuit <circuit> <out-dir> [circom flags]: compiles the circuit
# from this checkout, writing <out-dir>/<circuit>.r1cs and any extra outputs.
compile_circuit() {
  local c="$1" out="$2"
  shift 2
  mkdir -p "$out"
  circom "$REPO_ROOT/circuits/$c.circom" --r1cs "$@" -o "$out" -l "$REPO_ROOT/circuits/node_modules" >/dev/null
}

sha256_of() { sha256sum "$1" | cut -d' ' -f1; }

verify_ptau() {
  local file="$1" got
  [ -f "$file" ] || die "missing $file"
  got="$(b2sum "$file" | cut -d' ' -f1)"
  [ "$got" = "$PTAU_B2SUM" ] || die "$file does not match the published BLAKE2b digest (got $got)"
}

# fetch_ptau <dir>: downloads the phase-1 file into <dir> unless it is
# already there, and refuses it unless it matches the published digest.
fetch_ptau() {
  local dir="$1"
  if [ ! -f "$dir/$PTAU_FILE" ]; then
    echo "== downloading $PTAU_URL =="
    curl -fL --retry 3 -o "$dir/$PTAU_FILE.part" "$PTAU_URL"
    verify_ptau "$dir/$PTAU_FILE.part"
    mv "$dir/$PTAU_FILE.part" "$dir/$PTAU_FILE"
  fi
  verify_ptau "$dir/$PTAU_FILE"
}

# json_get <file> <dotted.key>: prints a string value from a JSON file.
json_get() {
  node -e '
    let v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    for (const k of process.argv[2].split(".")) v = v == null ? undefined : v[k];
    if (typeof v !== "string") { console.error(`${process.argv[2]} missing from ${process.argv[1]}`); process.exit(1); }
    console.log(v);' "$1" "$2"
}

# latest_index <dir> <circuit>: highest-numbered key, e.g. 0007, or nothing.
latest_index() {
  local dir="$1" c="$2" f last=""
  for f in "$dir/$c/${c}"_[0-9][0-9][0-9][0-9].zkey; do
    [ -e "$f" ] && last="$f"
  done
  [ -n "$last" ] || return 0
  last="${last##*_}"
  echo "${last%.zkey}"
}

sealed() {
  local c
  for c in "${CIRCUITS[@]}"; do
    [ ! -e "$1/$c/${c}_final.zkey" ] || return 0
  done
  return 1
}

strip_log() { sed -E 's/\x1b\[[0-9;]*m//g; s/^\[[A-Z]+\] +snarkJS: //'; }

# Reads snarkjs output on stdin and prints the 128-hex-digit hash that
# follows the first <title>, which snarkjs spreads over four indented lines.
hash_after() {
  strip_log | awk -v title="$1" '
    !found && index($0, title) == 1 { n = 4; next }
    n > 0 { gsub(/[ \t]/, ""); h = h $0; if (--n == 0) found = 1 }
    END { print h }'
}

# Reads `snarkjs zkey verify` output on stdin and prints one line per
# contribution in chain order, tab-separated:
#   <index> <contribution hash> <beacon hex or -> <iterations exp or -> <name>
parse_chain() {
  strip_log | awk '
    function flush() { if (cur != "") hash[cur] = h; cur = "" }
    /^contribution #[0-9]+/ {
      flush()
      rest = substr($0, 15)
      cur = rest; sub(/[^0-9].*$/, "", cur); cur += 0
      nm = rest; sub(/^[0-9]+ ?/, "", nm); sub(/:$/, "", nm)
      name[cur] = nm; beacon[cur] = "-"; iters[cur] = "-"; h = ""
      if (cur > max) max = cur
      next
    }
    cur != "" && /^[ \t]+[0-9a-f][0-9a-f ]*[ \t]*$/ { s = $0; gsub(/[ \t]/, "", s); h = h s; next }
    cur != "" && /^Beacon generator: / { beacon[cur] = $3; next }
    cur != "" && /^Beacon iterations Exp: / { iters[cur] = $4; next }
    /^-+$/ || /^ZKey Ok!/ { flush() }
    END {
      flush()
      for (i = 1; i <= max; i++) printf "%d\t%s\t%s\t%s\t%s\n", i, hash[i], beacon[i], iters[i], name[i]
    }'
}
