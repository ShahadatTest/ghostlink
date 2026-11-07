# ADR 0006: Pocket hardening after the internal review

Status: implemented development candidate, 2026-11-07. Localnet only: not deployed, not independently reviewed. Amends [ADR 0003](0003-session-authorization-v2.md) (authorization context) and [ADR 0004](0004-bounded-speculative-trading.md) (daily windows, frozen positions).

## Context

An internal review of the PocketV3 candidate found five weaknesses:

1. **Frozen speculative position (high).** A speculative buy could acquire a token whose issuer keeps a freeze authority. Freezing the pocket's token account made every exit and sweep of it fail, `sweep_home` failed for any batch containing it, and `execute_change` then refused every policy change with `PositionsOpen`, so speculative permission could never be removed.
2. **Oracle choice (medium).** Any receiver-owned `PriceUpdateV2` with the right feed id was accepted. Anyone can post a pull update to a fresh account, so a solver could pick the most favourable price published inside the 60-second window. There was no confidence bound.
3. **Fixed daily window (medium).** The daily cap reset `SLOTS_PER_DAY` after the window opened, so the cap could be spent just before the reset and again just after it: twice the cap within seconds.
4. **Revoke left authorizations alive (medium).** Revoking only zeroed the session expiry. A session-opening proof issued earlier, with an expiry beyond the replay floor, could still be submitted afterwards and reinstate a session.
5. **Unsynced wrapped SOL (medium).** Lamports sent to the pocket's wrapped-SOL output account without `SyncNative` are not part of its token amount. A solver could sync them during its route, and `fill_end` counted them as delivery.

PocketV3 has never been deployed, so its account layout changes in place. The allocation grows from 3,293 to 3,693 bytes; readers reject every other size, including the old one. The account discriminator and the policy format and hash domain (`ghostlink:policy:v3`) are unchanged.

## Decisions

### 1. Freezable mints and frozen positions

Both recommended measures are implemented.

**(a) Prevention.** `fill_begin` takes the intent's output mint as a new final account (address-constrained to `out_mint`). A speculative buy (mode 1) parses it as a classic SPL mint and is refused with `FreezableMint` (6047) when it has a freeze authority. SPL Token never re-enables a removed freeze authority (`SetAuthority` on a mint without one fails with `MintCannotFreeze`), so the token account a position is held in can never be frozen afterwards and the position can always be exited or swept. Priced trades are unaffected: base assets such as USDC keep their issuer's freeze authority.

**(b) Recovery.** `sweep_home` skips a frozen source instead of failing the batch, so one frozen account never blocks the rest of a recovery. With an owner proof it also writes off a speculative position held in a frozen account: the ledger entry is cleared, a `PositionWrittenOff` event records the account, mint, quantity and cost, and `execute_change` is no longer blocked. A session-signed sweep leaves the position recorded. The tokens stay in the pocket-owned account; a later sweep returns them home if the issuer ever thaws it. The reference relayer passes frozen sources through, creates and charges nothing for their destination, and marks the pair `frozen: true`.

Why both: (a) removes the cause for every position this program can create. (b) covers states (a) cannot rule out, such as a token-program change or later Token-2022 support, and also stops a frozen non-speculative account (for example USDC frozen by its issuer) from failing an owner's recovery batch.

Writing off is an owner decision because it releases the position's recorded cost, which later buys can reuse. It has the same accounting effect as a total-loss exit, which the session can already make. The sweep digest does not bind its token pairs, so a relayer holding an owner sweep proof decides whether a frozen tracked account is included; the tokens cannot move either way, and the only effect is that write-off.

Alternatives considered: a dedicated write-off instruction whose owner proof binds the token account (more explicit consent, but a new proof type and relayer route for a state that (a) already prevents); refusing every freezable output mint (would refuse USDC and similar priced outputs).

### 2. Oracle accounts

`read_price` now requires, in order:

