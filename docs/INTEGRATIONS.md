# Integrating GhostLink with bots and applications

This is an experimental V2 integration contract, tested on local validators. There is no official public V2 deployment; integrations run against a [deployment](DEPLOYMENTS.md) their operator creates and names in a deployment manifest. See [mainnet readiness](MAINNET-READINESS.md) before planning a real-funds launch and [SDK installation](../packages/sdk/README.md) for local archives. There is no claim of compatibility with a named third-party bot until its operator integrates and verifies the flow.

## Telegram bot and Mini App flow

1. The bot backend authenticates its Telegram webhook/update source. If it uses a Mini App, it validates Telegram `initData`, its age and expected bot; never trust `initDataUnsafe` or a chat ID supplied by the browser.
2. The backend creates a session signer scoped to that user and bot. Persisting it across restarts requires protected server-side key storage; never send the private session key through Telegram messages, URLs, analytics or the user's browser. A hardware-backed signer may implement `SessionSigner` if it produces the required signature format.
3. Create a cryptographically random, short-lived authorization request ID. The server record binds the authenticated Telegram user, application origin, session public key, intended pocket, chain/deployment, requested policy, home and expiry. The link carries only an opaque identifier. Fetching a link does not approve it.
4. In a separately trusted owner context, show those permissions. Derive the owner's identity (`deriveIdentity`), gather its witness (`client.witness`) and generate the proof locally with `authorizeSession`, or with the [owner consent controller](OWNER-CONSENT.md) for a shared owner application. Never put the identity secret in a third-party bot Mini App or backend. The SDK is not itself an isolation sandbox; a hosted origin-enforcing broker is still required for untrusted integrations.
5. Submit `openSession`; it waits for confirmation. The bot independently checks the RPC genesis/deployment, program ownership/layout, pocket, session key/expiry and active policy. Atomically mark the one-use request complete for that authenticated user; a replay or another user's callback must fail.
6. Before trading, obtain a quote and check the supported token programs, on-chain policy, fresh oracle data, output amount, deadline, liquidity and fees. Reserve a nonce durably per pocket. Sign the canonical intent and submit through the reviewed solver.
7. Reconcile the transaction on chain before reporting success. A transport timeout is an unknown outcome, not permission to create a second trade. Persist the intent hash, nonce, signature if known, and state. Retry/reconcile the same intent; never silently issue a new nonce for an uncertain prior trade.
8. Stop on session expiry/replacement, policy change, stale data or insufficient budget. Renewal needs fresh owner authorization. Support revoke and sweep-home recovery (`proveOwnerAction` then `submitOwnerAction`, see [owner recovery](OWNER-RECOVERY.md)), and explain the current compromised-session recovery race documented in ADR 0002.

## SDK calls for each step

