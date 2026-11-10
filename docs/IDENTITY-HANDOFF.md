# Identity handoff

**Protocol version 1.** How a website offers "Continue with GhostLink" without ever holding the user's identity secret: it opens an identity app, on another origin, in a popup; the user approves there; the identity app answers with a login proof bound to the website's origin and to a session key the website generated. Reference code: `requestLogin`, `listenForHandoffRequest` and `parseHandoffSignIn` in [`packages/sdk/src/handoff.ts`](../packages/sdk/src/handoff.ts), the button in [`@ghostlink/react`](../packages/react/README.md), the [reference identity app](../examples/identity-app) and the [starter site](../examples/nextjs-login). Decision record: [ADR 0008](adr/0008-identity-handoff.md). Walkthrough: [Next.js login guide](guides/nextjs-login.md).

Development networks only, like the rest of the repository. The protocol has not been independently reviewed.

## Why a separate origin

The identity secret is derived from a wallet signature over a fixed message that names one identity domain, and the registry accepts one registration per wallet. Every site using a deployment therefore shares one identity, and whoever holds its secret can compute the user's ID at every site, which is what the per-site IDs are meant to keep unlinkable. So the secret must live in one place that is not any of the sites: the identity app, on its own origin. The browser's same-origin policy keeps the sites out of it, and `postMessage` is the only channel between them.

## Roles