1. the account address to be the push-oracle PDA of `(shard 0 as u16 little-endian, feed id)` under `pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT`, the account Pyth's sponsored pusher keeps current (`OracleNotCanonical`, 6048);
2. the Pyth receiver `rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ` as owner, the `PriceUpdateV2` discriminator and full verification (`BadOracle`);
3. the pinned feed id and a positive price (`BadOracle`);
4. a confidence interval of at most 1% of the price, `MAX_ORACLE_CONF_BPS = 100` (`OracleConfidence`, 6049);
5. a publish time at most 30 seconds before the cluster clock, down from 60 (`StaleOracle`);
6. a posted slot at most 75 slots (about 30 seconds) behind the current slot, which bounds age on Solana's own slot clock if its unix timestamp drifts (`StaleOracle`).

The derivation matches Pyth's SDK (`getPriceFeedAccountForProgram`: a two-byte little-endian shard followed by the feed id) and reproduces Pyth's published shard-0 SOL/USD account `7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE`; a Rust unit test and a TypeScript test pin that address. Both programs are the original Pyth Core pair, which Pyth upgraded in place on 2026-08-26 with unchanged addresses.

Why pinning closes the finding: the push oracle writes an update only when its publish time is newer than the stored one, so the pinned account only moves forward. A solver can no longer present an older posted update or choose among several pull accounts. Residual choice: anyone may push a newer update, so a solver that refreshes the account chooses among prices published since the last stored update, at most 30 seconds of history. Pyth's mainnet sponsored feeds also update on a 0.5% move, which bounds how far those prices differ while the pusher is live. Pinning was workable, so the weaker fallback of a per-pocket monotonic publish time was not needed.

Consequences: Pyth's mainnet sponsored feeds mostly use a 60-second heartbeat (some 30 seconds or 4 minutes), and devnet USDC/USD has been observed at about five minutes. Between updates a price can be older than 30 seconds, so a production solver must push a fresh update through the push oracle (Hermes access and fees) or wait for the next sponsored one. The reference solver does not push updates; it refuses configured accounts that are not the sponsored account of their feed and relies on simulation for freshness. Each price read derives one PDA on-chain. Moving to Pyth's "Core Compatible" receiver and push oracle (`rec2…`/`pyt2…`) would change both addresses and is a separate deployment decision.

### 3. Rolling daily windows

Priced spending against `daily_cap_usd_e6` and speculative buys against `daily_buy_cap_usd_e6` are each recorded in a `RollingWindow`: 25 hourly buckets of 9,000 slots, the current hour and the 24 before it. A spend is allowed only when the window's total plus the spend stays within the cap. Nothing resets a window; buckets age out.

**Guarantee.** For any two accepted spends at slots `a ≤ b` with `b − a < 216,000` (one day at 400 ms per slot), everything accepted in `[a, b]` totals at most the cap. Their buckets differ by at most 24, so all of those spends are still in the window when the latest is checked. Equivalently, no span shorter than a day holds more than one cap of spending, and two full caps need at least a day between the first spend of the first and the last spend of the second. A spend frees its budget when its hour leaves the window, between 24 and 25 hours after it happened. Exits (mode 2) carry no priced input and record nothing.

Alternatives considered: 24 buckets as suggested (guarantees only spans shorter than 23 hours); an exact log of every spend (unbounded); finer buckets (more account space for a shorter release delay).

The two windows add 400 bytes. Anchor holds the account struct on the 4 KiB SBF stack while loading it, which overflowed `open_session_v2`'s account loading, so the speculative ledger now lives in a `Box`. Borsh encodes a box exactly like its contents, so this changes no bytes on chain.

### 4. Revocation epoch

`PocketV3.authorization_epoch` is a `u64` at fixed offset 146, right after `session_expiry_slot`, so owner software can read it without a policy decoder. `revoke_session`, by owner proof or by the session itself, increments it. The session-opening authorization context becomes:

```text
SHA256(
  UTF8("ghostlink:open-session:v3") ||
  pocket_program_id[32] || registry_program_id[32] || census_program_id[32] ||
  SHA256(canonical_policy_bytes)[32] || session_kind[u8] || authorization_epoch[u64 LE]
) interpreted big-endian and reduced modulo the BN254 scalar prime
```

The program recomputes it from the stored epoch (zero for a new pocket), so a proof made for an earlier epoch never verifies. The instruction name and arguments are unchanged.

