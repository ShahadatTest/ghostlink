# Contributing to GhostLink

Thanks for helping build GhostLink. The project is early, so now is a good time to shape it. Bug reports, tests, docs, examples and integrations are all welcome.

## Ways to help

- **Try the [quickstart](README.md#quickstart)** and open an issue for anything confusing. Fresh eyes find real problems.
- **Pick up an issue** labelled [`good first issue`](https://github.com/Ghostlink-Labs/ghostlink/labels/good%20first%20issue) or [`help wanted`](https://github.com/Ghostlink-Labs/ghostlink/labels/help%20wanted).
- **Add tests.** Regression tests for authorization, funds and persistence are the most valuable.
- **Improve the developer experience**: error messages, examples, typed APIs, docs.
- **Build integrations.** Wanted: language clients (Python, Rust, Go), DEX route adapters, Token-2022 extension support and wallet integrations. Open a [feature request](https://github.com/Ghostlink-Labs/ghostlink/issues/new?template=feature_request.yml) first so we can agree on the design.

## Set up your machine

| Area | You need |
| --- | --- |
| TypeScript packages and services | Node 22.16 or newer, or Node 24 (see `.nvmrc`), and pnpm 10.33.2. `corepack enable` picks up the pinned version; on Windows, if it fails with `EPERM`, run it once in an administrator terminal or use `npm install -g pnpm@10.33.2` |
| Solana programs | Linux or WSL, Rust 1.97.1 (pinned in `rust-toolchain.toml`), Agave/Solana CLI 3.0.x, SBF platform tools v1.52 |
| Circuits | circom 2.2.3 and the TypeScript setup above |

```bash
git clone https://github.com/Ghostlink-Labs/ghostlink.git
cd ghostlink
corepack enable
pnpm install --frozen-lockfile
pnpm -r build
pnpm -r typecheck
pnpm -r test
```

Programs, under Linux or WSL:

```bash
bash scripts/build-programs.sh   # registry, census, pocket and the test CPI caller
bash scripts/test-programs.sh    # Rust unit tests, vectors, proof checks, LiteSVM flows
```

The committed fixture proofs and verifying keys in `circuits/keys/` are enough for the test suite to pass. Without built circuit artifacts, the tests that generate new proofs are skipped, and the service shutdown tests run only on Linux and macOS; CI runs them all. You never need to regenerate proving keys for a normal change. During `pnpm install`, the "Ignored build scripts" notice is expected: those optional native builds are not needed. The [setup guide](docs/SETUP.md) covers fresh circuit builds and the full local-validator end-to-end run (`bash scripts/localnet-e2e.sh`).

Install `node_modules` separately on each operating system. Copying it between Windows and Linux breaks platform-specific dependencies.

## Which checks to run

| You changed | Run at least |
| --- | --- |
| `packages/*` | `pnpm --filter <package> test`, then the full TypeScript gates above; `pnpm test:package` if exports or packaging changed |
| `services/*` | `pnpm --filter <service> test`, then the full TypeScript gates |
| `programs/*` | `bash scripts/build-programs.sh && bash scripts/test-programs.sh` |
| `circuits/*` | The fresh proving setup in [docs/SETUP.md](docs/SETUP.md). Proving keys, fixtures and Rust verifying keys must change together |
| `packages/common/src` encodings | `pnpm test:vectors`. A changed `fixtures/vectors.json` is a protocol change: say so in the PR |
| `examples/*` | `pnpm --filter "./examples/**" test` |

CI runs all of this on every pull request: TypeScript build, typecheck, tests, installed-package tests and dependency audit, plus circuits and Rust/SBF/LiteSVM jobs.

## Pull requests

1. Branch from `main`: `feat/<area>-<short-name>` or `fix/<area>-<short-name>`.
2. Keep each pull request to one logical change. Write [Conventional Commit](https://www.conventionalcommits.org/en/v1.0.0/) messages (`feat:`, `fix:`, `docs:`, `test:`, `chore:`) in the imperative mood.
3. Open the pull request with the template. Start with one plain-language paragraph, then **What changed**, **How it was tested** and **Risks**.
4. Add a regression test for anything that could move funds, weaken authorization or lose persisted state.

Changes to authorization rules, account layouts, proof public inputs or the trust model need a short decision record in [`docs/adr/`](docs/adr/). Read the [threat model](docs/THREAT-MODEL.md) first. A maintainer can help you write it.

## Ground rules

- **Never commit secrets**: keypairs, identity secrets, seed phrases, API keys, private RPC URLs, `.env` files, databases or proving keys. Test fixtures in `circuits/keys/` are public data.
- Do not regenerate production keys, deploy programs or publish packages as part of a routine change.
- Report vulnerabilities privately. See [SECURITY.md](SECURITY.md), not the issue tracker.
- Do not claim more than the evidence shows. A passing test does not prove the absence of vulnerabilities.
- This repository covers the protocol, SDKs, circuits, reference services and technical docs. The hosted GhostLink application, editable designs and brand assets are not part of it. The four documentation screenshots in `docs/media/screenshots/` have [their own terms](docs/media/screenshots/LICENSE.md). Don't add other product captures or brand assets.
- Follow the [code of conduct](CODE_OF_CONDUCT.md).

## License

By contributing, you agree that your contribution is licensed under the repository's [Apache-2.0 license](LICENSE).
