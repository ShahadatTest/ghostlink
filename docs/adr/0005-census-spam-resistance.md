# ADR 0005: census and registry spam resistance

Status: implemented development candidate, 2026-11-07. Localnet only, no independent security review or public deployment. Changes the registry and census account layouts, the census instructions and the registry event; existing deployments are unchanged.

## Context

An internal review raised two census findings.

1. **Snapshots were free and unlimited (high).** Both trees kept their last 128 roots in a ring that advanced on every append. A few transactions full of snapshot instructions evicted every census root, so holdings proofs in flight failed with `UnknownCensusRoot`. Filling the depth-26 tree (2^26 leaves) took about 1.5 million transactions, roughly 7.5 SOL of base fees, after which the census accepts nothing.
2. **Snapshots recorded borrowed balances (medium).** An account could borrow tokens, snapshot and repay inside one transaction, or have a program that borrows call the census through CPI. The leaf then recorded a balance the wallet held only for that instruction.

The registry shares the same ring code (`ghostlink_verifier::merkle::RootRing`). Each registration needs a new wallet and pays about 0.0013 SOL of binding rent, so evicting all 128 registry roots cost about 0.16 SOL. That blocks login proofs and, worse, owner proofs (sweep, revoke, change) that recovery depends on. Filling the registry is not a practical concern: 2^26 bindings cost about 86,000 SOL in rent.

## Decision

### Time-bucketed root history (registry and census)

The ring keeps one root per bucket of `ROOT_BUCKET_SLOTS = 150` slots (about a minute at 400 ms per slot). `RootRing::record(root, slot)` overwrites the newest entry while `slot` is in that entry's bucket and pushes a new entry only when the bucket changes. Each entry stores the slot of its last write (`root_slots: [u64; 128]`, appended after the existing fields). However many appends arrive, 128 entries span at least 128 buckets: 19,200 slots, about 2.1 hours. Spam cannot evict roots faster than time passes, and spending more does not help.

Why 150 slots:

- The pocket accepts a holdings claim only while its snapshot is at most `MAX_MIN_SLOT_LAG` = 9,000 slots (about an hour) old. Eviction can never come before staleness when 128 buckets exceed 9,000 slots, which needs at least 71 slots per bucket. 150 gives more than twice that margin. Registry roots have no age limit and survive at least 2.1 hours of maximal spam, far longer than proof generation, submission and retry.
- A new leaf becomes provable only after its bucket ends, so the bucket is also an onboarding delay: at most about a minute, half that on average, plus indexer finality. A larger bucket would add margin no flow needs and lengthen every first login.

The newest entry can change until its bucket ends, so provers use the root of a **completed** bucket. The pocket still accepts any root in the ring; a proof against an open bucket's root works only until the next append in that bucket.

### Snapshot fee (census)

