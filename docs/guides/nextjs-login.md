# Add "Continue with GhostLink" to a Next.js site

This guide takes you from a fresh clone to signing in to a Next.js site on a local validator. The site never handles anyone's identity: a separate identity app, on its own origin, opens in a popup, asks the user to approve, and sends the site a zero-knowledge login proof bound to the site's origin. The site's server checks the proof and gets a stable ID for the user that no other site can link to.

You will run four things:

| What | Where | Port |
| --- | --- | --- |
| Local validator and the reference services (indexer, relayer, solver, Actions) | Linux or WSL | 8899, 8787, 8788, 8789, 8790 |
| The identity app, [`examples/identity-app`](../../examples/identity-app) | any terminal | 3001 |
| The starter site, [`examples/nextjs-login`](../../examples/nextjs-login) | any terminal | 3000 |
| A browser | | |

Development networks only. The proving keys made below come from a single-party development setup; never use them with real funds. The protocol between the site and the identity app is described in [IDENTITY-HANDOFF.md](../IDENTITY-HANDOFF.md).

## 1. Clone and build

You need Node 22 or 24, pnpm 10.33.2, and for the local stack the Solana and Anchor toolchains and circom listed in [SETUP.md](../SETUP.md).

```sh
git clone https://github.com/Ghostlink-Labs/ghostlink.git
cd ghostlink
pnpm install --frozen-lockfile
pnpm -r build
```

`pnpm -r build` also builds both examples with `next build`, so a successful build means they compile.

## 2. Get proving files and build the programs

Download the development proving files into `circuits/build` (the identity app proves with these), then build the programs. On Windows, run the shell script in WSL.

```bash
node scripts/proving-artifacts.mjs fetch   # checked by SHA-256 against circuits/keys/proving-artifacts.json
bash scripts/build-programs.sh
```