- **Site**: any web page that wants to sign users in. It never sees the secret, the wallet address or the Merkle witnesses.
- **Identity app**: a page on the deployment's identity origin (for example `https://id.example.com`) that derives the identity from the user's wallet, keeps it in memory, proves on the device and shows the consent screen. It is trusted completely by the user: see [what this does not protect against](#what-this-does-not-protect-against).
- **Backend**: the site's server. It issues single-use nonces and verifies with [`@ghostlink/verify`](../packages/verify/README.md) against its own RPC and indexer.

## Flow

1. In a click handler the site calls `requestLogin({ identityOrigin })`. Synchronously, before anything awaits, it generates an Ed25519 session key pair (or uses the one it is given) and opens `identityOrigin + "/handoff"` with `window.open`, in a popup named after a fresh random request ID.
2. The identity app loads. If `window.opener` is null it shows "nothing to approve" and stops. Otherwise it starts listening and posts `ready` to its opener.
3. The site receives `ready` from the window it opened, at `identityOrigin`, and posts its `login-request` to that window with `targetOrigin` set to `identityOrigin`.
4. The identity app accepts the first well-formed request whose `event.source` is its `window.opener`. The requesting origin is `event.origin`. It shows that origin, what the site will learn and for how long, and arms its Approve button after the request has been visible in a focused window for one second.
5. On approval it gathers the witness, reads the current slot, proves `login` for exactly `event.origin` with the site's public session key and an expiry of at most its own limit, checks its own proof against the request, and posts `login-result` to `window.opener` with `targetOrigin` set to the requesting origin. A refusal or a failure is posted the same way.
6. The site checks the answer (below) and closes the popup. It fetches a nonce from its backend, signs `loginChallengeDigest(nonce)` with the session key and sends the proof, the public signals, the session public key, the expiry and the signature. The backend runs `verifyLogin` (domain = its own origin, session = that key and expiry, roots from its indexer, current slot from its RPC) and `verifyLoginChallenge`, consuming the nonce once.

## Messages

Every message is a structured-clone object with `protocol: "ghostlink-handoff"`, `version: 1` and `type`. Numbers that can exceed 2^53 are decimal strings; byte strings are lowercase hex or base58 as stated.

| Type | Direction | Fields besides protocol, version, type | `targetOrigin` | Receiver acts on it only if |
| --- | --- | --- | --- | --- |
| `ready` | identity app → opener | none | `"*"` (carries nothing; the opener already knows it opened the window) | `event.source` is the popup this request opened and `event.origin === identityOrigin`. Another `version` ends the request as `unsupported_version`. Resent up to 5 times (popup reloads), always the same request. |
| `login-request` | site → popup | `id`: 64 hex (32 random bytes). `request.sessionKeyHex`: 64 hex, an Ed25519 public key that is not small-order. `request.sessionSlots`: decimal, 1 to 216000. `request.claim?`: `{ mint: base58 32-byte address, threshold: decimal u64, maxAgeSlots: decimal u64 }` | `identityOrigin` | `event.source === window.opener`; `event.origin` passes the origin rules and differs from the identity app's own; every field is well-formed; it is the first such request this page received. Anything else is ignored. |
| `login-result` | identity app → opener | `id`; `result.proof`: Groth16 proof JSON (`pi_a`, `pi_b`, `pi_c` decimal strings, `protocol: "groth16"`, `curve: "bn128"`); `result.publicSignals`: 12 canonical decimal field elements; `result.expirySlot`: decimal u64 | the requesting origin | `event.source` is the popup, `event.origin === identityOrigin`, `id` matches, the request was sent. Then the binding checks below: a correlated answer that fails them ends the request as `invalid_response`. |
| `login-refused` | identity app → opener | `id` | the requesting origin | as for `login-result`; ends the request as `refused` |
| `login-error` | identity app → opener | `id`; `code`: 1–40 of `[a-z_]` (`not_registered`, `pending`, `claim_unmet`, `unavailable`, `internal` from the reference app); `message`: at most 300 characters for the user | the requesting origin | as for `login-result`; ends the request as `failed` with `identityCode` |

The site's binding checks on a result, before it reports success: `domain_hash` equals `domainHash(location.origin)`; `session_commitment` equals `Poseidon(sessionKey, expirySlot)` for the key this request sent; `home_hash` is the hash of the zero home (a login must not bind the wallet); `authorization_context` is 0 (a login, not a pocket authorization); and the holdings claim is present with the requested mint and at least the requested threshold when one was asked for, and absent otherwise. The identity app runs the same checks before it posts (`request.approve` throws instead of sending). The Groth16 proof itself is verified only by the backend, which has the verifying key and trusted roots.

The backend receives (`HandoffSignInBody`, decoded by `parseHandoffSignIn`):

| Field | Used for |
| --- | --- |
| `proof`, `publicSignals` | `verifyLogin({ proof, publicSignals, ... })` |
| `key32Hex`, `expirySlot` | `expect.session.key32` and `expirySlot`; `verifyLoginChallenge`'s `key32` |
| `signatureHex` | `verifyLoginChallenge`'s `signature`, over `loginChallengeDigest(nonce)` |

plus whatever the site adds, such as the `challengeId` naming its nonce.

## Outcomes on the site

`requestLogin` resolves with a `HandoffLogin` or rejects with a `HandoffError` whose `code` is one of:

| Code | When |
| --- | --- |
| `popup_blocked` | `window.open` returned null. Call `requestLogin` directly in a click handler. |
| `closed` | The popup was closed before an answer arrived (checked every 400 ms, with a 300 ms grace for an answer already in flight). |
| `refused` | The user declined. |
| `failed` | The identity app could not complete the login; `identityCode` and `message` say why. |
| `timeout` | No answer within `timeoutMs` (default five minutes). The popup is closed. |
| `aborted` | The caller's `AbortSignal` fired. The popup is closed. |
| `unsupported_version` | The identity app announced another protocol version. |
| `invalid_response` | A correlated answer was not a login for this origin, this key and this claim. |
| `invalid_request` | The options were refused before anything was opened. |

After any outcome the listener is removed, so duplicate and late messages are never processed.

## Origin rules

- An acceptable origin is exactly what browsers serialize as `location.origin` and `MessageEvent.origin`: `https://host[:port]`, or `http://` on `localhost`, `*.localhost`, `127.0.0.1` or `[::1]` for development (`handoffOrigin`). Opaque origins (`"null"`), paths, trailing slashes, credentials and other schemes are refused.
- The identity app takes the requesting origin **only** from `event.origin` of a message whose `event.source` is its `window.opener`. No field in the request names an origin, and extra fields are ignored. A message from another window, a frame inside the opener, or a different origin is ignored.
- It proves for exactly that origin (`client.forOrigin(event.origin)`), shows exactly that origin, and posts every answer with `targetOrigin` set to exactly that origin, never `"*"`. If the opener has navigated to another origin meanwhile, the browser drops the answer.
- The site posts its request only to the window it opened, with `targetOrigin` set to `identityOrigin`, and accepts messages only from that window at that origin.
- The identity origin must differ from the site's: `requestLogin` refuses to run on the identity origin, and the identity app ignores requests from its own origin.

## Where the session key lives, and why

The site generates the Ed25519 session key pair in its own page (`softwareSession()`), sends only the 32-byte public key, and keeps the private key in memory. The proof binds that key and the expiry (`session_commitment`). The site signs its backend's nonce itself, after the handoff.

- The private key never crosses an origin, so nothing secret travels through `postMessage` in either direction.
- The identity app never sees the backend's nonce. It cannot be used as a signing oracle for a site, and a stolen `login-result` is useless without the site's key: the backend requires a fresh signature by the bound key.
- The alternative, an identity-app key, would require either sending a private key across origins or having the identity app sign each site's nonce, which adds a message type and lets any page that can open the identity app request signatures over chosen data.
- Passkey (P-256) session keys are not offered through the handoff, because `verifyLoginChallenge` checks Ed25519 only.

## Deployment requirements

Identity app:

- Serve it on a dedicated origin that hosts nothing else, over https.
- Send `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY` on every response (the reference app does, in `next.config.mjs`). The consent screen must never render inside another page.
- Do not send `Cross-Origin-Opener-Policy: same-origin` or `same-origin-allow-popups`; the reference app sends `unsafe-none`. Either of the others severs `window.opener`: the app could not learn who is asking, and the site would see the window as closed at once.
- Pin the proving artifacts (`LOGIN_*_SHA256`); add a full Content Security Policy (script nonces, `connect-src` for the indexer, relayer and RPC, `worker-src 'self' blob:`) for production. The reference app sets only `frame-ancestors`.

Site:

- `Cross-Origin-Opener-Policy: same-origin-allow-popups` is compatible; `same-origin` is not (every sign-in ends as `closed`).
- Verify on a Node.js server runtime with your own RPC and indexer, consume each nonce exactly once, and check the `Origin` header of the sign-in POST against your own origin (login CSRF: see below).

## Popup blockers and fallbacks

`requestLogin` opens the popup before its first `await`, so browsers treat it as part of the click. A site must call it directly from the click handler, not after fetching something; fetch the nonce after the handoff (the session key signs it then). `<ContinueWithGhostLink identityOrigin=…>` does this.

If the popup is blocked, the call rejects with `popup_blocked` and the button shows "The browser blocked the sign-in window. Allow pop-ups for this site and try again." **No other fallback is supported**: there is no redirect flow, because carrying a proof back through a URL needs registered return addresses, leaks the proof into history and logs, and is a different protocol. Mobile browsers that open the popup as a new tab keep `window.opener` and work the same way; in-app browsers that drop the opener show the identity app's "nothing to approve" page, and the site eventually reports `closed` or `timeout`.

## Example

The site, in a click handler:

```ts
import { requestLogin, HandoffError } from "@ghostlink/sdk";
import { hexToBytes } from "@ghostlink/common";

async function continueWithGhostLink(): Promise<void> {
  try {
    // Opens the popup synchronously; resolves once the user approves.
    const login = await requestLogin({ identityOrigin: "https://id.example.com" });
    const { challengeId, nonce } = await (await fetch("/api/nonce", { method: "POST" })).json() as { challengeId: string; nonce: string };
    const body = { challengeId, ...await login.signChallenge(hexToBytes(nonce)) };
    await fetch("/api/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch (error) {
    if (error instanceof HandoffError && error.code === "popup_blocked") { /* ask the user to allow pop-ups */ }
    throw error;
  }
}
```

Its backend:

```ts
import { parseHandoffSignIn } from "@ghostlink/sdk";
import { verifyLogin, verifyLoginChallenge } from "@ghostlink/verify";

// Your single-use nonce store (get and delete atomically) and your own RPC's current slot.
declare const nonces: { take(challengeId: string): Promise<Uint8Array | undefined> };
declare function currentSlotFromYourRpc(): Promise<bigint>;

async function verifyHandoffSignIn(json: { challengeId: string }): Promise<string | null> {
  const nonce = await nonces.take(json.challengeId);
  const signIn = parseHandoffSignIn(json);
  if (!nonce || !signIn) return null;
  const currentSlot = await currentSlotFromYourRpc();
  const result = await verifyLogin({
    proof: signIn.proof,
    publicSignals: signIn.publicSignals,
    expectedDomain: "https://app.example.com", // this site's own origin, from configuration
    roots: "http://127.0.0.1:8787",           // your indexer
    expect: { session: { key32: signIn.key32, expirySlot: signIn.expirySlot, currentSlot } },
  });
  if (!result.ok) return null;
  return verifyLoginChallenge({ key32: signIn.key32, nonce, signature: signIn.signature }) ? result.appId : null;
}
```

The identity app's handoff page (the reference app adds the consent screen around this):

```ts
import { GhostLink, listenForHandoffRequest, type DerivedIdentity, type HandoffLoginRequest } from "@ghostlink/sdk";

declare const identityClient: GhostLink;        // GhostLink.init({ ..., chain, prover }) on the identity origin
declare const unlockedIdentity: DerivedIdentity; // deriveIdentity(...) after the user connected their wallet
declare const walletKey: Uint8Array;
declare function showConsent(origin: string, request: HandoffLoginRequest): Promise<boolean>;

listenForHandoffRequest({
  async onRequest(request) {
    // request.origin is MessageEvent.origin of a message from window.opener: show it, prove for it.
    if (!await showConsent(request.origin, request)) return request.refuse();
    const witness = await identityClient.witness({ identity: unlockedIdentity, wallet: walletKey, mint: request.claim?.mint });
    const currentSlot = await identityClient.currentSlot();
    const authorization = await identityClient.forOrigin(request.origin).authorizeLogin({
      identity: unlockedIdentity, witness, claim: request.claim, currentSlot,
      session: request.session, expirySlot: currentSlot + (request.sessionSlots < 9_000n ? request.sessionSlots : 9_000n),
    });
    request.approve({ proof: authorization.proof, expirySlot: authorization.expirySlot }); // posts to request.origin only
  },
});
```

## Security argument

The claims, and why each holds given the browser's guarantees (`MessageEvent.origin` and `source` are set by the browser; `postMessage` with a specific `targetOrigin` is delivered only to a window currently at that origin; the same-origin policy isolates the identity origin's memory and storage):