**Guarantee.** After `revoke_session`: no session-opening proof produced before it can open or renew a session, whatever expiry it carries; every owner or session-signed administrative authorization produced before it is already dead because revoke consumes `owner_action_nonce`; and intents signed by the revoked key fail until a new authorization, necessarily produced after the revoke, opens a session for that key again. Re-authorizing a previously revoked key would make its unexpired, unused intents usable again; the bot and SDK generate a fresh key for every consent, and owner software must not reuse a revoked key.

Alternatives considered: raising the expiry floor to `now + session_max_slots` at revoke (no proof change, but an authorization created with an expiry beyond that horizon survives, so not every earlier authorization dies); binding the epoch into intents (an intent format change not needed for this finding).

Consequences: owner software reads the epoch before proving. `pocketAuthorizationContext` takes it as a fourth argument (default zero), `pocketAuthorizationEpoch` reads it from account data, `OwnerConsentController` requires a `readAuthorizationEpoch` reader and refuses to release a proof if the epoch changed while proving, authorizations record the epoch they bind, and `verifyLogin` accepts `expect.pocket.authorizationEpoch`. A renewal proved before a revoke must be proved again. The committed V2 login fixtures were regenerated with the unchanged development keys; only their authorization-context signal changed.

### 5. Wrapped SOL delivery

`fill_begin` snapshots, and `fill_end` measures, the output account's delivery balance: its token amount, or for a native (wrapped SOL) account its lamports, synced or not. Delivery is the difference. Lamports move only through real transfers; `SyncNative` merely copies lamports the account already holds into its token amount, so lamports the pocket held before the fill are always in the snapshot.

The first version measured lamports above the reserve recorded in SPL's `is_native` field. The token program bundled with LiteSVM also rewrites that reserve to the current rent on `SyncNative` (2,039,280 to 1,488,440 lamports for a 165-byte account there), so a route could count part of the pocket's own reserve as delivery; raw lamports do not have that problem. Lamports a route adds during the fill count, synced or not; they belong to the pocket either way, and a sweep closes the account home with all of them.

Alternatives considered: a `SyncNative` CPI in `fill_begin` (adds a third CPI kind to the audited Transfer/CloseAccount-only surface, makes the output account writable in both instructions, and still meets the reserve rewrite); refusing unsynced accounts (anyone can unsync the account by sending it lamports, a griefing vector unless every solver prepends `SyncNative`).

## Interface changes

- PocketV3 layout: `authorization_epoch` after `session_expiry_slot`; a `spending` window replaces `day_start_slot` and `spent_today_usd_e6`; the speculative ledger's `buys` window replaces `bought_today_usd_e6`. Size 3,293 → 3,693 bytes.
- `fill_begin` gains a final read-only `out_mint` account.
- New errors, appended: `FreezableMint` 6047, `OracleNotCanonical` 6048, `OracleConfidence` 6049. New event: `PositionWrittenOff`.
- TypeScript: `pythPushFeedAddress` and the Pyth program constants in `@ghostlink/common`; `pocketAuthorizationContext(policy, kind, deployment?, epoch?)` and `pocketAuthorizationEpoch(data)`; `encodePocketAccount`, the window fields and `rollingWindowTotal` in the service kit; the solver checks configured price accounts; the relayer and indexer handle frozen sources and write-offs.

## Evidence

Compiled-program LiteSVM regressions in `programs/itests/tests/pocket_hardening.rs` cover each finding: freezable mints refused, frozen-position write-off unblocking `execute_change`, session sweeps skipping frozen accounts, every oracle refusal and its exact bounds, the daily cap at the old reset slot and at the bucket boundary, pre-revoke authorizations refused after owner and session revokes, and unsynced wrapped SOL never counted as delivery. Unit tests cover the window arithmetic, the write-off helper, the lamport measurement and the sponsored-account derivation. This is local evidence, not an independent audit or a public-network deployment.

## Remaining gates

Independent review of these changes; a solver price-pushing path and its cost model before any public deployment; owner-UI handling of the epoch reader; and the open items of ADRs 0003 and 0004 and [MAINNET-READINESS.md](../MAINNET-READINESS.md).
