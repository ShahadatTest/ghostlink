# Examples

Small, runnable programs that show GhostLink's core ideas with real code. Each runs offline in seconds, and CI runs every one, so they stay in step with the packages.

```bash
pnpm install --frozen-lockfile
pnpm -r build
pnpm --filter @ghostlink/example-verify-login start
pnpm --filter @ghostlink/example-bot-session start
```

| Example | What it shows |
| --- | --- |
| [`verify-login`](verify-login/src/index.ts) | A website backend verifies a real Groth16 login proof with `@ghostlink/verify`. The proof says "registered, holds at least 100 tokens" without containing a wallet address. Replays on another domain, inflated claims, stale snapshots, unknown trees and tampered signals are all rejected. |
| [`bot-session`](bot-session/src/index.ts) | A trading bot creates a temporary session key, shares only the public key, and signs an exact swap intent for a policy-limited pocket with `@ghostlink/sdk`. Changing the amount, the minimum output or the policy breaks the signature. |

## Going further

- **Full local stack.** `bash scripts/localnet-e2e.sh` starts a disposable validator and the reference services, then runs register, snapshot, consent, prove, verify, open, fund, trade and recover end to end. See [docs/SETUP.md](../docs/SETUP.md).
- **Headless integration.** [`services/e2e/src/run.ts`](../services/e2e/src/run.ts) drives the whole SDK against that stack. [`services/e2e/src/bot-session.ts`](../services/e2e/src/bot-session.ts) exercises the bot backend contract.
- **Bot backend.** [`@ghostlink/bot`](../packages/bot/README.md) adds Telegram authentication, encrypted key storage and durable nonce and order tracking.

The examples use public test fixtures and no network. They are not production code. Read [docs/INTEGRATIONS.md](../docs/INTEGRATIONS.md) before building a real integration.
