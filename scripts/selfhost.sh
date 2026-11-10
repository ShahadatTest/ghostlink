#!/usr/bin/env bash
# Runs the five GhostLink services (indexer, relayer, solver, Actions and
# watcher) as separate processes for one deployment manifest and one RPC.
# State, keys, logs and process IDs live in a directory outside this checkout.
# See docs/SELF-HOSTING.md. Linux or WSL, Node 22.16+ and a built checkout
# (pnpm install --frozen-lockfile && pnpm -r build).
#
#   bash scripts/selfhost.sh init   --config <file>   create service state (first run only)
#   bash scripts/selfhost.sh start  --config <file>   init if needed, start, wait for each /health
#   bash scripts/selfhost.sh status --config <file> [--wait <seconds>]
#                                   print each service's readiness; exit 0 only when all are ready
#   bash scripts/selfhost.sh stop   --config <file>   SIGTERM each service and wait for it to drain
#
# The configuration file holds KEY=VALUE lines (scripts/selfhost.env.example
# explains every key). It is read, never executed. Each service receives only
# its own variables, in an otherwise empty environment.
set -euo pipefail
umask 077
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ALL_SERVICES="indexer relayer solver actions watcher"

usage() {
  echo "usage: bash scripts/selfhost.sh <init|start|status|stop> --config <file> [--wait <seconds>] (status only)" >&2
  exit 2
}
die() { echo "selfhost: $*" >&2; exit 1; }

COMMAND="${1:-}"
[ "$#" -gt 0 ] && shift
CONFIG="" WAIT=""
while [ "$#" -gt 0 ]; do
  [ "$#" -ge 2 ] || usage
  case "$1" in
    --config) CONFIG="$2" ;;
    --wait) WAIT="$2" ;;
    *) usage ;;
  esac
  shift 2
done
case "$COMMAND" in init|start|status|stop) ;; *) usage ;; esac
[ -n "$CONFIG" ] || usage
[ -z "$WAIT" ] || { [ "$COMMAND" = status ] && [[ "$WAIT" =~ ^[0-9]+$ ]]; } || usage

# ---- configuration -----------------------------------------------------------

declare -A CFG=()
[ -f "$CONFIG" ] || die "cannot read the configuration file $CONFIG"
line_number=0
while IFS= read -r line || [ -n "$line" ]; do
  line_number=$((line_number + 1))
  line="${line%$'\r'}"
  [[ "$line" =~ ^[[:space:]]*(#.*)?$ ]] && continue
  [[ "$line" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]] || die "$CONFIG line $line_number is not KEY=VALUE"
  key="${BASH_REMATCH[1]}" value="${BASH_REMATCH[2]}"
  if [ "${#value}" -ge 2 ]; then
    first="${value:0:1}" last="${value: -1}"
    if { [ "$first" = '"' ] || [ "$first" = "'" ]; } && [ "$first" = "$last" ]; then value="${value:1:${#value}-2}"; fi
  fi
  case "$value" in "~/"*) value="$HOME/${value:2}" ;; esac
  CFG[$key]="$value"
done < "$CONFIG"
cfg() { printf '%s' "${CFG[$1]:-${2:-}}"; }

NODE="$(command -v node)" || die "node is not on PATH; install Node 22.16 or later"
"$NODE" -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 16) ? 0 : 1)' ||
  die "Node $("$NODE" --version) is too old; the services need 22.16 or later"
helper() { "$NODE" "$ROOT/scripts/lib/selfhost.mjs" "$@"; }

MANIFEST="$(cfg GHOSTLINK_DEPLOYMENT)"
[ -n "$MANIFEST" ] || die "GHOSTLINK_DEPLOYMENT is required: the path of your deployment manifest (docs/DEPLOYMENTS.md)"
[ -f "$MANIFEST" ] || die "GHOSTLINK_DEPLOYMENT: $MANIFEST does not exist"
MANIFEST="$(realpath "$MANIFEST")"
CLUSTER="$("$NODE" "$ROOT/scripts/deployment.mjs" cluster "$MANIFEST")" || exit 1
[ -n "$(cfg RPC_URL)$(cfg RPC_ENDPOINTS_PATH)" ] || die "RPC_URL or RPC_ENDPOINTS_PATH is required"

STATE="$(cfg GHOSTLINK_STATE_DIR)"
[ -n "$STATE" ] || die "GHOSTLINK_STATE_DIR is required: a directory outside this checkout for state, keys and logs"
STATE="$(realpath -m "$STATE")"
case "$STATE/" in "$(realpath "$ROOT")/"*) die "GHOSTLINK_STATE_DIR must be outside this checkout ($ROOT): it holds keys" ;; esac

