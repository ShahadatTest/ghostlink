# Circuits

Two circom circuits are the whole zero-knowledge surface of GhostLink. In plain language: `login` proves "I control a registered wallet, it held at least X recently, and here is my identity for this app only" without revealing which wallet; `owner` proves "I am this pocket's owner and I authorize exactly this action" for sweeps, revocations and timelocked changes. Everything runs over BN254 with Poseidon hashes so one toolchain covers the circuits, the browser prover and the on-chain verifier.

| File | Purpose |
| --- | --- |
| `login.circom` | The main proof: registry membership, app-scoped identity, optional holdings claim, session and home bindings, and the authorization context (purpose, policy, session kind, deployment). 12 public inputs. |
| `owner.circom` | Ownership plus a bound action hash. 4 public inputs. |
| `lib/merkle.circom` | Poseidon Merkle inclusion for the depth-26 incremental trees. |
| `test/` | Witness tests against `packages/common/fixtures/vectors.json` — valid inputs accepted, every tampering rejected. |
| `keys/` | Committed dev verification keys and fixture proofs (cross-verified in Rust). |

## Build

```bash
scripts/build-circuits.sh
```

compiles both circuits, runs a **throwaway** setup from a locally generated powers of tau with one random phase-2 contribution, proves the fixture inputs end to end, and regenerates the Rust verifying keys. A setup without a phase-2 contribution leaves delta equal to gamma, which lets anyone forge proofs; `test/vk-binding.test.ts` and the Rust verifier tests refuse such keys.

**Dev keys only.** Whoever runs the setup could forge proofs for the keys it produces. Mainnet keys must come from the perpetual Powers of Tau plus a public per-circuit ceremony with many independent contributors and a published transcript. Any circuit change means a new ceremony and a new program deployment — budget for it in every milestone that touches this directory. The public-input order is a protocol contract with the programs; never reorder it.
