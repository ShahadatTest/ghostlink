# Trusted-setup ceremony

GhostLink's proofs use Groth16, which needs a one-time setup for each circuit. Whoever knows the randomness behind a setup can forge proofs for it. A multi-party ceremony splits that randomness among many independent contributors, and forgery stays impossible as long as **one** of them destroyed their share. The repository's current keys come from `scripts/build-circuits.sh`, a single-party development setup that must never reach mainnet. No production ceremony has run yet; it is a release gate in [mainnet readiness](MAINNET-READINESS.md).

The scripts in [`scripts/ceremony/`](../scripts/ceremony/) run the ceremony on Linux or WSL. `verify.sh` checks every step, and anyone can run it without trusting the coordinator.

## What is being set up

| Circuit | Constraints | Public inputs | Proves |
| --- | ---: | ---: | --- |
| `login` | 30,138 | 12 | Registry membership, app-scoped identity, optional holdings claim, session, home and authorization-context bindings |
| `owner` | 15,248 | 4 | Pocket ownership and one exact action |

The counts are circom 2.2.3 output for the current circuits; `init.sh` prints them for the commit it sets up. [circuits/README.md](../circuits/README.md) describes the circuits.

- **Phase 1** reuses the perpetual Powers of Tau (Hermez: 54 contributions and a beacon) instead of running a new one. `powersOfTau28_hez_final_15.ptau` fits circuits whose constraints plus public inputs stay below 2^15 = 32,768; `login` uses 30,150. The scripts download it from <https://circom.info/powersOfTau28_hez_final_15.ptau> and refuse it unless its BLAKE2b digest matches the one in the [snarkjs README](https://github.com/iden3/snarkjs#7-prepare-phase-2).
- **Phase 2** is specific to the two circuits and is what contributors take part in. Each contribution covers both circuits, and a public random beacon seals the chain.

Keys belong to one exact r1cs. Changing a `.circom` file, circomlib or the circom version after `init.sh` voids the ceremony.

## Requirements

- This repository at the ceremony commit, with `pnpm install --frozen-lockfile` (pins snarkjs 0.7.6 and circomlib 2.0.5).
- Node.js 22, `curl`, `b2sum` and `sha256sum`.
- circom 2.2.3, the version CI installs, for the coordinator and for verifiers. Contributors do not need it.

## Running the ceremony

1. Freeze the circuits at an audited, tagged commit. `init.sh` refuses local changes to the circuit sources.
2. Start the ceremony in a directory outside the repository:

   ```bash
   scripts/ceremony/init.sh ~/ghostlink-ceremony
   ```

   It downloads and checks phase 1, compiles both circuits, creates the initial `<circuit>_0000.zkey` keys and writes `manifest.json` with the commit, the circom and snarkjs versions, the phase-1 digest and the SHA-256 of each `r1cs`. Publish the manifest before the first contribution. The `_0000` keys have no contribution, so their delta equals gamma and anyone could forge proofs with them; they are only the starting point.
3. Collect contributions one at a time. Send each contributor `manifest.json`, `login/login_NNNN.zkey` and `owner/owner_NNNN.zkey` (the latest keys, about 20 MB together) in that layout. They send back the next two keys and `attestations/NNNN-<name>.txt`. Add them to the directory and check the chain before passing it on:

   ```bash
   scripts/ceremony/verify.sh ~/ghostlink-ceremony <contributions so far>
   ```

   If a contribution fails to verify, move its keys and attestation out of the directory, say publicly why, and give the next contributor the previous keys. A contributor who never sends keys back is simply skipped.
4. Before the last contribution closes, announce where the beacon will come from: a future drand round, or the Solana block hash at a named future slot. Nobody, the coordinator and the last contributor included, may know its value while contributions are open.
5. When the beacon is public, seal the ceremony:

   ```bash
   scripts/ceremony/finalize.sh ~/ghostlink-ceremony <min-contributions> <beacon-hex>
   ```

   It refuses unless `verify.sh` accepts at least `<min-contributions>` attested contributions. It then applies the beacon (hashed 2^10 times), exports `final/<circuit>_vk.json`, records `beacon.txt`, writes the sealed `TRANSCRIPT.md` and verifies the result.