To build the circuits and your own keys instead, follow [Fresh local proving setup](../SETUP.md#fresh-local-proving-setup) in a disposable branch.

The `.wasm` and `.zkey` files stay in `circuits/build`, which is not committed. The identity app serves them to the browser itself on a local validator (the route `/circuits/[name]`), so you never copy them anywhere.

## 3. Start the local stack

On Linux or in WSL, from the repository root:

```sh
GHOSTLINK_KEEP_RUNNING=1 bash scripts/localnet-e2e.sh
```

It starts a fresh validator, runs the end-to-end journey, and then leaves the validator and services running on 127.0.0.1: RPC 8899, indexer 8787, relayer 8788, solver 8789, Actions 8790. Wait for `Local demo stack running`. Stop it with Ctrl+C when you are done. (WSL forwards these loopback ports to Windows, so the apps below can run on either side.)

## 4. Start the identity app

In a second terminal:

```sh
cd examples/identity-app
cp example.env .env.local   # every value already points at the local stack; IDENTITY_DEV_WALLET=1 adds a test wallet
pnpm dev                    # http://localhost:3001
```

`.env.local` is never committed (the repository ignores `.env.*`). The example file documents every variable: the deployment manifest, the indexer, relayer and RPC, the proving artifact URLs and their SHA-256 pins, the app's display name and the longest session it grants.

Open http://localhost:3001 and set up an identity:

1. **Connect a wallet.** Any browser wallet that supports the Wallet Standard works, because the app only asks it to sign messages. Or choose **Development wallet**: a key kept in this browser's storage, offered on a local validator only.
2. **Get 2 test SOL** (local validator only). The relayer registers only wallets that hold a little SOL, and the starter can gate on SOL.
3. **Unlock identity.** The wallet signs a fixed sign-in message for `localhost:3001` twice; the identity is computed from that signature in this page and kept in memory only.
4. **Register this identity.** The wallet signs the registration message; the relayer pays and submits it.
5. Optional: **Take snapshot** of native SOL, if you turn on the token gate in step 5.

A registration (or snapshot) can be proved about a minute after it confirms, once its root-history bucket ends.

## 5. Start the site

In a third terminal:

```sh
cd examples/nextjs-login
cp example.env .env.local
pnpm dev                    # http://localhost:3000
```

To make it members-only, uncomment the three `GATE_*` lines in `.env.local` (at least 1 SOL, snapshot no older than about an hour) and restart `pnpm dev`.

## 6. Sign in

Open http://localhost:3000 and press **Continue with GhostLink**.

1. A popup opens on http://localhost:3001/handoff and shows **http://localhost:3000** as the site asking, what it will receive and for how long. That address comes from the browser, not from anything the site sent.
2. Connect the same wallet and unlock the identity in the popup (the popup is a new page, so the wallet signs again).
3. Press **Approve and sign in to localhost:3000**. The popup proves on your device, sends the proof to the site and is closed by it.
4. The site fetches a nonce, signs it with the session key the proof is bound to, and posts everything to its verification route. You land on **You are signed in** with your ID for this site.

Sign out and in again: the ID is the same. A site on any other origin gets a different ID for the same identity, and neither site can link the two (the check in [Check it without a browser](#check-it-without-a-browser) signs in at a second origin to show it).

Things to try: **Decline** in the popup, or close it, and the site shows why the sign-in did not complete; block pop-ups for localhost:3000 and the button tells you to allow them.

## How the site does it

Three small pieces, all in [`examples/nextjs-login`](../../examples/nextjs-login):

**The button** ([`components/sign-in.tsx`](../../examples/nextjs-login/components/sign-in.tsx)), a client component:

```tsx
<ContinueWithGhostLink
  identityOrigin="http://localhost:3001"
  onSignIn={async (login) => {
    const { challengeId, nonce } = await post("/api/ghostlink/nonce");
    await post("/api/ghostlink/verify", { challengeId, ...await login.signChallenge(hexToBytes(nonce)) });
    router.push("/signed-in");
  }}
/>
```

The button opens the popup inside the click (so pop-up blockers allow it), generates the session key in this page and keeps its private half here. `login` holds the proof, its public signals, the expiry and the session key; `signChallenge` signs the server's nonce with that key.

**The nonce route** ([`app/api/ghostlink/nonce/route.ts`](../../examples/nextjs-login/app/api/ghostlink/nonce/route.ts)) returns a random 32-byte nonce under a random ID and keeps it for two minutes.

**The verification route** ([`app/api/ghostlink/verify/route.ts`](../../examples/nextjs-login/app/api/ghostlink/verify/route.ts), logic in [`lib/sign-in.ts`](../../examples/nextjs-login/lib/sign-in.ts)) runs on the Node.js runtime and, in order:

1. refuses requests whose `Origin` is not this site (login CSRF);
2. takes the nonce by its ID and deletes it, whatever happens next;
3. decodes the body with `parseHandoffSignIn`;
4. reads the current slot from **its own RPC**;
5. calls `verifyLogin` with `expectedDomain` set to **its own origin** from configuration, roots from **its own indexer**, `expect.session` set to the announced key and expiry (and the token gate, if configured);
6. calls `verifyLoginChallenge` with the same key, the nonce and the signature;
7. creates a session whose cookie expires no later than the proof's session.

Nothing the browser says about the origin, the slot or the roots is trusted. The ID it stores is `verifyLogin`'s `appId`, shown in base58.

## Check it without a browser

With the stack from step 3 running:

```sh
pnpm --filter @ghostlink/example-nextjs-login e2e
```

registers a fresh wallet, runs the identity app's approval code and these route handlers against the validator with a real proof (the popup is simulated with two message-passing windows), checks that replays, another site's proof, a refusal and an unmet token gate fail, and exercises the identity app's revoke and sweep on a pocket at the site's origin. `pnpm --filter @ghostlink/example-nextjs-login test` runs the route tests offline with the repository's published fixture proof.

## Before you go beyond a local validator

- Run your own identity app on a dedicated https origin, or use one you trust completely: it holds every user's identity. Keep its `frame-ancestors 'none'` header and do not give it a `Cross-Origin-Opener-Policy` of `same-origin`.
- Pin the proving artifacts (`LOGIN_WASM_SHA256`, `LOGIN_ZKEY_SHA256`) and use a deployment manifest ([DEPLOYMENTS.md](../DEPLOYMENTS.md)).
- Replace the starter's in-memory nonce and session stores with a shared store that can get-and-delete atomically.
- Set `SITE_ORIGIN` to the exact address users open, and keep `verifyLogin` on a Node.js runtime.
- Read [what the handoff does not protect against](../IDENTITY-HANDOFF.md#what-this-does-not-protect-against) and the [threat model](../THREAT-MODEL.md).
