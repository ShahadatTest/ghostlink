# GhostLink SDK

Experimental TypeScript/JavaScript SDK for Solana identity proofs and policy-controlled pockets. Node.js bot backends and browser applications can use the same intent format. **V2 candidate: no official public deployment.** It runs on a local validator by default, and on devnet or mainnet only against a [deployment](../../docs/DEPLOYMENTS.md) you create and pass as a manifest. This is not an integration with any named trading bot, and installing it does not grant a bot permission to trade.

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

ES modules use `import`. CommonJS applications can use `await import('@ghostlink/sdk')` inside an async function. TypeScript declarations are included. The package check installs into a separate temporary project, checks imports/types, verifies a real intent signature and compiles every TypeScript example in this README; it does not send a transaction.

## The whole journey

The examples in this README form one program, in order: each step uses what the steps before it built. The package check compiles them against the packed archives, so they match the API. Lines starting with `declare` stand for values your application already has.

To try it, run the reference services on a local validator: `GHOSTLINK_KEEP_RUNNING=1 bash scripts/localnet-e2e.sh` (see [setup](../../docs/SETUP.md)) leaves the indexer on port 8787, the relayer on 8788, the solver on 8789 and Actions on 8790, with the validator's RPC on 8899. [`services/e2e/src/run.ts`](../../services/e2e/src/run.ts) runs every step below against them.

### 1. Create the client

```ts
import { GhostLink, jsonRpcChainReader } from "@ghostlink/sdk";
import { createWorkerProver } from "@ghostlink/prover-wasm";
import { LOCALNET_DEPLOYMENT, parseDeployment, type DeploymentManifest } from "@ghostlink/common";

// The deployment manifest names the programs every address and proof binds (docs/DEPLOYMENTS.md).
// A local validator uses the built-in one; on devnet or mainnet, load the operator's manifest:
//   const deployment = parseDeployment(await (await fetch("/ghostlink-deployment.json")).json());
const deployment: Readonly<DeploymentManifest> = parseDeployment(LOCALNET_DEPLOYMENT);

const client = await GhostLink.init({
  cluster: deployment.cluster,
  deployment,
  // Services you run or trust. The relayer pays fees; the indexer serves Merkle witnesses.
  indexer: "http://127.0.0.1:8787",
  relayer: "http://127.0.0.1:8788",
  solver: "http://127.0.0.1:8789",
  actions: "http://127.0.0.1:8790",
  // Chain reads (slots, the pocket's owner action nonce and revocation epoch) go through this. See "Reading the chain".
  chain: jsonRpcChainReader("http://127.0.0.1:8899"),
  // Proofs are made on this device. The artifacts come from scripts/build-circuits.sh (circuits/build/);
  // pin their SHA-256 so a changed file is refused. The owner circuit is needed for recovery and policy changes.
  prover: createWorkerProver({
    login: { wasmUrl: "/circuits/login.wasm", zkeyUrl: "/circuits/login.zkey",
      wasmSha256: "<sha256 of login.wasm>", zkeySha256: "<sha256 of login.zkey>" },
    owner: { wasmUrl: "/circuits/owner.wasm", zkeyUrl: "/circuits/owner.zkey",
      wasmSha256: "<sha256 of owner.wasm>", zkeySha256: "<sha256 of owner.zkey>" },
  }),
});
```

**Origin.** Every identity's per-app ID, proof and pocket is scoped to an origin. In a browser the SDK always uses `window.location.origin`. In Node (a backend, a script, a test) there is no page, so pass the origin the proofs are for: `GhostLink.init({ ..., origin: "https://app.example.com" })`. Without it, every proving and owner method throws `no origin outside the browser`.

### 2. Derive the identity and register once

```ts
import { deriveIdentity } from "@ghostlink/sdk";
import { toBase58 } from "@ghostlink/common";

// From your wallet connection: the 32-byte public key, and a function that resolves to the
// wallet's 64-byte Ed25519 signature over exactly the bytes given (wallet-adapter's signMessage).
declare const walletPublicKey: Uint8Array;
declare const signMessage: (message: Uint8Array) => Promise<Uint8Array>;

// The wallet signs a fixed Sign-In-With-Solana text twice; the secret is derived on this device and never sent.
const identity = await deriveIdentity(signMessage, {
  cluster: deployment.cluster,
  domain: "id.example.com", // the host wallets display; keep it fixed, another host derives another identity
  address: toBase58(walletPublicKey),
});

// The relayer pays. It sees only the commitment and the wallet's signature over the registration message.
await client.register({ identity, wallet: walletPublicKey, signMessage });
```