6. Publish `manifest.json`, `beacon.txt`, `attestations/`, `TRANSCRIPT.md`, `final/` and both `<circuit>_final.zkey` files as release assets, with the transcript's SHA-256 and the beacon's source. The numbered intermediate keys let anyone audit each step; publish them too if storage allows.
7. [Install the keys](#installing-the-keys) on a branch and redeploy the programs.

## Contributing

On a machine you trust, with this repository at the ceremony commit and `pnpm install --frozen-lockfile` done, put the files the coordinator sent you (`manifest.json`, `login/`, `owner/`) in a directory and run:

```bash
scripts/ceremony/contribute.sh <dir> "your name or handle"
```

You can type random characters at the prompt. They are hashed with 64 bytes from `/dev/urandom`, and snarkjs mixes in 64 more of its own. The entropy reaches snarkjs through a pipe: it is never written to disk, printed or put on a command line, where other users of the machine could read it. Afterwards:

- send the coordinator the two new keys and your `attestations/NNNN-<name>.txt`;
- publish the attestation yourself, somewhere you control (a signed commit, a gist, a post), because it holds your contribution hash for each circuit;
- close the terminal: your contribution protects everyone only once its randomness is gone;
- when the ceremony is sealed, check that your hashes appear in `TRANSCRIPT.md` under your contribution number.

## Verifying a ceremony

Anyone can check a sealed ceremony from its published files, with this repository at the ceremony commit:

```bash
scripts/ceremony/verify.sh <dir> <min-contributions> final
```

`verify.sh`:

- checks the Powers of Tau against the published digest, downloading it if needed;
- recompiles both circuits and requires the manifest's `r1cs` hashes, so the keys belong to the published source;
- runs `snarkjs zkey verify`, which rebuilds each key from that `r1cs` and the Powers of Tau and checks every contribution in order;
- requires every contribution to match an attestation (number, name and hash) and every attestation to appear in the chain, so a contribution that was dropped or replaced is refused. Use the attestations contributors published themselves, not only the coordinator's copies;
- requires the chain to end in one beacon contribution made from `beacon.txt`, and the verifying keys in `final/` to come from the sealed keys. Check `beacon.txt` against the announced source yourself;
- regenerates the transcript and refuses a published `TRANSCRIPT.md` that differs by a single byte.

The repository's keys must match the transcript: `circuits/keys/<circuit>_vk.json` and `packages/verify/keys/login_vk.json` have the SHA-256 listed for `final/<circuit>_vk.json`, `packages/verify/src/login-vk.ts` holds the same key compiled in (the verify tests compare them), and `cargo run -p ghostlink-verifier --bin gen-vk --features circom-vk` leaves `programs/verifier/src/vks/` unchanged.

## Installing the keys

```bash
pnpm --filter @ghostlink/common build
scripts/ceremony/install.sh ~/ghostlink-ceremony <min-contributions>
```

`finalize.sh ... --install` does the same right after sealing. `install.sh` verifies the sealed ceremony again, then writes the keys where `scripts/build-circuits.sh` writes development keys: the verifying keys in `circuits/keys/` and `packages/verify/keys/`, fresh fixture proofs in `circuits/keys/`, the Rust verifying keys in `programs/verifier/src/vks/`, and the compiled circuits plus `<circuit>_final.zkey` in `circuits/build/`, where it deletes the stale `_dev` proving keys. Proving code (`circuits/scripts/prove-fixtures.mjs`, the SDK proving test and the local end-to-end run) uses the `_final` keys when `GHOSTLINK_ZKEY_SUFFIX=final` is set.

Then run the test suites with `GHOSTLINK_ZKEY_SUFFIX=final`, rebuild the programs and commit every changed key and fixture together. This is a protocol change: proofs made with the old keys stop verifying, and the programs must be redeployed with the new keys. Do not run `scripts/build-circuits.sh` afterwards; it replaces the committed keys with new development keys.

`.zkey` and `.ptau` files never go into Git, and CI rejects them anywhere in the history. Publish them as release assets.

## Verifying deployed programs

`scripts/verify-program.sh <program.so> <program-id> [rpc-url]` compares the hash of a local build with the program deployed on chain, using `solana-verify` when it is installed. A third party can only match a reproducible build: build in Docker with `solana-verify build --library-name <lib>` and check with `solana-verify verify-from-repo`, as the script's header and Solana's [verified builds guide](https://solana.com/docs/programs/verified-builds) describe. A matching hash does not show who can upgrade the program; check that with `solana program show`.
