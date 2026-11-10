# Owner recovery destinations

The PocketV3 localnet candidate returns funds only to the saved on-chain recovery home. An owner proof remains usable after losing or revoking a bot session. Read the current owner action nonce before proving; successful administrative actions consume it. Existing deployed V1 programs are separate.

## With the SDK

`@ghostlink/sdk` does the reading, proving and submitting: revoke first, then recover each batch of token accounts. The client is the one from the [SDK guide](../packages/sdk/README.md#the-whole-journey), with a `chain` reader and an owner-circuit prover, opened at the origin whose pocket you recover.

```ts
import { associatedTokenAddress, type DerivedIdentity, type GhostLink } from "@ghostlink/sdk";

declare const client: GhostLink;            // GhostLink.init({ ..., chain, prover }) as in the SDK guide
declare const identity: DerivedIdentity;    // deriveIdentity with the registering wallet
declare const walletPublicKey: Uint8Array;  // that wallet
declare const pocketAddress: Uint8Array;    // client.pocketFor(...).address, or derivePocket(appId, home).address
declare const mints: Uint8Array[];          // the tokens the pocket holds

const witness = await client.witness({ identity, wallet: walletPublicKey });
// 1. Stop the session: no bot can trade, and no authorization made before this can open a session again.
await client.submitOwnerAction(await client.proveOwnerAction({ identity, witness, action: "revoke" }));
// 2. Recover, at most two token accounts per request. The proof binds the current nonce; prove each batch afresh.
for (let i = 0; i < mints.length; i += 2) {
  const sweep = await client.proveOwnerAction({ identity, witness, action: "sweep" });
  await client.submitOwnerAction(sweep, {
    tokenPairs: mints.slice(i, i + 2).map(mint => ({ source: associatedTokenAddress(pocketAddress, mint), mint })),
  });
}
const after = await client.pocketState(pocketAddress); // after.ownerActionNonce has moved on; after.home is unchanged
```

`proveOwnerAction` reads the pocket's current `owner_action_nonce` and recovery home through the client's `chain` reader, proves on the device, and refuses if the nonce moved while proving. `submitOwnerAction` sends the relayer request described below without `destination`, so the relayer selects or creates clean home-owned accounts, and waits for confirmation. A wallet that pays its own fees uses `ownerActionInstructions(sweep, { payer, tokenPairs })` instead; it needs explicit destinations that meet the same rules. Home and policy changes use `action: "propose"` with `change: { home }` or `change: { policy }`, and `action: "cancel"`; the reference relayer submits home changes only, so send a policy change with `ownerActionInstructions`. A staged change executes after the 24-hour timelock with `executeChangeInstructions`, which anyone may send.

## Token accounts

A wallet's associated token address is a convention, not proof of current ownership. Classic SPL `SetAuthority` can change the account owner. A home token account may also be frozen or carry an external delegate/close authority. Hard-coding its associated address can prevent withdrawal or expose returned assets to old permissions.

For `POST /owner-action` with `action: "sweep"`, send the confirmed `home` and token pairs containing `source` and optional `mint`. **Omit `destination` to request automatic home recovery.** The relayer reads confirmed Pocket/source/destination accounts with a monotonic slot floor, checks the source owner/mint and exact recovery home, then:

1. Reuses the home's associated account when it is initialized, unfrozen, has no delegate, and has no close authority outside the home.
2. Creates the associated account if absent, including a prefunded empty system account.
3. Otherwise creates a fresh auxiliary classic SPL account owned by the same home. Creation, initialization and the proof-authorized sweep are atomic in one transaction. The new address's temporary creation signer is not the token owner or close authority. The home can control the account without that signer.

Sources of the same mint share one automatically selected destination in a batch. A provided `destination` is never silently replaced: it must satisfy the same authority checks, or be the missing canonical account that can be created. A source whose owner, mint or state is invalid is refused. Token-2022 remains unsupported.

A frozen source (its mint's freeze authority locked it) cannot move or close, so the program skips it instead of failing the whole batch, and the relayer neither creates nor charges for its destination; the response marks that pair `frozen: true`. Its tokens stay in the pocket-owned account and a later sweep returns them if the account is ever thawed. With an owner proof the sweep also writes off a speculative position held in a frozen account (`PositionWrittenOff` event), which releases its recorded cost and lets a pending policy change execute; a session-signed sweep leaves the position recorded. Speculative buys refuse mints that have a freeze authority, so this path only covers positions frozen by means the buy check cannot rule out ([ADR 0006](adr/0006-pocket-hardening.md)).

The program independently enforces destination ownership/mint, no delegate and no external close authority. The relayer cannot bypass those checks. Sources with an external close authority can still return their complete balance; their empty account/rent may remain. The relayer charges actual quoted transaction fees plus required account rent within its spend budget. A failure before submission does not spend that rent.

Use batches of up to two source accounts: two fresh destinations plus the proof and signatures have been tested within Solana's packet limit. The endpoint's admission limit is 16 pairs, but larger packets are not guaranteed to fit. No lookup table is required for the tested two-account batch.

## Confirmation and retries

A successful response includes `signature` and resolved `tokenPairs: [{source,destination,mint}]`. These are public addresses, not authorization. Verify the consumed owner action nonce, unchanged home, complete source withdrawal and destination ownership/balances on the confirmed chain. Native SOL above Pocket rent is returned as part of the same sweep.

After a lost response, check that same action's outcome. With the SDK, call `submitOwnerAction` again with the same authorization: its request ID is the request's digest, so the relayer reconciles the original operation instead of sending another. Query home-owned token accounts to find an auxiliary destination if needed; it may differ from the canonical associated address. Do not automatically produce another owner proof because an HTTP response was lost. The consumed nonce prevents replay from creating another account or withdrawing again. A new deliberate recovery step requires fresh chain state and a new proof.

## Reproduction

Build the current programs and services, then run the disposable-validator harness:

```sh
RECOVERY_DESTINATION_DRILL=1 bash scripts/localnet-e2e.sh
```

The drill performs real SPL owner, delegate and close-authority changes. It reproduces refusal of a reassigned canonical destination, recovers two same-mint sources into one clean home-owned account, refuses replay, and atomically recovers two more mints while avoiding their external destination authorities. Compiled-program regressions separately reject unsafe destinations and preserve the source balances/nonce on failure. These are local-validator tests, not public-network deployment or independent security review.

Reference: [SPL Token processor authority and account rules](https://github.com/solana-program/token/blob/main/program/src/processor.rs).
