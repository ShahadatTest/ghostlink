# On-chain programs

Three small Anchor programs — each readable in one sitting — plus a shared verification library. In plain language: the **registry** is the one-time guestbook a wallet signs into (one signature, ever); the **census** writes down "this wallet held this much at this moment" so balances can be proved later without naming the wallet; and the **pocket** is the per-app spending account whose rules no app can talk its way around — atomic fills, an oracle-checked price floor, a daily cap, and a single exit that always points home.

| Crate | What it is |
| --- | --- |
| [`verifier/`](verifier) | Library linked into the programs: Groth16 verification (compiled-in keys), Poseidon values, Merkle frontier + root ring, intent bytes. No program of its own, so there is no cross-program trust boundary around proof checks. |
| [`registry/`](registry) | `initialize`, `register`. No update, no delete, no admin. A wallet that wants a new secret uses a new wallet. |
| [`census/`](census) | `initialize`, `snapshot`, `set_fee`, `withdraw_fees`. Permissionless: records the balance the chain shows at that moment (an SPL token account owned by the token program, or native SOL) for a fee paid into a vault; the program's upgrade authority sets the fee and withdraws it. A snapshot runs only at the top level of a transaction holding nothing but compute-budget and snapshot instructions, so nothing can lend a balance around it in the same transaction. A balance borrowed across transactions still records, so verifiers should require recent snapshots ([ADR 0005](../docs/adr/0005-census-spam-resistance.md)). |
| [`pocket/`](pocket) | `open_session_v2`, `fill_begin`/`fill_end`, `sweep_home`, `propose_change`/`execute_change`/`cancel_change`, `revoke_session`. |
| [`itests/`](itests) | LiteSVM integration tests: the compiled binaries running every flow and every refusal in the threat model. Deliberately rebuilds all instructions from raw bytes so cross-stack drift fails loudly. |

## Building and testing

```bash
bash scripts/build-programs.sh   # registry, census, pocket and the test-only CPI caller
bash scripts/test-programs.sh    # vectors, proof cross-checks, LiteSVM flows
```

The verifying keys compiled into the programs and the fixture proofs the tests use are committed, so no circuit build is needed. `scripts/build-circuits.sh` regenerates all of them together when a circuit changes.

## Invariants (tested, not yet independently audited)

- Only `fill_begin` moves tokens to a non-home address, and it cannot commit without a matching `fill_end` in the same transaction.
- Every `invoke_signed` with the pocket PDA lives in `pocket/src/token.rs` and is an SPL Token Transfer or CloseAccount the pocket issues itself.
- `open_session_v2` never changes the home or policy of an existing pocket.
- Every proof is bound to a domain and a session commitment or action hash; every root checks against a 128-entry ring that keeps one root per 150-slot bucket, so appends cannot evict a root faster than time passes.
- Planned for mainnet: upgrade authority removed after audit sign-off; a new version is a new program and users migrate by sweeping home.
