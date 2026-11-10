# Deployments

A **deployment** is one set of GhostLink programs on one chain: a registry, a census and a Pocket program at three program IDs, built with one pair of verifying keys. Anyone can create their own, free, from this repository: generate three program keypairs, build the programs for them, deploy them with your own wallet and point the SDK, services and bot at the result.

There is still **no official public GhostLink V2 deployment**. A deployment you create is yours: you choose its keys, pay for it, hold its upgrade authority and answer for its security. The development proving keys in this repository come from a single-party setup, so whoever ran it could forge proofs; do not hold real funds in a deployment built with them (see [ceremony](CEREMONY.md) and [mainnet readiness](MAINNET-READINESS.md)).

The design and the alternatives considered are in [ADR 0007](adr/0007-deployment-manifest.md).

## The deployment manifest

Every part of GhostLink learns which deployment it belongs to from one small JSON file, the deployment manifest. It holds only public values:

```json
{
  "version": 1,
  "cluster": "devnet",
  "genesisHash": "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  "registryProgram": "<registry program ID>",
  "censusProgram": "<census program ID>",
  "pocketProgram": "<pocket program ID>",
  "verifyingKeys": {
    "login": "<SHA-256 of the login verifying key>",
    "owner": "<SHA-256 of the owner verifying key>"
  }
}
```

| Field | Meaning |
| --- | --- |
| `version` | Always `1`. Unknown fields are refused, so a misspelt field is never silently ignored. |
| `cluster` | `localnet`, `devnet` or `mainnet-beta`. The registry is built with its `mainnet` feature for `mainnet-beta`, so registration messages signed for one cluster never register on another. |
| `genesisHash` | Required on `devnet` and `mainnet-beta`, where it must be that cluster's genesis hash. Optional on `localnet`: omitted, any local validator is accepted; given, only that chain is. |
| `registryProgram`, `censusProgram`, `pocketProgram` | The three program IDs, all different. |
| `verifyingKeys` | `verifyingKeyDigest` (SHA-256 of the canonical, key-sorted JSON) of `circuits/keys/login_vk.json` and `owner_vk.json`: the verifying keys compiled into the programs. Proofs from other proving keys fail on chain. |

`@ghostlink/common` exports the type (`DeploymentManifest`), the validator (`parseDeployment`), the chain check (`assertDeploymentGenesis`) and the built-in deployment (`LOCALNET_DEPLOYMENT`).

### What the manifest binds

- **Addresses.** Pockets, trees, fee vault and fill state are program-derived addresses of the manifest's programs. Clients derive them from the manifest, never from a server's answer.
- **Proofs.** The session authorization context inside every login proof that opens a pocket hashes all three program IDs ([ADR 0003](adr/0003-session-authorization-v2.md)). A proof made for one deployment is refused by every other one, on chain and by `verifyLogin`.
- **Registration.** The registration message a wallet signs names the registry program ID and the registry build's cluster tag.
- **Service state.** Every service's encrypted state scope already records the genesis hash and program IDs; state created for one deployment refuses to start under another.
- **Keys.** `verifyingKeys` ties the manifest to the verifying keys the build embeds. The program build refuses a manifest whose digests differ from this checkout's `circuits/keys`.

### The refusal rule

The built-in program IDs are the committed ones in `programs/*/src/lib.rs`. On devnet they are also the addresses of the **preserved V1 deployment**, whose login proofs and instructions are incompatible with V2. So every part of GhostLink applies one rule:

1. With no manifest, the built-in `localnet` deployment is used. It works on a local validator and refuses the devnet and mainnet genesis hashes.
2. A `devnet` or `mainnet-beta` manifest must name that cluster's genesis hash and three program IDs that are **not** the built-in ones. A manifest naming any built-in ID on a public cluster is refused, naming the field.
3. Before anything is signed or sent, the RPC's actual genesis is checked against the manifest (`assertDeploymentGenesis`): a pinned genesis must match, and a `localnet` manifest refuses public chains.
4. The deploy script refuses the built-in IDs on every cluster: no V2 build can be deployed over them by accident.

## Create a deployment