1. **A page cannot obtain a proof for another site's origin.** The identity app proves only for `event.origin` of an accepted request, which the browser sets to the sending page's real origin; no request field is consulted. A page at `evil.example` that opens the identity app gets a consent screen and, at most, a proof bound to `domainHash("https://evil.example")`, which every other site's `verifyLogin` refuses (`wrong_domain`).
2. **A third party cannot inject a request or read an answer.** Requests count only from `window.opener`, so another tab, a frame or a window that found the popup's name cannot inject one; the popup's name contains 64 random bits and only the opener holds its reference. Answers go to the opener with `targetOrigin` = the requesting origin, so if the opener navigated elsewhere the answer is dropped. The site accepts answers only from the popup object it opened at `identityOrigin`, matching its random request ID, so another window cannot forge a refusal or a result.
3. **Nothing secret leaves the identity origin.** The only data sent to the site is a Groth16 proof, its 12 public signals (which never include the wallet address: the home is the zero home and the identity commitment is not a signal) and an expiry slot. The SDK test suite and the local end-to-end check search every message the site receives for the secret, the commitment and the wallet address.
4. **A captured answer is not a login.** The proof binds the site's session public key and expiry. The backend accepts it only together with a fresh signature by that key over a nonce it issued and consumes once. The private key never leaves the site's page.
5. **Consent cannot be clicked through blindly.** The identity app refuses to be framed (`frame-ancestors 'none'`, `X-Frame-Options: DENY`), and its Approve button arms only after the request has been visible for a second in a focused window, so a page that opens the popup under the user's pointer cannot turn a click meant for itself into an approval.
6. **Replays and duplicates are inert.** The identity app accepts one request per page load and answers it once. The site removes its listener after the first outcome; the backend consumes nonces atomically.