- `deriveIdentity` requests the same text twice and checks both signatures against `address`. It refuses a wallet whose two signatures differ (`NonDeterministicSignerError`), because that identity could never be derived again. The same wallet, `domain`, `cluster` and second factor always give the same identity. Pass `{ signMessage, signIn }` to use the wallet's native `solana:signIn` feature when it has one.
- The registry accepts one registration per wallet and has no update. Register only an identity you can reproduce. With a `chain` reader configured, `register` refuses a wallet that is already registered and says whether it was this identity.
- The registry checks a cluster tag in the registration message: its default build, which a local validator runs, expects `devnet`, and the `mainnet` build expects `mainnet-beta`. `register` picks the tag from the deployment (`registrationClusterTag`).
- `register` waits until the relayer reports the transaction confirmed (see [Relayer calls](#relayer-calls)). Its request ID is the request's digest, so calling it again after a lost reply reconciles the same operation.

### 3. Snapshot a holding

Only needed for a token gate. The census records the wallet's balance of one token account at one slot.

```ts
// The token your app gates on (32 bytes). A snapshot of `mint` records the wallet's associated token account;
// pass `holding` instead for another token account, or the wallet itself for native SOL.
declare const gatedMint: Uint8Array;

await client.snapshot({ wallet: walletPublicKey, mint: gatedMint });
```

The relayer pays the census fee and allows one snapshot per holding per minute (code `snapshot_cooldown`). Every snapshot is a new operation with a fresh request ID.

### 4. Gather the witness

```ts
// Registry path (checked against this identity's commitment) and, with a mint, the latest census snapshot path.
const witness = await client.witness({ identity, wallet: walletPublicKey, mint: gatedMint, wait: { timeoutMs: 180_000 } });
```

A registration or snapshot becomes provable only when its 150-slot root-history bucket ends (about a minute on a local validator), plus the indexer's finality ([ADR 0005](../../docs/adr/0005-census-spam-resistance.md)). Without `wait`, `witness` throws `WitnessPendingError` (with `completesAfterSlot`) for such a leaf, and `IndexerRequestError` with status 404 while the indexer has not seen it. With `wait: { timeoutMs, pollMs?, signal? }` it retries both every `pollMs` (default 2 s) until the deadline, then throws the last error. Every path is verified against its leaf and the served root here; the programs accept only roots from their own 128-entry rings, so a lying indexer can waste a proof but never forge one. The lookups tell the indexer which wallet and mint you want: `localWitness` builds a registry path from the full leaf list instead.

### 5. Log in to a site

The browser proves; your backend verifies with [`@ghostlink/verify`](../verify/README.md).

```ts
import { loginChallengeDigest, bytesToHex, hexToBytes } from "@ghostlink/common";
import { verifyLogin, verifyLoginChallenge, holdingsClaim } from "@ghostlink/verify";

// A single-use 32-byte nonce your backend issued for this attempt.
declare const issuedNonce: Uint8Array;

const login = await client.prove({
  identity, witness,
  claim: { mint: gatedMint, threshold: 100_000_000n, maxAgeSlots: 9_000n }, // "held at least 100 tokens (6 decimals) within ~1 hour"
  expirySlot: (await client.currentSlot()) + 9_000n,                         // this login session's key expires in ~1 hour
});
const signInBody = {
  proof: login.proof.snarkjsProof,
  publicSignals: login.proof.publicSignals,
  key32: bytesToHex(login.signer.key32),
  expirySlot: login.expirySlot.toString(),
  signature: bytesToHex((await login.signer.sign(loginChallengeDigest(issuedNonce))).signature),
};

// Backend: returns the user's stable ID for your site, or null.
async function verifySignIn(body: typeof signInBody, nonce: Uint8Array, currentSlot: bigint): Promise<string | null> {
  const key32 = hexToBytes(body.key32);
  const result = await verifyLogin({
    proof: body.proof,
    publicSignals: body.publicSignals,
    expectedDomain: "https://app.example.com", // the page origin the client proved for
    roots: "http://127.0.0.1:8787",           // your indexer, or a function reading the on-chain root rings
    expect: {
      holdsAtLeast: holdingsClaim(gatedMint, 100_000_000n),
      minSlot: currentSlot - 10_000n,          // a little wider than the client's maxAgeSlots
      session: { key32, expirySlot: BigInt(body.expirySlot), currentSlot },
    },
  });
  if (!result.ok) return null; // result.code says why, e.g. "snapshot_too_old" or "unknown_root"
  return verifyLoginChallenge({ key32, nonce, signature: hexToBytes(body.signature) }) ? result.appId : null;
}
```

Every public signal is visible to whoever receives the proof:

- Omit `home` for a login. The proof publishes an unsalted hash of `home`, and registered wallets are public, so a verifier could hash each wallet and identify the user. Without `home`, 32 zero bytes are bound. `prove` refuses a login-only proof whose `home` is the registered wallet.
- Prefer `currentSlot` (read from `chain` when omitted) to an explicit `minSlot`. The proof publishes `min_slot`, and an exact census snapshot slot identifies that snapshot. With `currentSlot`, `min_slot` is `currentSlot - claim.maxAgeSlots`.
- `login.signer` is a fresh in-memory Ed25519 session key; the backend binds the proof to it and checks it signed the nonce, so a copied proof is not a login.

### 6. Give a bot a budget

The bot keeps its session secret; the owner's identity and proof inputs never reach the bot.

```ts
import { softwareSession, sessionPublicKey, signIntent, SESSION_KIND_ED25519 } from "@ghostlink/sdk";
import { conservativePolicy, type Policy } from "@ghostlink/common";

// Bot: a temporary session key. Only its public half leaves the bot.
const bot = softwareSession();
const botRequest = sessionPublicKey(SESSION_KIND_ED25519, bot.key32);

// Owner, on their own trusted device: show the bot, policy, home and expiry, then approve.
const policy: Policy = { ...conservativePolicy(), dailyCapUsdE6: 50_000_000n }; // at most $50 a day
const home = walletPublicKey; // the only place funds can be swept to
const authorization = await client.authorizeSession({
  identity, witness, session: botRequest, policy, home,
  expirySlot: (await client.currentSlot()) + 50_000n, // later than any earlier session, within policy.sessionMaxSlots
});
const pocket = client.pocketFor(authorization, home, policy);
await client.openSession(authorization, pocket); // waits for confirmation; every value sent is read from the proof
const funding = client.funding(pocket); // Blink, Solana Pay and plain-address options to fund it

// Bot: sign exact swap intents. The Pocket program checks the signature, policy and delivered output.
declare const usdcMint: Uint8Array, solMint: Uint8Array;
const signed = await signIntent(pocket, bot, {
  nonce: 1n, inMint: usdcMint, inMax: 25_000_000n, outMint: solMint, outMin: 160_000_000n,
  deadlineSlot: (await client.currentSlot()) + 500n,
});
```

- `authorizeSession` requires an explicit `home` and `policy`, and accepts only Ed25519 bot keys: a remote P-256 public key is not evidence of a hardware passkey.
- The proof binds the pocket's revocation epoch. With a `chain` reader, `authorizeSession` and `prove` read it themselves (zero before the pocket exists), and refuse a renewal whose home, policy or expiry the program would refuse. Without one, pass `authorizationEpoch` (`pocketAuthorizationEpoch` in `@ghostlink/common` reads it from account data); omitted, it is zero, which only creates a pocket. Every revoke raises the epoch, so a proof made before a revoke can never open a session afterwards ([ADR 0006](../../docs/adr/0006-pocket-hardening.md)).
- Existing pockets keep their policy: passing a new policy to `pocketFor` does not change on-chain permissions. Use a policy change (step 7).
- `openSession` checks the authorization against the pocket's policy, home, deployment and epoch, and reads the claim, roots and domain hash from the proof. Pass `{ claim, roots, domainHash }` to have it also refuse a proof that differs from what you expect.
- After confirmed activation, the bot reads the pocket from the correct chain, checks its owner/layout, session key/expiry and policy, reserves a nonce in a durable per-pocket store, and signs. A client-supplied callback or a Telegram message is not evidence of on-chain authorization. Submit with `client.submitIntent` or, for a signed intent you persisted first, `client.submitSignedIntent(signed, botRequest)`; poll `client.intentStatus(hash)` after a timeout instead of signing a new nonce.

For a shared owner application approving several bots, use the [pinned application registry and owner consent controller](../../docs/OWNER-CONSENT.md) instead of `authorizeSession`. It validates the request and derives a separate pocket for each vetted bot origin.

### 7. Get your funds back, or change the rules

Owner actions need only the identity, the registry witness and the owner circuit. They work after a bot's session is lost, revoked or compromised.

```ts
import { associatedTokenAddress } from "@ghostlink/sdk";

const registryOnly = await client.witness({ identity, wallet: walletPublicKey });

// Stop the bot now: ends the session and raises the revocation epoch.
await client.submitOwnerAction(await client.proveOwnerAction({ identity, witness: registryOnly, action: "revoke" }));

// Return every balance to the pocket's recovery home. Name each pocket token account to empty;
// the relayer picks or creates a clean home-owned destination for each.
const sweep = await client.proveOwnerAction({ identity, witness: registryOnly, action: "sweep" });
await client.submitOwnerAction(sweep, {
  tokenPairs: [usdcMint, solMint].map(mint => ({ source: associatedTokenAddress(pocket.address, mint), mint })),
});

// Stage a new home behind the 24-hour timelock; cancel it at any time before it executes.
declare const newHome: Uint8Array;
await client.submitOwnerAction(await client.proveOwnerAction({ identity, witness: registryOnly, action: "propose", change: { home: newHome } }));
await client.submitOwnerAction(await client.proveOwnerAction({ identity, witness: registryOnly, action: "cancel" }));
```

- `proveOwnerAction` derives the pocket from the identity and this client's origin, reads its current `owner_action_nonce` (and, for a sweep, its home; for a cancel, the staged change) through `chain`, proves on this device, and refuses if the nonce moved while proving. The proof binds that nonce, so it authorizes exactly one action; every owner action and executed change consumes it ([ADR 0003](../../docs/adr/0003-session-authorization-v2.md), [ADR 0006](../../docs/adr/0006-pocket-hardening.md)).
- A sweep returns the complete balance of each named token account and the pocket's surplus SOL, only to the home stored on chain. At most two token accounts per request are tested to fit a transaction. Destination rules and lost-reply handling are in [owner recovery](../../docs/OWNER-RECOVERY.md).
- After a lost reply, call `submitOwnerAction` again with the same authorization: its request ID is the request digest, so it reconciles the same operation. Do not prove again because a response was lost; check the chain first.
- The reference relayer submits home changes only. Send a policy change, `{ policy }`, with `ownerActionInstructions` in your own transaction (next section). A staged change executes once `pocketState(pocket.address).pending.executableAfterSlot` has passed; anyone may send `executeChangeInstructions(pocket.address, payer)`, and the watcher service does so automatically. A policy change cannot execute while speculative positions are open.

## Reading the chain

The SDK has no RPC client of its own. Methods that need chain state read it through `config.chain`, any object with three methods:

```ts
import type { ChainReader } from "@ghostlink/sdk";

// What the SDK reads: the genesis hash (checked against the deployment once, before the first read),
// the confirmed slot, and single confirmed accounts at or after a context slot.
const readerShape: ChainReader = {
  getGenesisHash: async () => "<genesis hash>",
  getSlot: async () => 0n,
  getAccount: async (_address: Uint8Array, _minContextSlot?: bigint) => null, // or { owner, data, lamports }
};
```

`jsonRpcChainReader(url, { commitment?, fetchFn? })` implements it over Solana JSON-RPC with `fetch` alone, in browsers and Node. An app that already has `@solana/web3.js` can adapt its `Connection` instead:

```ts
import { Connection, PublicKey } from "@solana/web3.js";

declare const connection: Connection;
const web3Reader: ChainReader = {
  getGenesisHash: () => connection.getGenesisHash(),
  getSlot: async () => BigInt(await connection.getSlot("confirmed")),
  getAccount: async (address, minContextSlot) => {
    const info = await connection.getAccountInfo(new PublicKey(address),
      { commitment: "confirmed", minContextSlot: minContextSlot === undefined ? undefined : Number(minContextSlot) });
    return info && { owner: info.owner.toBytes(), data: info.data, lamports: BigInt(info.lamports) };
  },
};
```

Treat the reader as trusted. Owner proofs bind the nonce it reports: a wrong nonce makes the program reject the proof, so a lying RPC can waste an action but cannot redirect one. `client.currentSlot()` never goes backwards on one client, and account reads ask for at least that slot. `client.pocketState(address)` returns the decoded pocket (home, policy, pending change, epoch, nonce) or null before it is opened. Without `chain`, registration, snapshots through the relayer, witnesses and proofs with explicit `currentSlot` and `authorizationEpoch` still work; owner actions and self-submitted snapshots do not.

## Apps that send their own transactions

Every relayer method has an instruction form for an app that pays its own fees: `registerInstructions`, `snapshotInstructions`, `ownerActionInstructions` and `executeChangeInstructions`. They return plain `{ programId, keys, data }` bytes derived from the client's deployment; convert them with your Solana client:

```ts
import { TransactionInstruction } from "@solana/web3.js";
import type { GhostLinkInstruction } from "@ghostlink/sdk";

const toWeb3 = (instructions: GhostLinkInstruction[]) => instructions.map(ix => new TransactionInstruction({
  programId: new PublicKey(ix.programId),
  keys: ix.keys.map(key => ({ ...key, pubkey: new PublicKey(key.pubkey) })),
  data: Buffer.from(ix.data),
}));

// A policy change: the reference relayer does not submit these. `feePayer` signs and pays.
declare const feePayer: Uint8Array;
const tighter = await client.proveOwnerAction({ identity, witness: registryOnly, action: "propose",
  change: { policy: { ...policy, dailyCapUsdE6: 20_000_000n } } });
const proposeTransactionInstructions = toWeb3(client.ownerActionInstructions(tighter, { payer: feePayer }));
```

- `registerInstructions` returns the Ed25519 signature check and `register`; keep both, in order, in one transaction.
- `snapshotInstructions` reads the census fee through `chain` unless you pass `maxFeeLamports`. A snapshot transaction may contain only compute-budget and snapshot instructions.
- `ownerActionInstructions` returns a compute-budget instruction and the action. A sweep needs explicit destinations: initialized home-owned token accounts of the same mint with no delegate or foreign close authority, for example the home's associated token accounts.
- These instruction encodings are checked byte for byte against the services' builders, which the program tests and the local journey run on chain.

## Relayer calls

`register`, `snapshot`, `openSession` and `submitOwnerAction` submit through the relayer and settle: they reconcile a pending operation, resubmitting only the same request, until it is confirmed, it fails, or `timeoutMs` passes (default 60 000; `0` submits once). Each takes `{ save, requestIdHex, timeoutMs, pollMs }`. `save(operation)` is called before anything is sent: persist the operation (encrypted) so that after a crash you finish it instead of sending another:

```ts
import { RelayerClient, RelayerOperationPendingError, type PreparedRelayerOperation } from "@ghostlink/sdk";

declare const encryptedStore: { save(id: string, operation: PreparedRelayerOperation): Promise<void> };
try {
  await client.snapshot({ wallet: walletPublicKey, mint: gatedMint },
    { save: operation => encryptedStore.save(operation.requestIdHex, operation), timeoutMs: 30_000 });
} catch (error) {
  // The deadline passed with the outcome unknown: finish the saved operation later, never a new one.
  if (error instanceof RelayerOperationPendingError) await new RelayerClient("http://127.0.0.1:8788").settle(error.operation);
}
```

`prepareRelayerOperation`, `RelayerClient.submit`, `RelayerClient.status` and `RelayerClient.settle` are the same machinery for callers that build requests themselves. `submit` sends once and returns every valid receipt, including `pending` and `failed`. Receipts are provider evidence: a bot must still independently verify the reviewed on-chain permissions. See [relayer operations](../../docs/RELAYER-OPERATIONS.md) for expiry, budgets, retention and migration limits.

## Errors

| Error | Meaning | What to do |
| --- | --- | --- |
| `RelayerRequestError` | The relayer refused (HTTP 4xx). Nothing was reserved or sent. Carries `status`, `code`, `serverMessage` and the `operation`. | Branch on `code` (table below). |
| `RelayerOperationPendingError` | Outcome unknown: transport failure, HTTP 5xx, an invalid receipt, or the deadline passed. Carries `operation`, and `status`, `code` and `serverMessage` when the relayer answered. | Keep `error.operation`; finish it with `RelayerClient.settle`. |
| `RelayerOperationFailedError` | The transaction landed and failed on chain. Carries `receipt`. | Resubmitting returns the same failure: fix the cause, then prepare a new operation (for a session or owner action, a new proof). |
| `WitnessPendingError` | The leaf's root bucket has not ended. Carries `completesAfterSlot`. | Retry after that slot, or pass `wait` to `witness`. |
| `IndexerRequestError` | The indexer answered with an error. Carries `path`, `status`, `serverMessage`. A 404 on `witness` means not registered or not snapshotted (yet). | Register or snapshot first, or wait. |

Relayer error codes. Every relayer error response is `{ error, code }`: branch on `code`, log `error`. A response without a code (from the HTTP layer, or an older relayer) gets one from its status: 400 `bad_request`, 403 `partner_only`, 404 `not_found`, 409 `request_conflict`, 413 `body_too_large`, 422 `simulation_failed`, 429 `rate_limited`, 500 `internal`, 503 `unavailable`, others `unknown`.

| Code | Status | Meaning |
| --- | --- | --- |
| `bad_request` | 400 | A malformed or invalid field; `error` names it. |
| `partner_only` | 403 | This relayer creates pockets only for its partner apps' domains. |
| `not_found` | 404 | No submission with that request ID. |
| `request_conflict` | 409 | The request ID is already bound to different content. Never reuse an ID for another request. |
| `body_too_large` | 413 | The request body exceeds the relayer's limit. |
| `simulation_failed` | 422 | The transaction would fail on chain (a stale proof or nonce, an existing registration). Nothing was reserved. |
| `rate_limited` | 429 | Too many requests from this address or wallet. Retry the same operation later. |
| `snapshot_cooldown` | 429 | This holding was snapshotted less than a minute ago. |
| `internal` | 500 | Unexpected relayer error; outcome unknown. |
| `draining` | 503 | The relayer is shutting down. |
| `not_ready` | 503 | Not ready or busy (chain evidence stale, in-flight limit). Retry the same operation. |
| `budget_exhausted` | 503 | The relayer's rolling daily spend budget is used up. |
| `reserve_unavailable` | 503 | The payer cannot cover this cost and its operating reserve. |
| `journal_full` | 503 | The relayer's operation journal is at capacity. |
| `simulation_unavailable` | 503 | Simulation evidence was unavailable; nothing was reserved. |
| `chain_unavailable` | 503 | Rent, blockhash context or fee quote unavailable or excessive. |
| `census_fee_unavailable` | 503 | The census fee configuration could not be read. |
| `snapshot_fee_too_high` | 503 | The census fee exceeds what this relayer pays. |
| `unavailable` | 503 | Another 503 without a code (for example, the HTTP layer at capacity). |
| `unknown` | other | A status the SDK does not map. |

## One holdings claim

A holdings claim has one shape everywhere: `HoldingsClaim { mint: Uint8Array; threshold: bigint }` from `@ghostlink/common`, re-exported here and by `@ghostlink/verify`. The prover's claim adds `maxAgeSlots`; `openSession`'s optional expectation adds the proved `minSlot` (`ProvenClaim`). Converters: `holdingsClaim(mintBytesOrBase58, threshold)`, `claimMintFields(mint)` (the circuit's decimal `mintHi`/`mintLo`), `holdingsClaimFromFields`, and `provenClaim(publicSignals)` (the claim a proof makes, or null). The 0.1 shapes are still accepted: a claim with `amount` instead of `threshold`, and `openSession`'s positional `{ mint, threshold, minSlot, claim }` argument.

## Optional passkey factor

`secondFactor` mixes a WebAuthn PRF output into the secret, so a phished wallet signature alone cannot reproduce it. The passkey becomes part of the identity: a different passkey derives a different identity, and a registered wallet cannot register again. The SDK therefore never creates a passkey implicitly.

```ts
import { createPasskeyFactor, passkeyFactor, PasskeyFactorError } from "@ghostlink/sdk";

// Public values your app stores: the credential IDs it created before.
declare const savedCredentialIds: Uint8Array[];
declare const savedCredentialId: Uint8Array | undefined;

// Brand-new identity only: the wallet has no registry binding yet (bindingPda(wallet) in @ghostlink/common).
async function createFactor(): Promise<Uint8Array> {
  const created = await createPasskeyFactor({ userName: "GhostLink", excludeCredentialIds: savedCredentialIds });
  // created.credentialId is public: store it. Use created.factor as secondFactor.
  return created.factor;
}

// Every later sign-in, on any device: read the existing passkey.
async function readFactor(): Promise<Uint8Array> {
  try {
    return await passkeyFactor(undefined, savedCredentialId); // rpId defaults to the current host
  } catch (error) {
    if (error instanceof PasskeyFactorError && error.code === "not-allowed") {
      // Cancelled, timed out or no passkey here. Offer a retry. Never create a new passkey for this wallet.
    }
    throw error;
  }
}
```

- `passkeyFactor` never creates a credential. WebAuthn reports a cancelled prompt, a timeout and "no passkey on this device" with the same error, so the SDK cannot tell them apart. It throws `PasskeyFactorError` with code `not-allowed`. The other codes are `no-prf`, `unavailable` and `exists`.
- Call `createPasskeyFactor` only for a wallet with no registration. It returns `{ factor, credentialId }`. Without `userId`, each creation uses a fresh random user handle, so an accidental second creation adds a passkey instead of replacing one. With a stable `userId`, such as the wallet address, most platforms overwrite the earlier passkey. An authenticator that holds one of the `excludeCredentialIds` refuses with code `exists`.
- `obtainPasskeyFactor` was removed. It created a replacement passkey whenever reading failed, including after a cancelled prompt, which could make a registered identity unrecoverable.
- After deriving, `witness` compares `identity.commitment` with the wallet's registry binding and refuses a different one.

## Wallet Standard sign-in

`registerGhostLinkWallet({ login })` announces a wallet with `standard:connect`, `standard:events` and a custom `ghostlink:signIn` feature. It has no transaction signing. It advertises the chain of its `deployment` option (`solana:localnet` without one) and, like `GhostLink.init`, refuses devnet and mainnet without a deployment manifest for that cluster.

The `ghostlink:signIn` output contains byte arrays and a `bigint` expiry, so `JSON.stringify` throws on it. Send `signInOutputToDto(output)` (hex bytes, decimal expiry) to your backend. There, decode it, verify the proof with `@ghostlink/verify`, and verify the challenge signature over `loginChallengeDigest(challenge)` before consuming the challenge.

## Sign in through an identity app

A site that does not hold the identity (almost every site) signs users in through the deployment's identity app instead of `client.prove`: `requestLogin` opens the identity app in a popup, the user approves there, and the site receives a login proof bound to its own origin and to a session key it generated. The identity secret, the wallet's signatures and the witnesses never reach the site. The protocol, its origin rules and its limits are in [IDENTITY-HANDOFF.md](../../docs/IDENTITY-HANDOFF.md); [`examples/identity-app`](../../examples/identity-app) and [`examples/nextjs-login`](../../examples/nextjs-login) are complete reference apps.

```ts
import { requestLogin, parseHandoffSignIn } from "@ghostlink/sdk";

// In a click handler: the popup opens before anything awaits, so pop-up blockers allow it.
async function signInWithIdentityApp(nonceFromBackend: () => Promise<Uint8Array>) {
  const approved = await requestLogin({
    identityOrigin: "https://id.example.com", // the identity app's exact origin, never this site's
    claim: { mint: "So11111111111111111111111111111111111111112", threshold: 1_000_000_000n, maxAgeSlots: 9_000n }, // optional
  });
  // approved.appId is the user's ID for this site; the backend learns it from verifyLogin.
  return approved.signChallenge(await nonceFromBackend()); // JSON-safe: { proof, publicSignals, key32Hex, expirySlot, signatureHex }
}

// Backend: decode the body your sign-in route received, then verifyLogin and verifyLoginChallenge as in step 5.
declare const handoffRequestBody: unknown;
const decodedSignIn = parseHandoffSignIn(handoffRequestBody); // { proof, publicSignals, key32, expirySlot, signature } or null
```

- `requestLogin` rejects with a `HandoffError` whose `code` is `popup_blocked`, `closed`, `refused`, `failed` (with the identity app's `identityCode`), `timeout`, `aborted`, `unsupported_version`, `invalid_response` or `invalid_request`. It accepts messages only from the popup it opened, at `identityOrigin`, about its own random request ID, and checks that the answer is a login for this page's origin and session key making exactly the requested claim.
- The session key is a fresh in-memory Ed25519 `softwareSession()` unless you pass `session`. Only its public key is sent.
- An identity app answers with `listenForHandoffRequest`, which takes the requesting origin only from the browser, and proves with `client.forOrigin(request.origin).authorizeLogin({ identity, witness, session: request.session, expirySlot, claim })`. `forOrigin` gives a client whose proofs, pockets and owner actions are for another origin; it adds no power (the pure helpers accept any origin) and belongs only in the identity app.

## Validate a deposit before wallet signing

`client.verifyFunding` checks GET metadata only. An Actions endpoint can return different transaction instructions in its POST response. Use `prepareFundingTransaction` with the user's independently approved app ID, funding wallet, asset and amount. Never extract those approvals from the returned transaction or its display message.

```ts
import { prepareFundingTransaction } from "@ghostlink/sdk";
import { pk } from "@ghostlink/common";

// The Actions POST response's transaction, base64-decoded, and a confirmed blockhash from your own RPC
// (whose genesis matches your deployment). Check the response's x-blockchain-ids against that genesis, and
// independently read the confirmed PocketV3 account, mint and associated token accounts first.
declare const decodedTransactionBytes: Uint8Array;
declare const latestBlockhash: { blockhash: string; lastValidBlockHeight: number };

const checkedBytes = prepareFundingTransaction(decodedTransactionBytes, {
  appId: authorization.appId,
  funder: walletPublicKey,
  asset: { kind: "spl", mint: usdcMint, rawAmount: 25_000_000n }, // native SOL: { kind: "sol", lamports: 1_000_000n }
  recentBlockhash: pk(latestBlockhash.blockhash),
  deployment, // omit for the built-in localnet deployment
});
// Estimate the fee and any ATA creation rent, show the complete debit for consent,
// then pass only checkedBytes to the funding wallet. Do not append instructions.
// Retain latestBlockhash.lastValidBlockHeight with the signature for confirmation.
```

The helper accepts exactly an unsigned legacy SOL transfer to the derived pocket, or idempotent creation of its classic SPL associated token account followed by an exact token transfer from the funder's associated account. It checks the fee payer, sole signer, every account and permission, instruction order and raw integer amount. Extra instructions (including priority-fee changes, tips, approvals and memos), signatures, versioned transactions and Token-2022 are refused. It returns a detached copy with the trusted blockhash substituted and does not require web3.js or Node globals at runtime. It never signs, broadcasts or confirms a transaction.

This is structural validation. A transaction does not encode the RPC genesis, account state, rent or current network fee. Confirm those independently, display SOL fees/rent as well as the token amount, and follow the original signature after an uncertain submission. A SOL deposit is not automatically wrapped for a swap. See [Actions operations](../../docs/ACTIONS-OPERATIONS.md) and [Solana's client responsibilities](https://solana.com/docs/tools/actions#post-response---transaction).

## Current limits

Trade submission returns explicit states. Inspect `tx.state`; `pending`, `preparing` and `unknown` are not successful settlement. Persist a signed intent before sending with `client.submitSignedIntent(signed, publicSession)`, and poll with `client.intentStatus(intentHashHex)` after a timeout. Retrying the identical intent reuses the solver's persisted transaction. Never allocate a fresh nonce simply because an HTTP call failed. See [the recovery contract](../../docs/TRANSACTION-RECOVERY.md).

- The facade refuses devnet and mainnet without a [deployment manifest](../../docs/DEPLOYMENTS.md) for that cluster, and refuses manifests that reuse the built-in program IDs there: on devnet those are the preserved V1 deployment. A configured `chain` reader is checked against the manifest's genesis before the first read; without one, check it yourself with `assertDeploymentGenesis` from `@ghostlink/common`.
- Only classic SPL Token swaps are supported. Token-2022 transfers and native SOL swap legs need explicit implementations.
- Priced trades require pinned fresh feeds. The local PocketV3 candidate supports explicitly approved, bounded unpriced buys and tracked exits to their original base; see [the policy and limitations](../../docs/adr/0004-bounded-speculative-trading.md). This does not certify production sniper-bot compatibility.
- One active session key exists per pocket. A new session replaces the previous one. One bot cannot independently revoke another key in the same pocket because multiple concurrent delegations are not implemented.
- V2 binds the exact policy, session kind and deployment in the proof. The `open_session_v2` instruction requires new development proofs/keys and a fresh, reviewed deployment. It must not be deployed over V1.
- Passkey sessions require user interaction. Backend automation uses Ed25519 sessions under the existing limits.
- Nonce persistence, quote construction, DEX routing, transaction landing and confirmation reconciliation are integrator/service responsibilities.
- The SDK does not expose arbitrary wallet transaction signing or unrestricted withdrawals. A pocket is a program account, not an ordinary keypair wallet.
- This API supplies the proof/key boundary and a reference cross-origin [identity handoff](../../docs/IDENTITY-HANDOFF.md) with an example identity app; it does **not** supply a hosted identity app, Telegram authentication, or protection against a malicious identity app or a lookalike popup.

See the repository's `docs/INTEGRATIONS.md` and `docs/MAINNET-READINESS.md` for the supported boundaries and release gates.

## Changes from 0.1.0 source

- `openSession(authorization, pocket, options?)` takes `{ claim, roots, domainHash, timeoutMs, save, pollMs }` and reads the claim from the proof; the positional `(claimFields, roots, domainHash)` form still works but is deprecated. It now waits up to `timeoutMs` (default 60 s) for confirmation instead of throwing `RelayerOperationPendingError` at the first pending receipt; pass `timeoutMs: 0` for the old behaviour.
- `HoldsAtLeastClaim` uses `threshold` (was `amount`, still accepted) and `kind` is optional.
- `RelayerClient.submit` throws `RelayerRequestError` (with `status` and `code`) for a 4xx instead of a plain `Error`; `RelayerClient.status` too. `RelayerOperationPendingError` gains `status`, `code` and `serverMessage`.
- Indexer errors are `IndexerRequestError` (was a plain `Error` with the same message).
- With a `chain` reader configured, `prove` and `authorizeSession` read `currentSlot` and `authorizationEpoch` when omitted (they were zero/required before) and refuse renewals the program would reject.
- `verifiedPath` and `localWitness` return the exported `MerkleWitness` type (same shape).
