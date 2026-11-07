# GhostLink SDK

Experimental TypeScript/JavaScript SDK for Solana identity proofs and policy-controlled pockets. Node.js bot backends and browser applications can use the same intent format. **V2 candidate: localnet only; not deployed.** This is not an integration with any named trading bot, and installing it does not grant a bot permission to trade.

For Telegram backend authentication, encrypted session storage and confirmed consent checks, see the separate [`@ghostlink/bot` package](../bot/README.md). It uses this SDK without sharing owner identity secrets with the bot.

## Install from reviewed source

Use Node 22 and pnpm 10.33.2. From a reviewed checkout of `Ghostlink-Labs/ghostlink`:

```sh
pnpm install --frozen-lockfile
pnpm pack:sdk
pnpm test:package
```

The archives and SHA-256 checksums are written to `artifacts/sdk/`. Copy the `@ghostlink/common` and `@ghostlink/sdk` archives to your project, plus `verify`, `prover-wasm` or `react` if you use them. No npm registry release is implied by the package name. Do not install an unrelated package with a similar name.

For npm, install the archives you need together:

```sh
npm install ./ghostlink-common-0.1.0.tgz ./ghostlink-sdk-0.1.0.tgz
```

For pnpm, set the unpublished dependency's local resolution in the bot project's `package.json`, then install the archives:

```json
{
  "pnpm": {
    "overrides": { "@ghostlink/common": "file:./ghostlink-common-0.1.0.tgz" }
  }
}
```

```sh
pnpm add ./ghostlink-common-0.1.0.tgz ./ghostlink-sdk-0.1.0.tgz
```

ES modules use `import`. CommonJS applications can use `await import('@ghostlink/sdk')` inside an async function. TypeScript declarations are included. The package check installs into a separate temporary project, checks imports/types, and verifies a real intent signature; it does not send a transaction.

## Identity and registration

An owner's identity is derived on their own device from wallet signatures over a fixed Sign-In-With-Solana message, then registered once. The secret never leaves the device. The relayer receives only the commitment and the wallet's signature over the registration message.

```ts
import { buildRegistration, deriveIdentity, prepareRelayerOperation, RelayerClient } from '@ghostlink/sdk';
import { bytesToHex, fieldToBytes32, pk, REGISTRY_PROGRAM_ID } from '@ghostlink/common';

// Must resolve to the wallet's 64-byte Ed25519 signature over exactly `message`.
const signMessage = async (message: Uint8Array): Promise<Uint8Array> => walletSignature(message);
// Optional: the wallet's raw Wallet Standard `solana:signIn` feature. Its array result is accepted.
const signIn = wallet.features['solana:signIn']?.signIn;

// deriveIdentity(signer, { cluster, domain, address, secondFactor?, allowNonDeterministic? })
const identity = await deriveIdentity({ signMessage, signIn }, {
  cluster: 'localnet', domain: 'app.example.com', address: walletAddressBase58,
});

// buildRegistration(identity, walletPubkey, registryProgramId, cluster, signMessage)
const registration = await buildRegistration(
  identity, walletPublicKeyBytes, pk(REGISTRY_PROGRAM_ID), 'localnet', signMessage,
);
const operation = prepareRelayerOperation('/register', {
  walletPubkey: walletAddressBase58,
  messageHex: bytesToHex(registration.message),
  signatureHex: bytesToHex(registration.signature),
  commitmentHex: bytesToHex(fieldToBytes32(identity.commitment)),
});
await encryptedStore.save(operation.requestIdHex, operation);
const receipt = await new RelayerClient(approvedRelayerUrl).submit(operation);
```

- `deriveIdentity` requests the same text twice and checks both signatures against `address`. It refuses a wallet whose two signatures differ (`NonDeterministicSignerError`), because that identity could never be derived again. The same wallet, `domain`, `cluster` and second factor always give the same identity.
- The registry checks a cluster tag in the registration message. Its default build, which a local validator runs, expects `devnet`, so `buildRegistration(..., 'localnet', ...)` signs `cluster:devnet`. `'mainnet-beta'` signs `cluster:mainnet-beta` for the mainnet build. `registrationClusterTag(cluster)` returns the tag. The identity's sign-in text still says `Chain ID: localnet`.
- The registry accepts one registration per wallet and has no update. Register only an identity you can reproduce.

### Optional passkey factor

