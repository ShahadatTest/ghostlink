# ADR 0007: Deployment manifests for self-hosted deployments

Status: implemented development candidate, 2026-11-10. Not deployed by the maintainers; there is still no official public V2 deployment. Builds on [ADR 0003](0003-session-authorization-v2.md), which binds the three program IDs into every pocket authorization.

## Context

GhostLink is meant to be run by anyone, on their own infrastructure, without permission or payment. Two things made that impossible on any public network:

1. **Literal refusals.** `GhostLink.init` threw unless the cluster was `localnet`. Each service initializer, the Actions service, the relayer, solver and watcher submission paths, the bot onboarding and the SDK's application registry refused the devnet and mainnet genesis hashes by literal. `scripts/devnet-deploy.sh` exited with an error.
2. **Compile-time program IDs.** The registry, census and Pocket IDs are `declare_id!`/`pubkey!` constants in three program crates and constants in `@ghostlink/common`, `@ghostlink/service-kit`, `Anchor.toml`, the LiteSVM tests and the e2e scripts. Only the maintainers hold the matching keypairs, and everything derived from the IDs (PDAs, the session authorization context, fixtures and vectors) followed them.

The refusals exist for a real reason: on devnet, the built-in IDs are the preserved V1 deployment. Its proofs and instructions are incompatible with V2, and V2 code must never talk to it. Any replacement has to keep that guarantee while letting an operator bring their own programs.

## Decision

**One manifest describes a deployment.** A small JSON document (`DeploymentManifest` in `@ghostlink/common`) names the cluster, the genesis hash (required and checked for devnet and mainnet-beta), the three program IDs and SHA-256 digests of the two verifying keys the programs embed. `parseDeployment` validates it strictly: unknown fields, malformed or repeated addresses, a wrong genesis for the cluster and malformed digests are refused with specific messages. `LOCALNET_DEPLOYMENT` is the built-in deployment and every default.

**One rule everywhere.** Without a manifest only the built-in localnet deployment exists, and it refuses public genesis hashes. A public cluster requires an explicit manifest whose program IDs are none of the built-in ones. Before use, `assertDeploymentGenesis` checks the RPC's actual genesis against the manifest. The SDK (`resolveDeployment`), the application registry and bot (`checkBotDeployment`), every service and the e2e harness call the same functions instead of comparing literals.

**One configuration mechanism.** Libraries take the manifest as an argument: `GhostLink.init({ deployment })`, `createGhostLinkWallet`, `derivePocket`, `fundingOptions`, `recoverPockets`, `prepareFundingTransaction`, and `sessionDeployment(manifest)` for `@ghostlink/verify`. Processes take a path in `GHOSTLINK_DEPLOYMENT`, read once by `@ghostlink/service-kit` when it is first imported; its program constants, PDAs, instruction builders and event decoder then use that deployment for the life of the process. The services' existing encrypted state scopes already record the program IDs, so state from one deployment refuses to open under another.

**Programs are built for a deployment without editing the checkout.** `scripts/build-programs.sh --deployment <manifest>` copies the Rust workspace into a private build directory under the cargo target directory, rewrites the five compiled-in ID declarations (listed once, in `scripts/program-ids.mjs`), checks that no built-in ID remains in the program sources, builds there (with the registry's `mainnet` feature for mainnet-beta) and stamps the output with the manifest. The default build is unchanged. A test (`packages/common/test/program-ids.test.ts`) and `node scripts/deployment.mjs check` fail when any committed place disagrees with the built-in deployment.

**Deployment is guarded, and the operator's.** `scripts/deployment.mjs new` generates (or reuses) three program keypairs in a directory outside the checkout and writes the manifest. `scripts/deploy-programs.sh` refuses the built-in IDs on every cluster, mismatched keypairs, programs not stamped for exactly this manifest and a wrong genesis, requires `--confirm <cluster>` for public clusters, verifies each deployed program against the build and creates the trees. `scripts/devnet-deploy.sh` is removed.

**Fixtures stay with the built-in deployment.** Committed login fixtures and vectors bind the built-in IDs (the authorization context and the registration message include them), so the repository's unit, vector and LiteSVM tests keep using those. The local validator journey makes every proof itself, so `GHOSTLINK_DEPLOYMENT=<manifest> bash scripts/localnet-e2e.sh` proves a non-default deployment end to end.

## Alternatives considered

- **Program IDs from environment variables at compile time** (a `build.rs` in each program generating `declare_id!`). It keeps one source tree, but the IDs become invisible in source, a stray variable silently changes a build that shares a target directory with the default, and `solana-verify` cannot reproduce a build that depends on the environment. Rewriting a private copy keeps the declarations literal and auditable, and a fork can commit the same rewrite for verifiable builds.
- **Rewriting the checkout in place** (like `anchor keys sync`). Simple, but it dirties the working tree, and the committed fixtures and LiteSVM tests, which bind the built-in IDs, would then fail. The private copy gives the same result without either.
- **A cluster flag plus per-field overrides** in each component. Several sources of truth that can disagree; the manifest is one object, validated once and pinned by the services' state scopes.
- **Treating any non-built-in IDs as safe without a genesis check.** A devnet manifest used against mainnet would derive addresses on the wrong chain. Public manifests must name their cluster's genesis and every component checks it against the RPC.
- **Binding the verifying keys by reading them from chain.** The programs embed the keys in code, so there is nothing cheap to read; the manifest records their digests and the build refuses a mismatch instead.

## Consequences

- Anyone can create, build, deploy and run a deployment on devnet or mainnet-beta with their own keys, and the default localnet behaviour is unchanged.
- No V2 build can be configured for, or deployed to, the preserved V1 program IDs on a public network.
- `BotDeployment.cluster` widens from `"localnet"` to any cluster; consent records keep the same fields. Error messages for refused public clusters changed (they now name the missing manifest or the offending field).
- `@ghostlink/service-kit` reads `GHOSTLINK_DEPLOYMENT` at import. A process serves exactly one deployment; tests that need another deployment start a new process.
- The SDK has no RPC of its own, so `GhostLink.init` validates the manifest but cannot check the chain; services, the bot, the owner consent controller and the deploy script check the genesis.
- Operators own their keys, upgrade authority, proving keys and the publication of their manifest. The development proving keys remain unsuitable for real funds.
- Testnet is not a supported cluster; the built-in deployment's refusal covers devnet and mainnet only, as before.
