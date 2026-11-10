# Self-hosting

This guide takes you from a fresh clone to the whole GhostLink stack running on machines you control, on a chain you choose: your own programs (a deployment), the five services that help users reach them, and the files apps download to make proofs. Everything here is free and needs no permission from anyone. One script, `scripts/selfhost.sh`, creates the services' state the first time and starts, checks and stops them as separate processes. Another, `scripts/selfhost-proof.sh`, shows the whole thing working on a local validator.

Read this first: GhostLink is **experimental and not for real funds**. The development proving keys come from a single-party setup, so whoever made them could forge proofs; the code has had no external audit; and the services are built for a single host, not for high availability. The [last section](#what-this-does-not-give-you) lists what you would still need before holding value.

## The pieces

| Service | Default port | What it does | Keys and state it holds |
| --- | --- | --- | --- |
| Indexer | 8787 | Follows finalized history of your three programs and serves Merkle roots, paths, bindings and snapshots to provers | Encrypted checkpoint; no signing key |
| Relayer | 8788 (operator port 18788) | Pays for registrations, census snapshots, session openings and owner actions so users need no SOL | **Payer keypair** and an encrypted spending journal |
| Solver | 8789 (18789) | Fills pocket trade intents from its own inventory (or an experimental Jupiter route) | **Payer keypair** and an encrypted submission journal |
| Actions | 8790 (18790) | Builds Blink deposit transactions that fund pockets | Nothing |
| Watcher | 8791 | Alerts owners about proposed home-address changes and large fills; optionally cranks timelocked changes | Encrypted delivery state; in funded mode a **payer keypair** and crank journal |

Operator ports serve metrics on `127.0.0.1` only. Each service's operations guide explains it in depth: [indexer](INDEXER-OPERATIONS.md), [relayer](RELAYER-OPERATIONS.md), [solver](SOLVER-OPERATIONS.md), [Actions](ACTIONS-OPERATIONS.md), [watcher](WATCHER-OPERATIONS.md), [RPC](RPC-OPERATIONS.md).

## 1. Toolchain

Linux or WSL. The versions are in [setup](SETUP.md#toolchain): Node 22.16 or later (24 works), pnpm 10.33.2, and for building and deploying programs Rust 1.97.1, Agave/Solana 3.0.x and SBF platform tools v1.52. circom 2.2.3 is needed only if you build circuit artifacts yourself.

```bash
git clone https://github.com/Ghostlink-Labs/ghostlink.git
cd ghostlink
pnpm install --frozen-lockfile
pnpm -r build
```

Keep everything private (keys, state, configuration with credentials) in a directory **outside** the checkout, for example `~/ghostlink`. Every script here refuses keys and state inside the checkout.

## 2. A deployment

A deployment is your registry, census and Pocket programs on one chain, described by a small public JSON file, the deployment manifest. Create one, build the programs for it and deploy them by following [deployments](DEPLOYMENTS.md) (steps 1 to 4). Every process in this guide takes the manifest's path.

To try the stack on a local validator without new program keys, use the built-in localnet deployment and the default program build. Run the validator in its own terminal:

```bash
mkdir -p ~/ghostlink && chmod 700 ~/ghostlink
node scripts/deployment.mjs manifest > ~/ghostlink/manifest.json   # the built-in localnet deployment
bash scripts/build-programs.sh                                      # programs in target/deploy
solana-keygen new --no-bip39-passphrase --outfile ~/ghostlink/authority.json
read -r REGISTRY CENSUS POCKET <<< "$(node scripts/deployment.mjs ids ~/ghostlink/manifest.json)"
solana-test-validator --ledger ~/ghostlink/ledger \
  --bpf-program "$REGISTRY" target/deploy/ghostlink_registry.so \
  --upgradeable-program "$CENSUS" target/deploy/ghostlink_census.so ~/ghostlink/authority.json \
  --bpf-program "$POCKET" target/deploy/ghostlink_pocket.so
```

Then, in another terminal, create the registry and census trees (a public deployment gets them from `deploy-programs.sh`):

```bash
solana airdrop 5 "$(solana-keygen pubkey ~/ghostlink/authority.json)" -u http://127.0.0.1:8899
node scripts/deployment.mjs initialize ~/ghostlink/manifest.json --url http://127.0.0.1:8899 --payer ~/ghostlink/authority.json
```

The census is loaded as an upgradeable program with `authority.json` as its upgrade authority, as `solana program deploy` leaves it, so the [fee tool](#7-the-census-snapshot-fee) works.

## 3. Circuit artifacts

The services never prove anything and need no circuit files. **Apps** do: a user's device makes each proof with `@ghostlink/prover-wasm`, which downloads a circuit's `.wasm` witness generator and `.zkey` proving key from URLs the app configures, checks them against SHA-256 pins and caches them ([prover-wasm](../packages/prover-wasm/README.md)). The development files are published as release assets for you to download; you host the copies your apps use:

1. Get the files. `node scripts/proving-artifacts.mjs fetch` downloads the development files that match the committed verifying keys into `circuits/build` and checks each by SHA-256 (`list` prints their URLs and hashes). To make your own development keys instead, run `bash scripts/build-circuits.sh` (see [setup](SETUP.md#fresh-local-proving-setup)); it **rewrites the committed verifying keys**, so run it on a scratch branch and rebuild the programs from that branch. A deployment that will hold value needs keys from a public multi-party [ceremony](CEREMONY.md) instead.
2. The proving keys must match the verifying keys compiled into your programs, whose digests are the manifest's `verifyingKeys`. `node scripts/deployment.mjs check <manifest>` compares the manifest with the checkout's keys. Proofs from any other keys fail on chain.
3. Serve `circuits/build/login_js/login.wasm` and `circuits/build/login_<dev|final>.zkey` (and the `owner` pair for owner actions) as static files from any web server or CDN, and give apps their URLs and `sha256sum` values. `.zkey` and `.ptau` files never go into Git.

## 4. Configure

Copy the example configuration outside the checkout and edit it. It explains every key; only three are required.

```bash
cp scripts/selfhost.env.example ~/ghostlink/selfhost.env
```

| Key | Meaning |
| --- | --- |
| `GHOSTLINK_DEPLOYMENT` | Your manifest. Every service and every initialization gets the same path |
| `RPC_URL` (or `RPC_ENDPOINTS_PATH`) | The chain's RPC. HTTPS except on loopback; a provider URL with an API key is a secret ([RPC operations](RPC-OPERATIONS.md)) |
| `GHOSTLINK_STATE_DIR` | Where state, keys, logs and process IDs go. Outside the checkout |

The runner gives each service only its own keys (by prefix: `INDEXER_*`, `RELAYER_*`, `SOLVER_*` with `JUPITER_*` and `PRICE_ACCOUNTS`, `ACTIONS_*`, `WATCHER_*` with `NOTIFY_WEBHOOK` and `LARGE_FILL_USD_E6`, plus `TRUST_PROXY` for the three that rate-limit clients) and fills in what it derives: the genesis hash, the state paths, the pinned state identities and the ports. The file is parsed as `KEY=VALUE` lines and never executed.

**Genesis.** Devnet and mainnet-beta manifests pin their chain. For a localnet manifest without a genesis hash, the first `init` adopts the RPC's genesis and records it in `GHOSTLINK_STATE_DIR/genesis`; set `GHOSTLINK_GENESIS_HASH` to pin it yourself. Afterwards the runner refuses a different value, and every service refuses an RPC that serves another chain.

## 5. Initialize, fund and start

```bash
bash scripts/selfhost.sh init --config ~/ghostlink/selfhost.env
```

On the first run only, this records the manifest and genesis in the state directory and runs each service's `initialize.js` into its own subdirectory: a fresh encrypted database with a random storage key and a random instance identity (`deployment.json` records it), and for the relayer and solver a fresh payer keypair (`payer.json`). It never adopts or overwrites existing state: a later `init` or `start` reuses what is there, and a state directory made for another manifest or chain is refused. Actions holds no state. `start` runs `init` itself when needed.

Fund the payers before relying on them. `status` prints each payer's address. The relayer pays network fees, the census snapshot fee and account rent, and is not ready below `RELAYER_MIN_BALANCE_LAMPORTS` (0.05 SOL by default) plus what it has reserved. The solver needs SOL for fees (`SOLVER_MIN_BALANCE_LAMPORTS`, 0.005 SOL) and the output tokens it fills from. On a local validator, `solana airdrop` does it.

```bash
bash scripts/selfhost.sh start --config ~/ghostlink/selfhost.env
bash scripts/selfhost.sh status --config ~/ghostlink/selfhost.env --wait 300
```

`start` launches each service as its own `node services/<name>/dist/index.js` process in an otherwise empty environment, writes its PID to `GHOSTLINK_STATE_DIR/run/` and appends its output to `GHOSTLINK_STATE_DIR/logs/<name>.log`, then waits until each answers `/health`. A service that exits during startup is reported with the end of its log, which names the problem (see [troubleshooting](#troubleshooting)). Running services are left alone, so `start` can be repeated after fixing one.

`status` prints one line per service and exits 0 only when every service is running and **ready**; `--wait <seconds>` waits for that. Because the indexer refuses reads while each poll scans, `status` retries a not-ready answer a few times before reporting it. Ready means the service's `/ready` answers 200:

| Service | Ready when |
| --- | --- |
| Indexer | It owns its pinned state, its last scan matched finalized history, and ingestion, head progress and root availability were checked in the last 30 seconds. Every poll briefly answers 503 while it scans, so clients retry |
| Relayer | Its RPC answers with advancing slots, its journal is healthy, its payer balance covers the reserve plus outstanding reservations, and its daily budget and capacity have room. `status` lists failing checks, for example `feeReserve` for an unfunded payer |
| Solver | The same kind of checks for its own payer, journal and chain progress |
| Actions | Its RPC answers with advancing slots |
| Watcher | It has caught up with the Pocket program's history in the last 30 seconds |

`/health` answers as soon as a service listens, ready or not. Put the public ports behind a reverse proxy with TLS and firewall them; the services listen on all interfaces.

```bash
bash scripts/selfhost.sh stop --config ~/ghostlink/selfhost.env
```

`stop` sends SIGTERM to each service it started (it checks the process is still that service before signalling) and waits up to 40 seconds. Each service stops taking work, finishes what it admitted and closes its state; one that cannot finish within 30 seconds exits by itself, and its journal keeps what reconciliation needs.

## 6. Smoke test

On a local validator, one command proves the runner end to end with the services as separate processes:

```bash
bash scripts/selfhost-proof.sh            # work directory ~/.ghostlink-selfhost-proof
bash scripts/selfhost-proof.sh            # again: restarts the validator and reuses the state
```

It starts a validator (RPC port 18899, services from 28787, so it does not disturb a stack on the default ports), writes a configuration, runs `selfhost.sh start`, funds the payers, waits for readiness and then, through the services' public HTTP APIs only: registers a fresh wallet through the relayer, takes a census snapshot through the relayer and checks that the fee vault gained exactly the snapshot fee, and waits until the indexer serves the binding and the snapshot. It shows the fee with the fee tool and stops everything. Delete the work directory for a clean start.

Against your own deployment, check by hand: `status` shows every service ready, `curl http://<host>:8787/health` shows the indexer following your programs, and `node scripts/deployment.mjs fee show <manifest> --url <rpc>` reads your census. The full user journey (prove, verify, open, fund, fill, sweep) is exercised on a local validator by `bash scripts/localnet-e2e.sh` ([setup](SETUP.md)), with the services in-process.

## 7. The census snapshot fee

Every census snapshot pays a fee into a program-owned vault ([ADR 0005](adr/0005-census-spam-resistance.md)): 100,000 lamports by default, so that filling the census tree costs far more than network fees. The census program's **upgrade authority** (the payer that deployed it, unless you transferred it) can change the fee and withdraw what was collected:

```bash
node scripts/deployment.mjs fee show <manifest.json> --url <rpc>
node scripts/deployment.mjs fee set <manifest.json> <lamports> --url <rpc> --authority <keypair.json> [--confirm <cluster>]
node scripts/deployment.mjs fee withdraw <manifest.json> <lamports|all> --to <address> --url <rpc> --authority <keypair.json> [--confirm <cluster>]
```

`show` prints the fee, the vault's balance and what is withdrawable above its rent-exempt minimum, and the upgrade authority. `set` and `withdraw` refuse, before sending anything, an authority keypair inside the checkout, a keypair that is not the census upgrade authority, an RPC whose genesis does not match the manifest, an immutable census, and a withdrawal larger than the withdrawable balance. On devnet and mainnet-beta they print the plan and stop unless `--confirm <cluster>` names the manifest's cluster.

**A zero fee** (`fee set <manifest> 0 ...`) makes snapshots cost only the network fee. That removes the price of growing the census tree: anyone can then add leaves cheaply, which grows every indexer's checkpoint toward its fixed limit ([indexer operations](INDEXER-OPERATIONS.md#configuration-and-migration)) and, at the extreme, fills the tree. Root eviction stays prevented by the time-bucketed root history either way. Relayers refuse fees above `RELAYER_MAX_SNAPSHOT_FEE_LAMPORTS` (1,000,000 by default), so raise that on yours before raising the fee above it. Making the census immutable freezes the fee and locks the vault: withdraw and set the final fee first.

## 8. Logs, upgrades and backups

**Logs** are in `GHOSTLINK_STATE_DIR/logs`, one file per service, appended across restarts. Services never print keys, storage keys or RPC credentials; rotate the files with your usual tooling.

**Upgrading the services:** `git pull`, `pnpm install --frozen-lockfile`, `pnpm -r build`, then `stop` and `start`. Services refuse state they cannot use (an indexer checkpoint from before root-history buckets, for one) instead of changing it, so read the changes and the operations guides before upgrading. Never delete or recreate state to get past a refusal.

**Upgrading the programs:** rebuild for your manifest and run `scripts/deploy-programs.sh` again with the same keys; deploying to existing program IDs upgrades them, which only their upgrade authority can do ([deployments](DEPLOYMENTS.md#4-deploy)). The manifest stays the same as long as the program IDs and verifying keys do. New verifying keys mean new program IDs and a new manifest, so new service state.

**Backups:** the relayer, solver and watcher journals record money already spent and transactions in flight; losing them risks paying twice. Follow [backup and restore](BACKUP-RESTORE.md): use each service's encrypted backup command, never copy live SQLite files, and know that a restored journal is quarantined until reconciled. Back up the keys (`payer.json`, `storage-key` files, `deployment.json` pins) separately through your secret system; the indexer can be rebuilt from chain history instead (move its directory aside and run `init`; this needs an RPC that serves the programs' full history).

## Never share

- `GHOSTLINK_STATE_DIR`: payer keypairs, storage encryption keys, journals and logs.
- Program keypairs, the upgrade authority keypair and any payer keypair from [deployments](DEPLOYMENTS.md).
- Configuration that carries credentials: an RPC URL or endpoints file with an API key, `WEBHOOK_SECRET`, `NOTIFY_WEBHOOK` with a token, Jupiter key files.
- Nothing of the above belongs in Git: CI rejects key, database and `.env` files anywhere in the history.

The manifest is public: publish it, with your programs' executable hashes, where your users and integrators can check it.

## Troubleshooting

A service that cannot start prints one line naming the problem and exits with status 1; `start` shows it from the log. For example:

```text
relayer startup failed: RELAYER_JOURNAL_ID must be 64 lowercase hex characters (the "journalId" value from deployment.json)
indexer startup failed: GHOSTLINK_DEPLOYMENT: /home/op/ghostlink/manifest.json: genesisHash is not the devnet genesis hash (...)
solver startup failed: the RPC serves a different chain than SOLVER_GENESIS_HASH; point RPC_URL or RPC_ENDPOINTS_PATH at that chain, or correct SOLVER_GENESIS_HASH
indexer startup failed: INDEXER_STATE_PATH: /home/op/ghostlink/state/indexer/state.sqlite was refused (indexer state identity mismatch); check INDEXER_STATE_KEY_PATH, INDEXER_STATE_ID, ...
Actions startup failed: PORT: port 8790 is already in use
```

Messages name variables, paths, ports and public values only. A damaged keypair or key file is reported by its variable and path, never its contents; anything the services cannot classify is reported with a generic line and no detail. Common causes:

- **was refused** on state: the state belongs to another manifest, chain, payer, watcher webhook or threshold, its pin or key does not match, or it was restored from a backup and needs reconciliation. Compare with that service's `deployment.json`; do not delete it.
- **already owned by another worker**: an indexer that crashed holds a 90-second lease; wait for it to expire.
- A relayer that runs but is not ready with `feeReserve`: fund its payer.

## What this does not give you

- **Trustworthy proving keys.** The development keys let whoever made them forge proofs. Real value needs a public ceremony and programs rebuilt with its keys.
- **An audit.** Neither the programs nor the services have had an external security review.
- **High availability.** Each service is one process with local SQLite state and a single-owner lease. There is no clustering, replication or failover; two copies of the same state do not coordinate.
- **Process supervision.** The runner does not restart a crashed service or start the stack at boot. Wrap `start`/`stop` in your init system, or run the same commands and environment under systemd, if you need that. The runner itself is tested on Linux and WSL only.
- **TLS, a reverse proxy, firewalling, monitoring and alerting.** Bring your own; the operator ports expose metrics on loopback.
- **Scale.** The indexer's checkpoint is bounded and rewritten whole on each applied transaction ([indexer operations](INDEXER-OPERATIONS.md#configuration-and-migration)). Measure throughput and storage at your intended size.
- **Container images.** None are provided yet.
- **Operations you must still run:** funding payers, watching budgets, backups, key rotation ([backup and restore](BACKUP-RESTORE.md)), incident response, and publishing your manifest. See [mainnet readiness](MAINNET-READINESS.md) for the release gates.
