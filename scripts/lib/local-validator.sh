# Sourced by scripts/test-census-fee.sh and scripts/selfhost-proof.sh: one
# solana-test-validator on a chosen RPC port, started in the background and
# stopped by stop_validator. Linux/WSL only.
#
#   start_validator <ledger dir> <rpc port> [solana-test-validator arguments...]
#       Refuses a port that already answers, starts the validator (its RPC
#       websocket takes the next port, its faucet the one after), waits up to
#       90 seconds for RPC and sets VALIDATOR_PID. Programs and accounts given
#       as arguments apply only to a new ledger; an existing ledger restarts
#       with its own state.
#   stop_validator
#       Stops the validator started here, if any.

VALIDATOR_PID=""

start_validator() {
  local ledger="$1" port="$2"
  shift 2
  local url="http://127.0.0.1:$port"
  # Never attach to a validator someone else started.
  if solana cluster-version -u "$url" >/dev/null 2>&1; then
    echo "RPC port $port already has a validator; stop it or choose another port" >&2
    return 1
  fi
  mkdir -p "$(dirname "$ledger")"
  solana-test-validator --quiet --ledger "$ledger" --rpc-port "$port" --faucet-port "$((port + 2))" "$@" >/dev/null 2>&1 &
  VALIDATOR_PID=$!
  local i
  for i in $(seq 1 90); do
    if ! kill -0 "$VALIDATOR_PID" 2>/dev/null; then
      VALIDATOR_PID=""
      echo "the validator stopped during startup; see $ledger/validator.log" >&2
      return 1
    fi
    if solana cluster-version -u "$url" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "the validator did not answer on $url within 90 seconds" >&2
  return 1
}

stop_validator() {
  if [ -n "${VALIDATOR_PID:-}" ]; then
    kill "$VALIDATOR_PID" 2>/dev/null || true
    wait "$VALIDATOR_PID" 2>/dev/null || true
    VALIDATOR_PID=""
  fi
}
