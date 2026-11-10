# ADR 0008: Cross-origin identity handoff for "Continue with GhostLink"

Status: implemented development candidate, 2026-11-10. Protocol version 1, specified in [IDENTITY-HANDOFF.md](../IDENTITY-HANDOFF.md). Not independently reviewed. Programs and circuits are unchanged.

## Context

A site could not offer "Continue with GhostLink" without holding the user's identity secret:

- The secret is derived from a wallet signature over a fixed message naming one identity domain, and the registry accepts one registration per wallet, so all sites using a deployment must share one identity origin.
- Whoever holds the secret can compute the user's `app_id` at every site, so it must never be given to the sites themselves. The threat model recorded this as an architectural gap: "an isolated cross-origin broker is not included".
- `ContinueWithGhostLink` ran a callback the integrator had to write, and the only in-page flow (`client.prove`) needs the secret in that page.

## Decision

**A popup broker on its own origin.** A site opens the deployment's identity app with `window.open` from a click; the two talk only through `postMessage`. The identity app learns the requesting origin from `MessageEvent.origin` of a message whose `source` is its `window.opener`, never from the payload; it shows that origin on a consent screen, proves for exactly that origin, and posts the answer to exactly that origin. Five message types (`ready`, `login-request`, `login-result`, `login-refused`, `login-error`), a random 32-byte request ID, and a `version` field.

**The site holds the session key.** The site generates an Ed25519 key pair, sends the public key, and signs its backend's nonce after the handoff. The proof binds the key and expiry, so nothing secret crosses origins in either direction and the identity app never signs data a site chose.

**Login only.** The handoff produces login proofs (zero home, `authorization_context = 0`). Pocket authorizations for bots keep their existing owner flows ([OWNER-CONSENT.md](../OWNER-CONSENT.md)).

**SDK surface.** `requestLogin` (site), `listenForHandoffRequest` (identity app), `parseHandoffSignIn` (backend) and `handoffOrigin` in `@ghostlink/sdk`; two client methods for the identity app: `forOrigin(origin)`, a client whose proofs and owner actions are for another origin, and `authorizeLogin`, a login-only proof bound to someone else's Ed25519 public key. `forOrigin` grants nothing new (the pure helpers already accept any origin) but makes the identity app's use explicit. `ContinueWithGhostLink` gains `identityOrigin` and `onSignIn` and works without a provider in that mode; `onLogin` is unchanged.

**Reference implementations** in `examples/`: an unbranded identity app (Next.js, Wallet Standard, worker prover, environment configuration, framing refused) and a starter site with nonce and verification routes.

## Alternatives considered

- **Give each site the secret, or derive per-site identities on each site's domain.** The first defeats unlinkability; the second spends the wallet's single registration on the first site.
- **A hidden cross-origin iframe broker.** No consent surface the user can see, so it would sign in to any embedding page silently; storage partitioning in current browsers gives the iframe a different storage per top-level site anyway; and a framed broker invites clickjacking. A visible popup with framing refused is the established wallet pattern.
- **A redirect flow.** Works without popups, but carries the proof in a URL (history, logs, referrers), needs a registry of return addresses per site, and a different origin check. Not implemented; a blocked popup is reported as `popup_blocked`.
- **The identity app generates the session key.** It would have to send a private key across origins, or sign each site's nonce, which turns it into a signing oracle for chosen data. Rejected.
- **A browser extension (an injected Wallet Standard wallet).** Strong isolation, but every user would need to install it. The handoff works in any browser and can sit behind an extension later.
- **`BroadcastChannel` or shared storage.** Same-origin only; they cannot connect two origins.
- **Origin in the request payload, checked against a list.** A payload can say anything; only the browser-reported origin is authoritative, so the payload carries no origin at all.

## Consequences

- Sites integrate with a button, two server routes and `@ghostlink/verify`; they never handle identity material.
- The identity app is a single point of trust per deployment: whoever controls the identity origin controls every user's identity. The threat model now says so explicitly.
- A lookalike popup can still phish the identity-message signature; the address bar, wallets that show the sign-in domain and the optional device factor are the defences, as before.
- Every page load of the identity app asks the wallet to sign the identity message again (twice), because the reference app keeps the identity in memory only. Persisting it encrypted is possible later and would need its own review.
- The identity app's server can learn which site opened it from `Referer`; the indexer learns the wallet when a witness is fetched.
- Version 1 is exact on both sides; a later version must keep the envelope or be announced alongside version 1.