## What this does not protect against

- **A malicious or compromised identity app.** It holds the secret: it can sign the user in anywhere, link every site's ID and show any consent text. Users trust the identity origin's operator and its hosting completely. Pinned proving artifacts protect the witness generator, not the app's own code.
- **A lookalike identity app.** A site can open a page on another origin that looks like the identity app and ask the wallet to sign the identity message, phishing the secret. The popup's address bar, and wallets that display the Sign-In-With-Solana domain, are the defences; wallet warnings vary and are not a hard block, and a device-held second factor ([factor.ts](../packages/sdk/src/factor.ts)) makes a phished signature alone insufficient. The opener can also navigate the popup it opened to such a page mid-flow; the same defences apply.
- **A compromised site.** Script running on the site (for example through XSS) can run the handoff and sign the user in to that site, and only that site. Proofs for other sites remain unobtainable.
- **Login CSRF.** Anyone with an identity can obtain a valid proof for a site and try to sign a victim's browser in to the attacker's account. The starter checks the `Origin` header of its nonce and verify routes and uses `SameSite=Lax` cookies; every site should.
- **Clickjacking of the site's own button** is the site's concern; the starter refuses framing too.
- **Correlation by the infrastructure.** The identity app's server sees page loads, and the request for `/handoff` usually carries the site's origin in `Referer` (the site's referrer policy decides; `window.open` cannot drop it without also dropping the opener). The indexer learns the wallet and mint when the witness is fetched (`client.witness`; `localWitness` avoids it for the registry path). The relayer sees registrations and snapshots. None of them see which site a proof was for unless they also see the request.
- **Session length.** The identity app caps the session (`HANDOFF_MAX_SESSION_SLOTS`, default 9000 slots, about an hour), and the backend caps it again (`maxSessionSlots`); the site's own cookie should not outlive it (the starter's does not).

## Versioning

Every message carries `version`. Version 1 sites and identity apps accept exactly version 1: a site ends a request whose `ready` names another version as `unsupported_version`, and an identity app ignores requests of another version (the site then times out). A later version that keeps the envelope can be introduced by identity apps announcing it while still accepting version-1 requests; a change to the meaning of a version-1 field needs a new version.
