# Changelog

Notable changes to GhostLink. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions are 0.x: the protocol, account layouts and package APIs can still change between releases, and nothing here is for real funds.

## 0.1.0 — 2026-11-10

The first tagged release. The packages are not on npm yet; the release carries installable archives with checksums and the development proving files.

### Added

- **Run it yourself.** A deployment manifest describes one deployment (cluster, genesis, three program IDs, verifying-key digests). One command builds the programs for your own program IDs, a guarded script deploys them, and the SDK, bot and services follow the manifest ([deployments](docs/DEPLOYMENTS.md)). One script initializes, starts, checks and stops the five services ([self-hosting](docs/SELF-HOSTING.md)), and a tool shows, sets and withdraws the census snapshot fee.
- **Sign-in for any site.** A versioned popup handoff between a site and an identity app on another origin, a reference identity app, a Next.js starter and a guide ([identity handoff](docs/IDENTITY-HANDOFF.md), [guide](docs/guides/nextjs-login.md)). The site never holds the user's identity.
- **The whole journey in the SDK.** `register`, `snapshot`, `witness`, `proveOwnerAction` and `submitOwnerAction` (sweep, revoke, policy changes), a dependency-free chain reader, and typed errors with stable codes from the relayer and `verifyLogin`.
- **Front-end runtime support.** `createWorkerProver` proves in a Web Worker; `@ghostlink/react` is a client module; `@ghostlink/verify` loads without Node built-ins and compiles its verifying key in.
- **Proving files without circom.** `node scripts/proving-artifacts.mjs fetch` downloads the development proving files from this release and checks them by SHA-256.
- **Trusted-setup ceremony tooling** and a script that compares a deployed program with a local build ([ceremony](docs/CEREMONY.md)).
- Runnable examples, contributor guides, issue templates and a manual npm release workflow with provenance.

### Changed

- **Census and registry** keep one root per 150-slot bucket, charge a snapshot fee controlled by the deployment's operator, and refuse snapshots through CPI or beside other instructions ([ADR 0005](docs/adr/0005-census-spam-resistance.md)). Their account layouts changed.
- **Pocket** refuses speculative buys of freezable tokens and can write off a frozen position, pins oracle prices to Pyth's sponsored push feeds with tighter freshness and confidence, enforces daily caps over a rolling window, retires authorizations issued before a revoke, and measures wrapped SOL delivery in lamports ([ADR 0006](docs/adr/0006-pocket-hardening.md)). The PocketV3 layout changed.
- `verifyLogin` requires `expect.minSlot` for a holdings claim and returns a discriminated result with a `code`.
- `openSession` reads the claim from the proof and waits for confirmation.
- Public clusters are no longer refused outright: they need a deployment manifest with their own program IDs.

### Security

- **Development proving keys were forgeable.** The setup script skipped the phase-2 contribution, which left delta equal to gamma, so anyone could forge login and owner proofs from the verifying key alone. The setup now adds a random contribution and verifies it; the keys, fixtures and compiled-in verifying keys were regenerated; tests reject degenerate keys and the textbook forgery.
- A cancelled passkey prompt can no longer lead to a new passkey that replaces the one an identity depends on.
- The relayer simulates a request before reserving any fee or rent.
- Rate limits use the proxy-appended client address.

### Known limits

- No official public deployment of this code exists yet. The hosted devnet app runs an earlier version.
- The proving keys are single-party development keys. A public multi-party ceremony and an external audit are required before real funds.
- A production solver must push fresh Pyth prices itself to meet the 30-second oracle freshness bound.