SERVICES="$(cfg SERVICES "$ALL_SERVICES")"
for svc in $SERVICES; do
  case " $ALL_SERVICES " in *" $svc "*) ;; *) die "SERVICES: unknown service $svc (choose from: $ALL_SERVICES)" ;; esac
  [ -f "$ROOT/services/$svc/dist/index.js" ] || die "services/$svc is not built; run pnpm install --frozen-lockfile && pnpm -r build"
done
WATCHER_MODE="$(cfg WATCHER_MODE observer)"
case "$WATCHER_MODE" in observer|funded) ;; *) die "WATCHER_MODE must be observer or funded" ;; esac

port_of() {
  case "$1" in
    indexer) cfg INDEXER_PORT 8787 ;;
    relayer) cfg RELAYER_PORT 8788 ;;
    solver) cfg SOLVER_PORT 8789 ;;
    actions) cfg ACTIONS_PORT 8790 ;;
    watcher) cfg WATCHER_PORT 8791 ;;
  esac
}
url_of() { printf 'http://127.0.0.1:%s' "$(port_of "$1")"; }
genesis_variable() { case "$1" in actions) echo ACTIONS_GENESIS_HASH ;; *) echo "$(tr '[:lower:]' '[:upper:]' <<< "$1")_GENESIS_HASH" ;; esac; }

for svc in $ALL_SERVICES; do
  [[ "$(port_of "$svc")" =~ ^[1-9][0-9]{0,4}$ ]] && [ "$(port_of "$svc")" -le 55535 ] ||
    die "$(tr "[:lower:]" "[:upper:]" <<< "$svc")_PORT must be a port number up to 55535 (its operations port defaults to 10000 above it)"
done

# ---- state -------------------------------------------------------------------

# The deployment and chain this state directory belongs to, fixed at the first init.
bind_state() {
  mkdir -p "$STATE/logs" "$STATE/run"
  chmod 700 "$STATE"
  local canonical
  canonical="$("$NODE" "$ROOT/scripts/deployment.mjs" manifest "$MANIFEST")" || exit 1
  if [ -f "$STATE/manifest.json" ]; then
    [ "$canonical" = "$(cat "$STATE/manifest.json")" ] ||
      die "$STATE holds state for a different deployment manifest ($STATE/manifest.json); use another GHOSTLINK_STATE_DIR"
  else
    printf '%s\n' "$canonical" > "$STATE/manifest.json"
  fi
  local configured manifest_genesis recorded=""
  configured="$(cfg GHOSTLINK_GENESIS_HASH)"
  manifest_genesis="$(helper field "$MANIFEST" genesisHash || true)"
  [ -f "$STATE/genesis" ] && recorded="$(cat "$STATE/genesis")"
  GENESIS="${configured:-${manifest_genesis:-$recorded}}"
  if [ -z "$GENESIS" ]; then
    [ -n "$(cfg RPC_URL)" ] || die "set GHOSTLINK_GENESIS_HASH: with only RPC_ENDPOINTS_PATH the runner cannot ask the chain for it"
    GENESIS="$(helper genesis "$(cfg RPC_URL)")" || die "cannot read the genesis hash from RPC_URL; is the node running?"
    echo "Adopting genesis $GENESIS from RPC_URL (set GHOSTLINK_GENESIS_HASH to pin it independently)."
  fi
  local candidate
  for candidate in "$configured" "$manifest_genesis" "$recorded"; do
    [ -z "$candidate" ] || [ "$candidate" = "$GENESIS" ] ||
      die "GHOSTLINK_GENESIS_HASH, the manifest's genesisHash and $STATE/genesis disagree; this state belongs to another chain"
  done
  [ -f "$STATE/genesis" ] || printf '%s\n' "$GENESIS" > "$STATE/genesis"
}