`secondFactor` mixes a WebAuthn PRF output into the secret, so a phished wallet signature alone cannot reproduce it. The passkey becomes part of the identity: a different passkey derives a different identity, and a registered wallet cannot register again. The SDK therefore never creates a passkey implicitly.

```ts
import { createPasskeyFactor, passkeyFactor, PasskeyFactorError } from '@ghostlink/sdk';

// Brand-new identity only: the wallet has no registry binding yet (bindingPda(wallet) in @ghostlink/common).
const created = await createPasskeyFactor({ userName: 'GhostLink', excludeCredentialIds: savedCredentialIds });
await saveCredentialId(created.credentialId); // A public value. Use created.factor as secondFactor.

// Every later sign-in, on any device: read the existing passkey.
let secondFactor: Uint8Array;
try {
  // rpId defaults to the current host; the saved credential ID is optional.
  secondFactor = await passkeyFactor(undefined, savedCredentialId);
} catch (error) {
  if (error instanceof PasskeyFactorError && error.code === 'not-allowed') {
    // Cancelled, timed out or no passkey here. Offer a retry. Never create a new passkey for this wallet.
  }
  throw error;
}
```

- `passkeyFactor` never creates a credential. WebAuthn reports a cancelled prompt, a timeout and "no passkey on this device" with the same error, so the SDK cannot tell them apart. It throws `PasskeyFactorError` with code `not-allowed`. The other codes are `no-prf`, `unavailable` and `exists`.
- Call `createPasskeyFactor` only for a wallet with no registration. It returns `{ factor, credentialId }`. Without `userId`, each creation uses a fresh random user handle, so an accidental second creation adds a passkey instead of replacing one. With a stable `userId`, such as the wallet address, most platforms overwrite the earlier passkey. An authenticator that holds one of the `excludeCredentialIds` refuses with code `exists`.
- `obtainPasskeyFactor` was removed. It created a replacement passkey whenever reading failed, including after a cancelled prompt, which could make a registered identity unrecoverable.
- After deriving, compare `identity.commitment` with the commitment stored in the wallet's registry binding before using the identity.

## Authorize a bot without sharing the owner's secret

For a shared owner application approving several bots, use the [pinned application registry and owner consent controller](../../docs/OWNER-CONSENT.md). They validate the request and derive a separate pocket for each vetted bot origin. `verifyTelegramOwnerInitData` checks Telegram's third-party signature without exposing a bot token. The product UI and real device handoff remain release gates.

The bot creates a temporary session key. Only its public key crosses to the user's trusted authorization interface:

```ts
import { softwareSession, sessionPublicKey } from '@ghostlink/sdk';

const botSigner = softwareSession();
const publicSession = sessionPublicKey(0, botSigner.key32);
// Serialize only the public key, not botSigner or an owner identity.
const publicKeyBytes = Array.from(publicSession.key32);
```

To restore a stored key, pass its exact 32-byte seed: `softwareSession(seed)` copies it and refuses any other length, so wiping the buffer afterwards does not change the key.

The lower-level API below is for an application authorizing its own origin. In browsers, `client.authorizeSession` uses the current page origin; a shared owner page must use the controller linked above. After authenticating the handoff and showing the bot, policy, home and expiry:

```ts
import { sessionPublicKey } from '@ghostlink/sdk';

const authorization = await client.authorizeSession({
  identity, witness, home, expirySlot, policy: approvedPolicy,
  session: sessionPublicKey(0, Uint8Array.from(publicKeyBytes)),
});
const pocket = client.pocketFor(authorization, home, approvedPolicy);
await client.openSession(authorization, pocket, {
  mint: new Uint8Array(32), threshold: 0n, minSlot: 0n, claim: false,
});
```

Here `client` is a GhostLink client initialized with `cluster: "localnet"` with a local prover and trusted service endpoints. Its optional `fetchFn` can be any fetch, including the browser's `window.fetch`; the SDK calls it without a receiver. `identity` and `witness` stay on the user's trusted device. They must not be requested by a bot backend. This API supplies the proof/key boundary; it does **not** supply the hosted handoff, consent UI, Telegram authentication, or isolated origin-enforcing identity broker.

