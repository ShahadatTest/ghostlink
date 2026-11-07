#!/usr/bin/env bash
# Seals a ceremony with a public random beacon and exports its verifying
# keys.
#
#   scripts/ceremony/finalize.sh <ceremony-dir> <min-contributions> <beacon-hex> [--install]
#
# Announce the beacon's source before the last contribution closes, for
# example a future drand round or the Solana block hash at a named future
# slot, so nobody (the coordinator and the last contributor included) can
# know or pick it while contributions are open. Pass its value as 64 hex
# characters; it is hashed 2^10 times.
#
# Refuses to seal unless verify.sh accepts the open chain with at least
# <min-contributions> attested contributions. Writes <circuit>_final.zkey,
# final/<circuit>_vk.json, beacon.txt and the sealed TRANSCRIPT.md, then
# verifies the result. --install then runs install.sh on this checkout.
source "$(dirname "$0")/common.sh"

usage="usage: finalize.sh <ceremony-dir> <min-contributions> <beacon-hex> [--install]"
DIR="${1:?$usage}"
MIN="${2:?$usage}"
BEACON="${3:?$usage}"
INSTALL="${4:-}"
[[ "$BEACON" =~ ^[0-9a-fA-F]{64}$ ]] || die "the beacon must be 32 bytes written as 64 hex characters"
BEACON="${BEACON,,}"
case "$INSTALL" in "" | --install) ;; *) die "$usage" ;; esac
! sealed "$DIR" || die "$DIR is already sealed"
HERE="$(dirname "$0")"

"$HERE/verify.sh" "$DIR" "$MIN"

partial=()
trap 'rm -f "${partial[@]}"' EXIT
for c in "${CIRCUITS[@]}"; do
  prev="$(latest_index "$DIR" "$c")"
  echo "== $c: sealing ${c}_$prev.zkey with the beacon =="
  out="$DIR/$c/${c}_final.zkey.partial"
  partial+=("$out")
  # snarkjs logs a rejected beacon and still exits 0.
  log="$(snarkjs zkey beacon "$DIR/$c/${c}_$prev.zkey" "$out" "$BEACON" "$BEACON_ITERATIONS_EXP" --name="Final beacon" 2>&1)"
  if [[ "$log" == *ERROR* ]] || [ ! -s "$out" ]; then
    printf '%s\n' "$log" | strip_log >&2
    die "snarkjs could not apply the beacon to $c"
  fi
done

mkdir -p "$DIR/final"
for c in "${CIRCUITS[@]}"; do
  mv "$DIR/$c/${c}_final.zkey.partial" "$DIR/$c/${c}_final.zkey"
  snarkjs zkey export verificationkey "$DIR/$c/${c}_final.zkey" "$DIR/final/${c}_vk.json" >/dev/null
done
echo "$BEACON" > "$DIR/beacon.txt"
# The open-ceremony transcript; verify.sh writes the sealed one.
rm -f "$DIR/TRANSCRIPT.md"
"$HERE/verify.sh" "$DIR" "$MIN" final

echo "Sealed. Publish manifest.json, beacon.txt, attestations/, TRANSCRIPT.md,"
echo "final/ and the <circuit>_final.zkey files; never commit the keys."
if [ "$INSTALL" = --install ]; then
  "$HERE/install.sh" "$DIR" "$MIN"
fi
