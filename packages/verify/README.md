# @ghostlink/verify

Server-side verification of GhostLink login proofs. A backend checks that a zero-knowledge proof is valid, was made for **its** domain, makes the claims it asked for, and was built against tree roots it trusts. No transaction and no wallet address are involved.

```ts
import { verifyLogin, verifyLoginChallenge } from "@ghostlink/verify";

// The 32-byte nonce you issued for this login attempt. Take it atomically (get and delete),
// so it can be used once, and refuse it after a short expiry.
const nonce = await challenges.take(body.challengeId);
const currentSlot = BigInt(await connection.getSlot("confirmed")); // your own RPC, never the client

const result = await verifyLogin({
  proof: body.proof,                  // the SDK's LoginProof.snarkjsProof
  publicSignals: body.publicSignals,  // 12 decimal strings, in circuit order
  expectedDomain: "https://app.example.com",
  roots: trustedRoots,                // indexer URL or a function reading the on-chain root rings
  expect: {
    holdsAtLeast: { mintHi, mintLo, threshold: 100_000_000n }, // optional token gate...
    minSlot: currentSlot - 10_000n,                            // ...which needs a freshness bound
    session: { key32, expirySlot, currentSlot },               // bind the proof to one session key
  },
});

// Replay control: the proof's session key must have signed your nonce.
if (nonce && result.ok && verifyLoginChallenge({ key32, nonce, signature })) {
  // result.appId is the user's stable, app-scoped ID: the same user always gets the same ID
  // on your site, and a different, unlinkable ID on every other site.
}
```

`key32`, `expirySlot` and `signature` come from the client's sign-in response (the SDK's `ghostlink:signIn` returns them as `session` and `challengeSignature`), decoded to bytes and a bigint.

Try it with a real proof: [`examples/verify-login`](../../examples/verify-login/src/index.ts).

## What it checks

1. The public signals are well-formed field elements in the login circuit's order (`LOGIN_SIGNALS`).
2. The proof is bound to `expectedDomain`. A proof made for another site fails.
3. Optional claims: holdings of a mint at or above a threshold (which requires a minimum snapshot slot), a session key and expiry, and the user's announced home address.
4. Purpose: a website login proof cannot authorize a pocket, and a pocket authorization must match the exact policy, session kind and deployment you pass in `expect.pocket`.
5. The registry root (and census root, for holdings claims) is one your root source recognises. An indexer lists one root per completed 150-slot bucket, the roots the programs keep for at least 128 buckets.
6. The Groth16 proof verifies against the login verifying key bundled in `keys/login_vk.json`.

`verifyLogin` never throws on malformed input. It returns `{ ok: false, reason }`.

## Token gates need a freshness bound

`expect.holdsAtLeast` must come with `expect.minSlot`, the oldest census snapshot slot you accept; otherwise `verifyLogin` returns `{ ok: false }` with a reason saying so. The census tree only grows and the prover chooses the proof's `min_slot`, so without a bound a snapshot of a past peak, or of a briefly borrowed balance, would pass forever.

The census refuses a snapshot made through another program or next to any instruction other than compute-budget and snapshot instructions, so a loan taken and repaid in the snapshot's own transaction cannot inflate it. A balance borrowed in an earlier transaction and returned in a later one still records: a snapshot shows what a wallet held at one slot, not what it owns. Keep the window short, set thresholds that make renting the balance for that window unprofitable, and do not gate anything irreversible on a single snapshot.

Use `currentSlot - window`, with `currentSlot` from your own RPC. The SDK proves with `min_slot` set to its own current slot minus the claim's `maxAgeSlots`, read before proving, so make your window a little wider than the `maxAgeSlots` your clients use. With `maxAgeSlots: 9_000n` (about an hour), a window of `10_000n` leaves several minutes for proving and transport. `minSlot: 0n` accepts snapshots of any age; use it only where that is a deliberate choice.

## Replay protection: `verifyLoginChallenge`

A proof and its session details are public, so a copied proof is not a login. For each attempt:

1. Issue a random 32-byte nonce and store it with a short expiry.
2. The client signs `loginChallengeDigest(nonce)` with its session key. The SDK's `ghostlink:signIn` feature does this and returns the proof, the session and the signature together.
3. Take the nonce atomically so it cannot be used twice, call `verifyLogin` with `expect.session`, then call `verifyLoginChallenge({ key32, nonce, signature })` with the same `key32`.

`verifyLoginChallenge` returns `true` only for a valid 64-byte Ed25519 signature by that 32-byte key over the domain-separated digest. It returns `false` (never throws) for wrong sizes, a different nonce, small-order keys and malformed input. It cannot know whether a nonce was used before: consuming it is your job.

It supports **Ed25519 session keys only**: the SDK's software sessions, which `client.prove` uses by default. A passkey (P-256) session's `key32` is a hash of its public key, and its signature is a WebAuthn assertion, so `verifyLoginChallenge` returns `false` for it. Verify those with a WebAuthn library: check that the 33-byte public key hashes (SHA-256) to `key32`, and expect the challenge `loginChallengeDigest(nonce)`.

## Deploying

`verifyLogin` loads `keys/login_vk.json` from the installed package. A bundler or serverless build that leaves the file out makes every login fail with `login verifying key unavailable (server configuration)`, not a proof error. Call `bundledLoginVerificationKey()` at startup to fail fast, or import the key so your bundler includes it, and pass it explicitly:

```ts
import loginVk from "@ghostlink/verify/keys/login_vk.json" with { type: "json" };

await verifyLogin({ ...request, verificationKey: loginVk });
```

## Security notes

- **A proof is not a password.** Without `expect.session` and a verified challenge, anyone holding a copy of the proof can present it until its roots age out.
- **Roots must come from a source you trust**: your own indexer or the on-chain tree accounts, never the client. `allowUnverifiedRoots` exists for tests only.
- **Fetch `currentSlot` yourself.** Never take slot numbers from the client.
- The bundled key matches the development circuits in this repository. Proofs from a different circuit build need their own verifying key.

Development networks only. See the repository [README](../../README.md) and [threat model](../../docs/THREAT-MODEL.md).
