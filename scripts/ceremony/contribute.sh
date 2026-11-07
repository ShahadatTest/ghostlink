#!/usr/bin/env bash
# Adds one contribution to every circuit in a ceremony directory.
#
#   scripts/ceremony/contribute.sh <ceremony-dir> "<your name or handle>"
#
# Entropy comes from the OS (/dev/urandom) plus anything you type at the
# prompt, and snarkjs mixes in 64 more bytes from the OS. It reaches snarkjs
# through a pipe: it is never written to disk, never printed and never put
# on a command line, where other users of the machine could read it. The
# final keys are secure as long as ONE contributor's entropy is destroyed,
# so contribute on a machine you trust and close the terminal afterwards.
#
# You need manifest.json and the latest <circuit>/<circuit>_NNNN.zkey of
# each circuit, not circom. It writes the next key of each circuit and
# attestations/NNNN-<name>.txt with your contribution hashes.
source "$(dirname "$0")/common.sh"

DIR="${1:?usage: contribute.sh <ceremony-dir> <name>}"
NAME="${2:?usage: contribute.sh <ceremony-dir> <name>}"
[[ "$NAME" =~ ^[A-Za-z0-9\ ._@-]{1,64}$ ]] || die "name may only use letters, digits, space . _ @ - (max 64)"
[ "$NAME" != "Final beacon" ] || die "that name is reserved for the final beacon"
[ -f "$DIR/manifest.json" ] || die "$DIR/manifest.json missing; ask the coordinator for the ceremony files"
COMMIT="$(json_get "$DIR/manifest.json" commit)"
! sealed "$DIR" || die "this ceremony is already sealed; contributions are closed"

# Every circuit gets the same contribution number.
prev=""
for c in "${CIRCUITS[@]}"; do
  p="$(latest_index "$DIR" "$c")"
  [ -n "$p" ] || die "no key for $c in $DIR"
  [ -z "$prev" ] || [ "$p" = "$prev" ] || die "circuits are out of step ($c is at $p, ${CIRCUITS[0]} at $prev)"
  prev="$p"
done
next="$(printf '%04d' $((10#$prev + 1)))"
ATTEST="$DIR/attestations/$next-${NAME// /_}.txt"
mkdir -p "$DIR/attestations"
[ ! -e "$ATTEST" ] || die "$ATTEST already exists"

extra=""
if [ -t 0 ]; then
  read -r -s -p "Optional: type random characters, then Enter: " extra
  echo >&2
fi

tmp=()
trap 'rm -f "${tmp[@]}"' EXIT
hashes=()
for c in "${CIRCUITS[@]}"; do
  echo "== contribution $next to $c =="
  new="$DIR/$c/${c}_$next.zkey.partial"
  tmp+=("$new")
  # snarkjs reads the entropy from stdin when no -e is given. Its stdout is
  # captured, so readline treats it as a non-terminal and echoes nothing.
  if ! out="$(printf '%s%s\n' \
      "$(head -c 64 /dev/urandom | sha512sum | cut -d' ' -f1)" \
      "$(printf '%s' "$extra" | sha512sum | cut -d' ' -f1)" \
      | snarkjs zkey contribute "$DIR/$c/${c}_$prev.zkey" "$new" --name="$NAME" 2>&1)"; then
    printf '%s\n' "$out" | strip_log >&2
    die "snarkjs could not contribute to $c"
  fi
  hash="$(printf '%s\n' "$out" | hash_after "Contribution Hash:")"
  [[ "$hash" =~ ^[0-9a-f]{128}$ ]] && [ -s "$new" ] || {
    printf '%s\n' "$out" | strip_log >&2
    die "snarkjs did not report a contribution hash for $c"
  }
  hashes+=("$hash")
done
unset extra

# Publish all new keys together, so the circuits never drift apart.
for c in "${CIRCUITS[@]}"; do
  mv "$DIR/$c/${c}_$next.zkey.partial" "$DIR/$c/${c}_$next.zkey"
done
{
  echo "GhostLink phase-2 ceremony attestation"
  echo "contributor: $NAME"
  echo "utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "circuits commit: $COMMIT"
  for i in "${!CIRCUITS[@]}"; do
    echo "contribution ${CIRCUITS[$i]} $((10#$next)) ${hashes[$i]}"
  done
} > "$ATTEST"

echo
cat "$ATTEST"
echo
echo "Done. Send the coordinator the two new keys and $ATTEST."
echo "Publish that attestation yourself (a signed commit, a gist, a post), check"
echo "that your hashes appear in the published transcript, and close this terminal."