# Environment for one service: its own configuration keys, then the values the runner derives.
service_env() {
  local svc="$1" phase="$2" dir="$STATE/$1" key pattern
  ENV_ARGS=("PATH=$(dirname "$NODE"):/usr/bin:/bin" "HOME=$HOME" "GHOSTLINK_DEPLOYMENT=$MANIFEST")
  for key in RPC_URL RPC_ENDPOINTS_PATH; do [ -z "$(cfg "$key")" ] || ENV_ARGS+=("$key=$(cfg "$key")"); done
  case "$svc" in
    indexer) pattern='^(INDEXER_.*|WEBHOOK_SECRET)$' ;;
    relayer) pattern='^(RELAYER_.*|TRUST_PROXY)$' ;;
    solver) pattern='^(SOLVER_.*|JUPITER_.*|PRICE_ACCOUNTS|TRUST_PROXY)$' ;;
    actions) pattern='^(ACTIONS_.*|TRUST_PROXY)$' ;;
    watcher) pattern='^(WATCHER_.*|NOTIFY_WEBHOOK|LARGE_FILL_USD_E6)$' ;;
  esac
  for key in "${!CFG[@]}"; do [[ "$key" =~ $pattern ]] && ENV_ARGS+=("$key=${CFG[$key]}"); done
  ENV_ARGS+=("$(genesis_variable "$svc")=$GENESIS")
  [ "$phase" = run ] || return 0
  field() { helper field "$dir/deployment.json" "$1"; }
  case "$svc" in
    indexer)
      ENV_ARGS+=("PORT=$(port_of indexer)" "POLL_MS=$(cfg INDEXER_POLL_MS 5000)" "INDEXER_STATE_PATH=$dir/$(field files.state)"
        "INDEXER_STATE_KEY_PATH=$dir/$(field files.stateKey)" "INDEXER_STATE_ID=$(field stateId)") ;;
    relayer|solver)
      local upper; upper="$(tr '[:lower:]' '[:upper:]' <<< "$svc")"
      ENV_ARGS+=("PORT=$(port_of "$svc")" "OPERATIONS_PORT=$(cfg "${upper}_OPERATIONS_PORT" "$(( $(port_of "$svc") + 10000 ))")"
        "GHOSTLINK_${upper}_KEYPAIR=$dir/$(field files.payer)" "${upper}_JOURNAL_PATH=$dir/$(field files.journal)"
        "${upper}_JOURNAL_KEY_PATH=$dir/$(field files.storageKey)" "${upper}_JOURNAL_ID=$(field journalId)") ;;
    actions)
      ENV_ARGS+=("PORT=$(port_of actions)" "OPERATIONS_PORT=$(cfg ACTIONS_OPERATIONS_PORT "$(( $(port_of actions) + 10000 ))")"
        "BASE_URL=$(cfg ACTIONS_BASE_URL "$(url_of actions)")") ;;
    watcher)
      ENV_ARGS+=("WATCHER_PORT=$(port_of watcher)" "WATCHER_STATE_PATH=$dir/$(field files.state)"
        "WATCHER_STATE_KEY_PATH=$dir/$(field files.stateKey)" "WATCHER_STATE_ID=$(field stateId)")
      if [ "$(field mode)" = funded ]; then
        ENV_ARGS+=("GHOSTLINK_WATCHER_KEYPAIR=$dir/$(field files.payer)" "WATCHER_JOURNAL_PATH=$dir/$(field files.journal)"
          "WATCHER_JOURNAL_KEY_PATH=$dir/$(field files.journalKey)" "WATCHER_JOURNAL_ID=$(field journalId)"
          "WATCHER_TOTAL_BUDGET_LAMPORTS=$(field limits.totalBudgetLamports)" "WATCHER_MAX_FEE_LAMPORTS=$(field limits.maximumFeeLamports)")
      fi ;;
  esac
}

init_service() {
  local svc="$1" dir="$STATE/$1"
  [ "$svc" != actions ] || return 0 # Actions holds no state and no keys.
  [ ! -f "$dir/deployment.json" ] || return 0
  [ ! -e "$dir" ] || die "$dir exists without deployment.json: an interrupted initialization. Inspect it, move it aside and rerun"
  local args=("$dir")
  [ "$svc" != watcher ] || args=("$WATCHER_MODE" "$dir")
  echo "Initializing $svc state in $dir"
  service_env "$svc" init
  env -i "${ENV_ARGS[@]}" "$NODE" "$ROOT/services/$svc/dist/initialize.js" "${args[@]}" 2>&1 | grep -v -e ExperimentalWarning -e trace-warnings ||
    true
  [ -f "$dir/deployment.json" ] || die "$svc initialization failed (see the message above)"
}

init_all() {
  bind_state
  local svc
  for svc in $SERVICES; do init_service "$svc"; done
}

# ---- processes ---------------------------------------------------------------

pid_of() { [ -f "$STATE/run/$1.pid" ] && cat "$STATE/run/$1.pid"; }
# True only for the live process this runner started: a stale PID reused by another program does not count.
running() {
  local pid
  pid="$(pid_of "$1")" || return 1
  [ -r "/proc/$pid/cmdline" ] && tr '\0' ' ' < "/proc/$pid/cmdline" | grep -qF "services/$1/dist/index.js"
}