`authorizeSession` requires an explicit `home` and `policy`. The program rebuilds the proof's public inputs from the `openSession` request, so `openSession` refuses claim fields, roots, a domain hash, session key or expiry that differ from the proved values before it contacts the relayer. It throws `RelayerOperationPendingError` while the outcome is unknown and `RelayerOperationFailedError` after a final on-chain failure (see [Durable relayer requests](#durable-relayer-requests)).

After confirmed activation, the bot reads the pocket from the correct chain, checks its owner/layout, session key/expiry and policy, reserves a nonce in a durable per-pocket store, and signs an exact swap intent with `signIntent` or `client.submitIntent`. A client-supplied callback or a Telegram message is not evidence of on-chain authorization. On an uncertain submission result, reconcile the same intent and transaction before allocating a replacement nonce.

An authorization contains no signing function. `authorizeSession` accepts only Ed25519 bot keys: a remote P-256 public key is not evidence of a hardware passkey. The existing `client.prove` method still supports locally held software/passkey signers for interactive apps. `client.prove` without a policy creates a login-only proof that cannot open a pocket (see [Login-only proofs](#login-only-proofs)). With a policy it also requires an explicit `home`. Supply the current confirmed policy for pocket renewal. Existing pockets retain their original policy: passing a new policy to `pocketFor` does not update on-chain permissions.

## Login-only proofs

Every public signal of a proof is visible to whoever receives it. For a login-only proof:

```ts
const session = await client.prove({ identity, witness, claim, currentSlot, expirySlot });
```

- Omit `home`. The proof publishes an unsalted hash of `home`, and registered wallets are public, so a verifier could hash each wallet and identify the user. Without `home`, 32 zero bytes are bound. `prove` refuses a login-only proof whose `home` is the registered wallet.
- Prefer `currentSlot` to `minSlot`. The proof publishes `min_slot`, and an exact census snapshot slot identifies that public snapshot. With `currentSlot`, `min_slot` is `currentSlot - claim.maxAgeSlots`.

Witnesses come from completed root buckets. The programs keep one root per 150-slot bucket (about a minute), and a root becomes final only when its bucket ends, so the indexer serves a new registration or snapshot about a minute after it lands, plus finality. Until then `verifiedPath` and `latestCensus` throw `WitnessPendingError`; retry after its `completesAfterSlot`. `localWitness` rebuilds only the served leaves, so a leaf that recent is not found yet.

## Wallet Standard sign-in

`registerGhostLinkWallet({ login })` announces a wallet with `standard:connect`, `standard:events` and a custom `ghostlink:signIn` feature. It has no transaction signing. It advertises `solana:localnet` by default and, like `GhostLink.init`, refuses other chains until V2 has a verified deployment.

The `ghostlink:signIn` output contains byte arrays and a `bigint` expiry, so `JSON.stringify` throws on it. Send `signInOutputToDto(output)` (hex bytes, decimal expiry) to your backend. There, decode it, verify the proof with `@ghostlink/verify`, and verify the challenge signature over `loginChallengeDigest(challenge)` before consuming the challenge.

## Validate a deposit before wallet signing

`client.verifyFunding` checks GET metadata only. An Actions endpoint can return different transaction instructions in its POST response. Use `prepareFundingTransaction` with the user's independently approved app ID, funding wallet, asset and amount. Never extract those approvals from the returned transaction or its display message.

```ts
import { prepareFundingTransaction } from '@ghostlink/sdk';
import { pk } from '@ghostlink/common';

// rpc is independently configured and its genesis matches your approved localnet.
// Check the response's x-blockchain-ids against that genesis, and independently
// read the confirmed PocketV3 account, mint and associated token accounts first.
const blockhash = await rpc.getLatestBlockhash('confirmed');
const checkedBytes = prepareFundingTransaction(decodedTransactionBytes, {
  appId: approvedAppId,
  funder: fundingWalletPublicKeyBytes,
  asset: { kind: 'spl', mint: approvedMintBytes, rawAmount: 25_000_000n },
  recentBlockhash: pk(blockhash.blockhash),
});
// For native SOL: asset: { kind: 'sol', lamports: 1_000_000n }.
// Estimate the fee and any ATA creation rent, show the complete debit for consent,
// then pass only checkedBytes to the funding wallet. Do not append instructions.
// Retain blockhash.lastValidBlockHeight with the signature for confirmation.
```

The helper accepts exactly an unsigned legacy SOL transfer to the derived pocket, or idempotent creation of its classic SPL associated token account followed by an exact token transfer from the funder's associated account. It checks the fee payer, sole signer, every account and permission, instruction order and raw integer amount. Extra instructions (including priority-fee changes, tips, approvals and memos), signatures, versioned transactions and Token-2022 are refused. It returns a detached copy with the trusted blockhash substituted and does not require web3.js or Node globals at runtime. It never signs, broadcasts or confirms a transaction.

This is structural validation. A transaction does not encode the RPC genesis, account state, rent or current network fee. Confirm those independently, display SOL fees/rent as well as the token amount, and follow the original signature after an uncertain submission. A SOL deposit is not automatically wrapped for a swap. V2 remains localnet only; see [Actions operations](../../docs/ACTIONS-OPERATIONS.md) and [Solana's client responsibilities](https://solana.com/docs/tools/actions#post-response---transaction).

## Current limits

Trade submission returns explicit states. Inspect `tx.state`; `pending`, `preparing` and `unknown` are not successful settlement. Persist a signed intent before sending with `client.submitSignedIntent(signed, publicSession)`, and poll with `client.intentStatus(intentHashHex)` after a timeout. Retrying the identical intent reuses the solver's persisted transaction. Never allocate a fresh nonce simply because an HTTP call failed. See [the recovery contract](../../docs/TRANSACTION-RECOVERY.md).

- The facade refuses devnet and mainnet because V2 has no verified live deployment. The existing devnet app uses the preserved V1 deployment. This is a configuration guard, not an RPC genesis check or a sandbox around low-level functions.
- Only classic SPL Token swaps are supported. Token-2022 transfers and native SOL swap legs need explicit implementations.
- Priced trades require pinned fresh feeds. The local PocketV3 candidate supports explicitly approved, bounded unpriced buys and tracked exits to their original base; see [the policy and limitations](../../docs/adr/0004-bounded-speculative-trading.md). This does not certify production sniper-bot compatibility.
- One active session key exists per pocket. A new session replaces the previous one. One bot cannot independently revoke another key in the same pocket because multiple concurrent delegations are not implemented.
- V2 binds the exact policy, session kind and deployment in the proof. The `open_session_v2` instruction requires new development proofs/keys and a fresh, reviewed deployment. It must not be deployed over V1.
- Passkey sessions require user interaction. Backend automation uses Ed25519 sessions under the existing limits.
- Nonce persistence, quote construction, DEX routing, transaction landing and confirmation reconciliation are integrator/service responsibilities.
- The SDK does not expose arbitrary wallet transaction signing or unrestricted withdrawals. A pocket is a program account, not an ordinary keypair wallet.

See the repository's `docs/INTEGRATIONS.md` and `docs/MAINNET-READINESS.md` for the supported boundaries and release gates.


## Durable relayer requests

`prepareRelayerOperation`, `RelayerClient.submit` and `RelayerClient.status` cover registration, snapshots, session opening and owner actions. Save the complete prepared operation in your encrypted durable store **before** sending it. Reuse the same object and ID after a lost response; generating another proof or ID creates another operation.

```ts
import { prepareRelayerOperation, RelayerClient } from "@ghostlink/sdk";

const client = new RelayerClient(approvedRelayerUrl);
const operation = prepareRelayerOperation("/snapshot", { wallet, holding });
await encryptedStore.save(operation.requestIdHex, operation);
const receipt = await client.submit(operation);
// A 202 receipt is pending/unknown, not confirmation. Preserve the operation.
const latest = await client.status(operation.requestIdHex);
```

`RelayerOperationPendingError` preserves the submitted operation after transport failure or invalid receipt. `RelayerClient.submit` returns every valid receipt, including `failed`. The `openSession` facade uses a deterministic request ID for the exact authorization:

- For `preparing`, `pending` and `unknown` receipts it throws `RelayerOperationPendingError`. Keep `error.operation` and reconcile it.
- For a `failed` receipt it throws `RelayerOperationFailedError`. The relayer saw a confirmed or finalized execution error, and resubmitting the same authorization replays the same request and failure. Inspect `error.receipt`, fix the cause, then prepare a new authorization.

A bot must still independently verify the reviewed on-chain permissions. Receipts are provider evidence, not proof of authority. See [relayer operations](../../docs/RELAYER-OPERATIONS.md) for expiry, budgets, retention and migration limits.
