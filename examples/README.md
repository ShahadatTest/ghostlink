# Examples

Small, runnable programs that show GhostLink's core ideas with real code. CI builds, type-checks and tests every one, so they stay in step with the packages.

```bash
pnpm install --frozen-lockfile
pnpm -r build
pnpm --filter @ghostlink/example-verify-login start
pnpm --filter @ghostlink/example-bot-session start
```

| Example | What it shows |
| --- | --- |
| [`verify-login`](verify-login/src/index.ts) | A website backend verifies a real Groth16 login proof with `@ghostlink/verify`. The proof says "registered, holds at least 100 tokens" without containing a wallet address. Replays on another domain, inflated claims, stale snapshots, unknown trees and tampered signals are all rejected. Offline. |
| [`bot-session`](bot-session/src/index.ts) | A trading bot creates a temporary session key, shares only the public key, and signs an exact swap intent for a policy-limited pocket with `@ghostlink/sdk`. Changing the amount, the minimum output or the policy breaks the signature. Offline. |
| [`identity-app`](identity-app) | A reference **identity app** any deployment can host on its identity origin: connect a wallet, derive and register the identity, snapshot holdings, approve sites' sign-in requests on a consent screen, and revoke or sweep the pocket the identity has at a site. Unbranded Next.js; the name and every endpoint come from the environment ([`example.env`](identity-app/example.env)). |
| [`nextjs-login`](nextjs-login) | A minimal **Next.js site** with "Continue with GhostLink": the button opens the identity app in a popup, a route issues single-use nonces, another verifies with `verifyLogin` and `verifyLoginChallenge` against the site's own RPC and indexer, and a signed-in page shows the user's ID for this site ([`example.env`](nextjs-login/example.env)). |

The last two work together through the [identity handoff](../docs/IDENTITY-HANDOFF.md). The [Next.js login guide](../docs/guides/nextjs-login.md) walks through them from a fresh clone.

## Trying the sign-in in a browser

You need the local stack and the circuit files from [docs/SETUP.md](../docs/SETUP.md) (`circuits/build`, which is never committed). Three terminals:

| # | Where | Command | Serves |
| --- | --- | --- | --- |
| 1 | Linux or WSL, repository root | `GHOSTLINK_KEEP_RUNNING=1 bash scripts/localnet-e2e.sh`, then wait for `Local demo stack running` | RPC 8899, indexer 8787, relayer 8788, solver 8789, Actions 8790 |
| 2 | `examples/identity-app` | `cp example.env .env.local` once, then `pnpm dev` | http://localhost:3001 |
| 3 | `examples/nextjs-login` | `cp example.env .env.local` once, then `pnpm dev` | http://localhost:3000 |

`.env.local` is ignored by git. The identity app's example enables `IDENTITY_DEV_WALLET=1`, a test wallet kept in the browser's storage (local validator only), so no wallet extension is needed. For production builds use `pnpm build && pnpm start` in each example instead of `pnpm dev`; the ports are the same.

Then:

1. On http://localhost:3001: **Development wallet** (or your own wallet), **Get 2 test SOL**, **Unlock identity**, **Register this identity**. For the token gate also **Take snapshot** (native SOL).
2. Wait about a minute: a registration becomes provable when its root-history bucket ends.
3. On http://localhost:3000: **Continue with GhostLink**. In the popup check that it names `http://localhost:3000`, connect and unlock the same wallet, and **Approve**. The popup closes and the site shows your ID.

Worth checking by hand: **Decline** and closing the popup each give their own message on the site; with pop-ups blocked for localhost:3000 the button says so; http://localhost:3001/handoff opened directly says there is nothing to approve; the identity app refuses to load in a frame (`X-Frame-Options: DENY`, `frame-ancestors 'none'`); signing in twice gives the same ID. To test the token gate, uncomment the `GATE_*` lines in `examples/nextjs-login/.env.local` and restart the site.

Without a browser, with the stack from terminal 1 running: `pnpm --filter @ghostlink/example-nextjs-login e2e` drives the identity app's approval code and the site's route handlers with real proofs.

## Going further

- **Full local stack.** `bash scripts/localnet-e2e.sh` starts a disposable validator and the reference services, then runs register, snapshot, consent, prove, verify, open, fund, trade and recover end to end. See [docs/SETUP.md](../docs/SETUP.md).
- **Headless integration.** [`services/e2e/src/run.ts`](../services/e2e/src/run.ts) drives the whole SDK against that stack. [`services/e2e/src/bot-session.ts`](../services/e2e/src/bot-session.ts) exercises the bot backend contract.
- **Bot backend.** [`@ghostlink/bot`](../packages/bot/README.md) adds Telegram authentication, encrypted key storage and durable nonce and order tracking.

The examples are not production code. Read [docs/INTEGRATIONS.md](../docs/INTEGRATIONS.md) before building a real integration.