start_service() {
  local svc="$1" log="$STATE/logs/$1.log"
  if running "$svc"; then echo "$svc: already running (pid $(pid_of "$svc"))"; return 0; fi
  service_env "$svc" run
  echo "== $(date -u +%Y-%m-%dT%H:%M:%SZ) starting $svc ==" >> "$log"
  nohup env -i "${ENV_ARGS[@]}" "$NODE" "$ROOT/services/$svc/dist/index.js" >> "$log" 2>&1 < /dev/null &
  echo "$!" > "$STATE/run/$svc.pid"
}

# Waits until a started service answers /health, or reports the end of its log if it exits.
wait_alive() {
  local svc="$1" deadline=$((SECONDS + $(cfg GHOSTLINK_STARTUP_SECONDS 60)))
  while :; do
    if ! running "$svc"; then
      echo "$svc: exited during startup. End of $STATE/logs/$svc.log:" >&2
      grep -v -e ExperimentalWarning -e trace-warnings "$STATE/logs/$svc.log" | tail -n 3 | sed 's/^/  /' >&2
      rm -f "$STATE/run/$svc.pid"
      return 1
    fi
    helper probe "$(url_of "$svc")/health" >/dev/null && return 0
    if [ "$SECONDS" -ge "$deadline" ]; then echo "$svc: no answer on $(url_of "$svc")/health; see $STATE/logs/$svc.log" >&2; return 1; fi
    sleep 1
  done
}

# One line per service; returns 0 only when every service is running and ready.
report() {
  local svc all=0 line payer
  for svc in $SERVICES; do
    if running "$svc"; then
      line="$(helper probe "$(url_of "$svc")/ready")" || all=1
      line="running (pid $(pid_of "$svc")) $(url_of "$svc"): $line"
      payer=""
      case "$svc" in
        relayer|solver) payer="$(helper field "$STATE/$svc/deployment.json" "scope.$([ "$svc" = relayer ] && echo payer || echo solver)" || true)" ;;
        watcher) payer="$(helper field "$STATE/$svc/deployment.json" scope.payer || true)" ;;
      esac
      [ -z "$payer" ] || line="$line; payer $payer"
    else
      line="stopped"; all=1
    fi
    printf '%-8s %s\n' "$svc" "$line"
  done
  return "$all"
}

stop_all() {
  local svc pid waiting
  for svc in $SERVICES; do
    if running "$svc"; then kill -TERM "$(pid_of "$svc")"; echo "$svc: stopping (pid $(pid_of "$svc"))"; else rm -f "$STATE/run/$svc.pid"; fi
  done
  # Each service drains in-flight work for up to 30 seconds, then exits by itself.
  local deadline=$((SECONDS + 40))
  while :; do
    waiting=""
    for svc in $SERVICES; do
      if running "$svc"; then waiting="$waiting $svc"; else rm -f "$STATE/run/$svc.pid"; fi
    done
    [ -n "$waiting" ] || { echo "all stopped"; return 0; }
    if [ "$SECONDS" -ge "$deadline" ]; then
      for svc in $waiting; do echo "$svc: still running after 40 seconds (pid $(pid_of "$svc")); see $STATE/logs/$svc.log" >&2; done
      return 1
    fi
    sleep 1
  done
}

case "$COMMAND" in
  init)
    init_all
    echo "State for the $CLUSTER deployment is in $STATE. Fund the payers that status lists, then start."
    ;;
  start)
    init_all
    for svc in $SERVICES; do start_service "$svc"; done
    failed=0
    for svc in $SERVICES; do wait_alive "$svc" || failed=1; done
    report || true
    [ "$failed" -eq 0 ] || die "a service did not start; fix the reported problem, then run start again (running services are left running)"
    echo "Started. A service is ready once its /ready answers 200; 'status --wait <seconds>' waits for that."
    ;;
  status)
    [ -d "$STATE" ] || die "no state in $STATE; run init or start first"
    GENESIS="$(cat "$STATE/genesis" 2>/dev/null || true)"
    if [ -n "$WAIT" ]; then
      deadline=$((SECONDS + WAIT))
      until report > /dev/null || [ "$SECONDS" -ge "$deadline" ]; do sleep 0.7; done
    fi
    report
    ;;
  stop)
    [ -d "$STATE/run" ] || { echo "nothing to stop"; exit 0; }
    stop_all
    ;;
esac