Build the TypeScript packages once (`pnpm install --frozen-lockfile && pnpm -r build`); the tooling below uses `@ghostlink/common`. Program builds and deployment run on Linux or WSL with the [toolchain in setup](SETUP.md).

### 1. Generate keys and the manifest

```bash
node scripts/deployment.mjs new --cluster devnet \
  --keys ~/ghostlink-keys/my-devnet --out ~/ghostlink-keys/my-devnet/manifest.json
```

This creates `registry.keypair.json`, `census.keypair.json` and `pocket.keypair.json` (mode 600) in the key directory, which must be outside the checkout, and writes the manifest. Rerun with a directory that already holds all three keypairs to reuse them; a directory with only some of them is refused. For `localnet`, omit the genesis hash so the manifest works with any fresh validator, or pin one with `--genesis-hash`. The manifest contains no secrets and can be published; the keypairs must never be committed or shared.

### 2. Build the programs for it

```bash
bash scripts/build-programs.sh --deployment ~/ghostlink-keys/my-devnet/manifest.json
```

This command never edits your checkout. It validates the manifest, checks its verifying-key digests against `circuits/keys`, copies the Rust workspace to `${CARGO_TARGET_DIR:-target}/deployments/<pocket program ID>/src`, writes the three IDs into the five places they are compiled in (each program's `declare_id!` and the registry and census IDs the Pocket program checks), confirms no built-in ID remains in the program sources, builds there and leaves `ghostlink_registry.so`, `ghostlink_census.so` and `ghostlink_pocket.so` in `.../deploy` beside a copy of the manifest. It prints each program's executable hash. `node scripts/deployment.mjs artifacts <manifest>` prints that directory after checking it was built for exactly that manifest.

The plain `bash scripts/build-programs.sh` still builds the committed IDs, which the repository's fixtures, vectors and LiteSVM tests use. `node scripts/deployment.mjs check` and `packages/common/test/program-ids.test.ts` fail when any committed place disagrees with the built-in deployment.

### 3. Try it on a local validator

A `localnet` manifest runs the whole local journey (register, snapshot, prove, verify, open, fund, fill, sweep) against your program IDs. Every proof is made during the run for those IDs; no committed fixture is involved.

```bash
node scripts/deployment.mjs new --cluster localnet --keys ~/ghostlink-keys/local --out ~/ghostlink-keys/local/manifest.json
bash scripts/build-programs.sh --deployment ~/ghostlink-keys/local/manifest.json
GHOSTLINK_DEPLOYMENT=~/ghostlink-keys/local/manifest.json bash scripts/localnet-e2e.sh
```

### 4. Deploy

```bash
bash scripts/deploy-programs.sh --deployment ~/ghostlink-keys/my-devnet/manifest.json \
  --keys ~/ghostlink-keys/my-devnet --url https://api.devnet.solana.com \
  --payer ~/ghostlink-keys/my-devnet/payer.json --confirm devnet
```

Before sending anything the script refuses a manifest naming any built-in program ID, keypairs that are not the manifest's, a key directory or payer inside the checkout, a payer that is a program key, programs not built for exactly this manifest, and an RPC whose genesis does not match. On `devnet` and `mainnet-beta` it prints the plan and stops unless `--confirm <cluster>` is given. It then runs `solana program deploy` for each program, checks each deployed program against the local build with `scripts/verify-program.sh`, and creates the registry and census trees (`initialize` is permissionless and records nothing about the caller). The payer needs enough SOL for three program deployments and becomes their upgrade authority.

### 5. Configure clients and services

One mechanism everywhere: the path of the manifest file.

| Component | How it takes the deployment |
| --- | --- |
| `@ghostlink/sdk` | `GhostLink.init({ cluster, deployment, ... })` with the parsed manifest. Localnet without `deployment` keeps the built-in one. `createGhostLinkWallet`, `derivePocket`, `fundingOptions`, `recoverPockets` and `prepareFundingTransaction` accept the same manifest. |
| `@ghostlink/verify` | `verifyLogin({ ..., expect: { pocket: { ..., deployment: sessionDeployment(manifest) } } })`. |
| Services (indexer, relayer, solver, Actions, watcher) | `GHOSTLINK_DEPLOYMENT=<manifest.json>` for both `initialize.js` and the service. Each still requires its own approved `*_GENESIS_HASH`, which must suit the manifest. See the [indexer](INDEXER-OPERATIONS.md), [relayer](RELAYER-OPERATIONS.md), [solver](SOLVER-OPERATIONS.md), [Actions](ACTIONS-OPERATIONS.md) and [watcher](WATCHER-OPERATIONS.md) guides. |
| `@ghostlink/bot` | `deployment: botDeployment(manifest, await connection.getGenesisHash())`, with the manifest read from `GHOSTLINK_DEPLOYMENT` (`loadDeploymentConfig()` in `@ghostlink/service-kit` does that). |
| `@ghostlink/service-kit` | Reads `GHOSTLINK_DEPLOYMENT` once, at import; its instruction builders, PDAs and event decoder use the result for the life of the process. |
| Local journey | `GHOSTLINK_DEPLOYMENT=<manifest.json> bash scripts/localnet-e2e.sh` (localnet manifests only). |

To run all five services for a manifest as separate processes, with their state and keys outside the checkout, use `scripts/selfhost.sh`: see [self-hosting](SELF-HOSTING.md). `node scripts/deployment.mjs manifest` prints the built-in localnet deployment as a manifest file for a local validator running the default program build.

### 6. Set the census snapshot fee

Every census snapshot pays a fee, 100,000 lamports at first, into a vault the census program owns ([ADR 0005](adr/0005-census-spam-resistance.md)). The census program's upgrade authority, the payer of step 4 unless you transferred it, can change the fee and withdraw collected fees:

```bash
node scripts/deployment.mjs fee show ~/ghostlink-keys/my-devnet/manifest.json --url https://api.devnet.solana.com
node scripts/deployment.mjs fee set ~/ghostlink-keys/my-devnet/manifest.json 0 --url https://api.devnet.solana.com \n  --authority ~/ghostlink-keys/my-devnet/payer.json --confirm devnet
node scripts/deployment.mjs fee withdraw ~/ghostlink-keys/my-devnet/manifest.json all --to <address> \n  --url https://api.devnet.solana.com --authority ~/ghostlink-keys/my-devnet/payer.json --confirm devnet
```

The tool applies the deploy script's guards: the authority keypair must be outside the checkout and must be the census upgrade authority, the RPC's genesis must match the manifest, and on devnet and mainnet-beta it prints the plan and stops unless `--confirm <cluster>` is given. Withdrawals never take the vault below its rent-exempt minimum. A fee of zero removes the spam cost of snapshots: anyone can then grow the census tree, and every indexer's checkpoint, for network fees alone. Relayers refuse fees above their `RELAYER_MAX_SNAPSHOT_FEE_LAMPORTS` (default 1,000,000). An immutable census keeps its last fee and locks its vault. `bash scripts/test-census-fee.sh` exercises the tool against a local validator.

A malformed manifest, an unreadable path or an empty `GHOSTLINK_DEPLOYMENT` stops the process with the reason. Unset, every component uses the built-in localnet deployment.

## What stays your responsibility

- **Keys.** Program keypairs, the payer and the upgrade authority live outside the repository; losing the upgrade authority freezes the programs, leaking it lets someone replace them. Plan its transfer to a multisig, or its removal after an audit, before holding value.
- **Proving keys.** The committed keys come from a development setup. A deployment that holds value needs keys from a public multi-party ceremony ([ceremony](CEREMONY.md)), regenerated Rust verifying keys, and a manifest made from them.
- **Publishing the manifest.** Clients trust the manifest they are given. Publish yours where your users can check it (with the deployed programs' executable hashes) and give it to integrators out of band.
- **Verifiable builds.** `scripts/verify-program.sh` compares a deployed program with your local build. For a build third parties can reproduce with `solana-verify`, commit your IDs to a fork (the five places listed by `scripts/program-ids.mjs`) so the source alone produces your binaries; the repository's own tests keep using the built-in IDs.
- **Operations.** Funding service payers, RPC providers, monitoring, backups and incident response for your services; see the operations guides.
- **Testnet.** Only `localnet`, `devnet` and `mainnet-beta` are supported clusters. The built-in deployment's refusal covers the devnet and mainnet genesis hashes.