A `Config` PDA (`[b"config"]`) holds `fee_lamports`, initialized to `DEFAULT_SNAPSHOT_FEE_LAMPORTS` = 100,000 lamports (twenty times a signature's base fee). Every snapshot transfers the fee from the payer to a program-owned `FeeVault` PDA (`[b"fee_vault"]`). Filling the tree now costs about 6,700 SOL in fees alone. The payer names the most it accepts (`snapshot(max_fee_lamports)`), so a fee raised while a transaction is in flight fails it instead of charging more.

`set_fee` and `withdraw_fees` require the signer to be the census program's **upgrade authority**, read from its ProgramData account. `initialize` stays permissionless and stores nothing about the caller. This adds no key and no trust beyond the upgrade authority, which can already replace the program; it leaves no initialization race to front-run; and authority rotation follows `solana program set-upgrade-authority`. Withdrawals never take the vault below its rent-exempt minimum.

### Transaction guard (census)

`snapshot` refuses to run below the top level (`get_stack_height() == 1`, `CpiForbidden`) and reads the instructions sysvar: every instruction in the transaction must be a compute-budget instruction or a census `snapshot` (`ForeignInstruction`). Nothing in the same transaction can lend a balance before the snapshot reads it or take it back afterwards. Several snapshots may share a transaction.

### Off-chain consumers

- The indexer records the slot of every leaf (the `Registered` event gains a `slot` field; `SnapshotTaken` already had one) and serves roots, paths, leaves, bindings and latest snapshots only for leaves of buckets that have ended before the slot through which it has applied all history. A leaf it holds but cannot serve yet answers 404 with `completesAfterSlot`. `/roots` lists one root per completed bucket within the ring's 128 entries. After a reconciled scan it checks that the ring still holds the served bucket's root, and treats a different root, or a missing entry while older entries remain, as contradictory history.
- The SDK raises `WitnessPendingError` for those 404s. Local witnesses rebuild from the served leaves, so they end on a completed root.
- The relayer reads the fee from the config account, refuses fees above `RELAYER_MAX_SNAPSHOT_FEE_LAMPORTS` (default 0.001 SOL), passes the fee it read as the maximum and reserves it in its daily budget.

## Alternatives considered

- **A bigger ring.** It raises the eviction cost linearly but keeps it a cost: 4,096 roots need a 128 KiB account and fall to 4,096 snapshots.
- **A fee alone.** With one root per append, 128 snapshots at 100,000 lamports still evict the whole ring for about 0.013 SOL. Bucketing is what fixes eviction; the fee prices tree growth.
- **Accept any root younger than N slots.** It needs every root of the window on chain, which is unbounded under spam.
- **A fee authority stored at initialization.** It is front-runnable unless initialization is gated on the upgrade authority anyway, and it adds a key and rotation logic. If operators later want routine withdrawals without the upgrade key, add a stored authority set by the upgrade authority.
- **Burning the fee, or requiring a minimum priority fee.** Burning needs no administrator but loses the option to fund operations. Priority fees go to the slot leader, so a validator, or anyone with a bundle service, gets them back.
- **Per-wallet rate limits or a per-slot cap.** Wallets are free to create, and a global cap lets an attacker crowd out honest snapshots.
- **Checking only earlier instructions** (`sol_get_processed_sibling_instruction`). Later instructions cannot change a balance already read, so that would be sufficient for this finding, but the instructions sysvar check is simpler to state, covers both directions and is what the finding asked for.

## Consequences

- A registration or snapshot becomes provable about a minute after it lands (at most 150 slots plus indexer finality). Apps must handle the indexer's 404 and retry after `completesAfterSlot`.
- Each snapshot costs the fee. Relayed snapshots draw the relayer's daily budget twenty times faster than the network fee alone; the per-holding, per-IP and budget limits still apply.
- A snapshot transaction cannot carry anything else: create token accounts, transfer or advance a durable nonce in a separate transaction. Durable-nonce snapshot transactions are refused.
- The upgrade authority can change the fee and withdraw collected fees. A zero fee removes the growth price; a very high fee stops new snapshots without affecting existing leaves or proofs. Making the program immutable freezes the fee and locks the vault: withdraw and set the final fee first.
- **Borrowing across transactions is still possible.** Borrowing in one transaction, snapshotting in a second and repaying in a third records a balance the wallet held only briefly, at the price of the loan's interest and its risk. A snapshot proves a balance at one slot, not ownership. Apps should:
  - require a fresh `min_slot` window (`verifyLogin` already refuses holdings claims without `expect.minSlot`), keeping it as short as their users can tolerate;
  - set thresholds high enough that renting the balance for the window costs more than the gate is worth, and gate nothing irreversible on one snapshot;
  - for high-value gates, ask for proofs from several snapshots taken over time or combine the claim with other evidence, and keep one claim per `app_id`.
- `TreeState` grows by 1,024 bytes. The pocket program's raw ring reader is unchanged: roots keep their offsets and it only requires the account to be at least that long.

## Migration

The live devnet registry and census are the preserved V1 deployment. Their `TreeState` accounts lack the slot array and their census has no config or fee vault, so neither can be upgraded in place: deploy fresh program IDs (or a fresh deployment of this candidate), initialize both trees, and have users register again. Rebuild the pocket program against the new registry and census IDs. Indexer checkpoints from before this change have no leaf slots and are refused: provision a fresh indexer state (`services/indexer/dist/initialize.js`) and rebuild it from the new deployment's history. Relayers need no migration beyond the optional `RELAYER_MAX_SNAPSHOT_FEE_LAMPORTS`. Before any mainnet deployment, choose the fee deliberately and decide who holds the upgrade authority that governs it.

## Evidence

- LiteSVM (`programs/itests/tests/census_spam.rs`): 200 snapshots inside one bucket leave an earlier bucket's root valid and use one ring entry; the committed fixture proof opens a pocket against its pre-spam census root after the burst; 130 buckets keep one root each and only time evicts; the registry ring behaves the same under 132 registrations; the fee is charged, capped by the payer's maximum, changeable and withdrawable only by the upgrade authority, never below the rent floor; CPI, a lend before or after the snapshot and a non-snapshot census instruction are refused without charging; a full tree is refused without charging.
- `flows.rs` replays the fixtures through the new instruction shapes; verifier unit and vector tests cover the ring.
- Indexer tests cover served and pending leaves over HTTP, completion by later leaves and by the poller horizon, restore, slot regression, the served-root availability and contradiction checks, and chain vouching for superseded roots. Relayer, SDK and shared-decoder tests cover the fee budget and cap, `WitnessPendingError` and the event layout.
- The localnet end-to-end run pays the default fee through the relayer, waits for both buckets to end and proves against the served roots.