The [SDK guide](../packages/sdk/README.md#the-whole-journey) runs this whole sequence as one program, and [`services/e2e/src/run.ts`](../services/e2e/src/run.ts) runs it against a local validator.

| Step | Call | Notes |
| --- | --- | --- |
| Client | `GhostLink.init({ cluster, deployment, indexer, relayer, chain, prover, origin })` | `deployment` is the operator's manifest; `chain` is any `ChainReader` (`jsonRpcChainReader(url)` needs only `fetch`); `origin` is required outside a browser. |
| Identity | `deriveIdentity(signMessage, { cluster, domain, address })` | Same wallet, domain, cluster and factor always give the same identity. |
| Registration | `client.register(...)` or `client.registerInstructions(...)` | Once per wallet, forever. |
| Token gate snapshot | `client.snapshot({ wallet, mint })` or `client.snapshotInstructions(...)` | One per holding per minute through the relayer. |
| Witness | `client.witness({ identity, wallet, mint?, wait: { timeoutMs } })` | A new registration or snapshot is provable after its root bucket ends, about a minute. |
| Login | `client.prove(...)`, then `verifyLogin` and `verifyLoginChallenge` on the backend | Branch on `result.code`. |
| Bot session | `client.authorizeSession(...)`, `client.pocketFor(...)`, `client.openSession(...)` | Reads the revocation epoch from chain; refuses renewals the program would refuse. |
| Trading | `signIntent`, `client.submitSignedIntent`, `client.intentStatus` | Persist before sending; reconcile, never re-sign, after a timeout. |
| Recovery and changes | `client.proveOwnerAction(...)`, `client.submitOwnerAction(...)` or `client.ownerActionInstructions(...)`, `client.executeChangeInstructions(...)` | One proof per action: it binds the pocket's current owner action nonce. |

Relayer refusals are `RelayerRequestError` with a stable `code` (`rate_limited`, `snapshot_cooldown`, `partner_only`, `simulation_failed`, ...); unknown outcomes are `RelayerOperationPendingError`, which keeps the operation to finish with `RelayerClient.settle`. The full list is in the [SDK guide](../packages/sdk/README.md#errors).

The installed SDK provides public-key descriptors, local proof preparation, intent signing and explicit submission/status clients. The separate bot backend supplies Telegram authentication, encrypted consent/key storage and durable nonce/signed-order allocation using a stable business request key; the reference solver supplies an encrypted transaction journal and restart reconciliation. The trusted product UI, strategy scheduler, coordinated restore and live DEX route remain unfinished. See [transaction recovery](TRANSACTION-RECOVERY.md). No bot token is needed in the public SDK or browser bundle.

The V2 candidate binds the approved policy, session kind and program IDs into the login proof and uses `open_session_v2`. A login-only proof cannot activate spending. The maintainers have not deployed it: the existing devnet app remains on V1. Pass the operator's manifest to `GhostLink.init({ deployment })` and to `verifyLogin` (`sessionDeployment(manifest)`) so addresses and proofs bind that deployment's programs. See [the protocol/migration decision](adr/0003-session-authorization-v2.md) before integrating.

For named-provider findings and implementation priorities, see [bot compatibility research](BOT-COMPATIBILITY.md).

## Trading adapters

Keep route discovery and signing separate. A strategy proposes exact input/output bounds; a solver planner produces instructions. Validate the program/account/signing set and destination, and compose signature verification, `fill_begin`, the route, and `fill_end` in one transaction. Reject unexpected authorities, destination substitutions and unsupported token programs. The chain enforces the session, policy, nonce, deadline and actual output balance change.

Versioned transactions, lookup tables, compute limits and bounded priority fees need implementation before complex mainnet routes. A solver fee payer must have an explicit fee/rent budget. Do not finance attacker-controlled account creation without an abuse model. Route setup, refunds and wrapped-SOL cleanup must not withdraw the pocket's unrelated balances.

Jupiter's current [Router API](https://dev.jup.ag/docs/swap) is the candidate for composable swaps. Other aggregators, direct pools and launchpad programs require individual adapters. A bot that only imports a normal wallet private key is not compatible with a Pocket PDA; exporting the owner's key defeats the authorization design.

## Login and access gates

Issue a random backend challenge, store its intended app/session and short expiry, verify the returned proof with `@ghostlink/verify`, then verify the proof-bound session signature over `loginChallengeDigest(challenge)` (`verifyLoginChallenge` in `@ghostlink/verify` does this for Ed25519 sessions). Consume the challenge atomically before issuing the site's own session cookie. Check domain, session expiry, chain roots and all requested claim fields. A copied valid proof is not a bearer login token.

For a token gate, require the intended mint, threshold and snapshot freshness: `verifyLogin` refuses a holdings claim unless you pass `expect.minSlot`. A holdings proof concerns a recorded snapshot; it does not lock tokens or guarantee that the user still holds them. The census refuses a snapshot that shares its transaction with anything that could lend the balance, but a balance borrowed in an earlier transaction and repaid in a later one still records, so keep the freshness window short and do not gate anything irreversible on one snapshot ([ADR 0005](adr/0005-census-spam-resistance.md)). A new snapshot becomes provable about a minute after it lands, once its root-history bucket ends. Telegram membership/access removal requires the integrating bot to recheck eligibility and manage its own permissions. Do not turn a login proof into trading consent.

## Acceptance tests for each integration

| Boundary | Required observable behavior |
| --- | --- |
| Installation | Clean external Node project installs reviewed archives, imports SDK and resolves TypeScript types without workspace links |
| Authorization | Bot-key substitution, wrong Telegram user, expired or replayed request, wrong app/domain and wrong chain are refused |
| Secrets | Owner identity/witness never reach bot/backend/logs; only public descriptor and proof cross the intended boundary |
| Session | Old key stops after rotation; expired/revoked keys fail; existing policy cannot be replaced by a renewal request |
| Trading | Real supported route delivers at least the signed minimum; failed route leaves no partial pocket spend |
| Assets | Unknown program/extensions/feed bindings refused; decimals, fees and rent accounted for correctly |
| Retries | Duplicate commands and timeout-after-broadcast do not create a second trade; restart preserves nonce and pending outcomes |
| Recovery | User can inspect policy, stop new orders and recover funds through the documented owner path; exercise known racing-session limitation |
| Mobile | Real Telegram iOS/Android/Desktop and supported wallet handoffs work; reject/close/account-switch paths recover cleanly |

Record revision, network, wallet/runtime, route and actual confirmed signatures for on-chain tests. Fixture/unit tests are useful but must not be presented as a live Telegram, DEX or mainnet certification.
