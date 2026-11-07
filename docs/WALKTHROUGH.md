# App walkthrough

These screenshots show the **hosted devnet app** at [app.ghostlink.software](https://app.ghostlink.software), which runs the earlier V1 protocol deployment. The code in this repository is the newer V2 protocol, tested on a local validator. The screens were captured on 17 October 2026 directly from the running app with a fresh, disposable demo identity. No real wallet, personal balance or seed phrase appears, and empty balances are intentional: the images illustrate the controls, not a successful trade.

The application source is private. The screenshots have their own [image terms](media/screenshots/LICENSE.md).

## 1. Establish an identity on your device

<img src="media/screenshots/01-sign-in.jpg" alt="Sign-in screen explaining local identity derivation and repeatable wallet message signatures" width="900">

The setup screen explains what the wallet is asked to do. The app checks repeatable signatures over a setup message and derives the identity in the page. That setup message is different from a transaction. Registration, pocket creation, funding and trading have their own steps.

The interface offers a real wallet or a disposable demo wallet, with optional passkey protection. The demo wallet is for exploration in that tab; closing it can make that demo identity unrecoverable. For a real identity, understand wallet and factor-recovery requirements first.

**Check the origin yourself.** Local proving does not isolate your secret from malicious JavaScript on the page. A trusted owner interface and secure deployment are part of the security boundary.

## 2. Understand the overview

<img src="media/screenshots/02-overview.jpg" alt="GhostLink devnet overview with a disposable demo wallet, zero pockets, zero sweepable SOL and zero live sessions" width="900">

| Indicator | How to read it |
| --- | --- |
| **Pockets found** | Pockets discovered for this identity and the origins being inspected |
| **Sweepable SOL** | The app's displayed recoverable SOL amount, not a complete valuation of all tokens |
| **Live sessions** | The app's view of active sessions; integrators must verify current chain state |

A new identity has no funded pocket or active session. Adding an application origin looks up its derived address; it does not grant that application spending permission.

## 3. Create, fund and review a swap

<img src="media/screenshots/03-pocket-controls.jpg" alt="Devnet pocket controls with recovery home, Create pocket button, test-token pair, amount and disabled quote button before creation" width="900">

1. **Create a pocket.** Review the app, recovery home, session and limits. The owner produces the required proof locally and the service submits the opening operation.
2. **Fund it with test assets.** The demonstration offers test-token funding subject to its faucet limits. A normal integration needs an independently checked, wallet-approved deposit.
3. **Choose a supported pair and amount.** The demo uses `tUSDC` and `tSOL`, which have no monetary value. `tSOL` is a test token, not native SOL.
4. **Review the quote.** The service must have usable price data and sufficient inventory. The operation has exact amounts and limits.
5. **Wait for the actual outcome.** A submitted request or an HTTP response is not, by itself, confirmed settlement.

This is the **pre-creation state**: quote review is disabled until the necessary pocket and session exist. The limits shown are specific to this playground.

**Where does the trade happen?** The hosted demo settles against funded test inventory. The repository also contains an experimental Jupiter/Raydium adapter, tested locally. This screen is not evidence of live Jupiter routing or mainnet liquidity.

## 4. Inspect activity and limits

<img src="media/screenshots/04-activity-and-limits.jpg" alt="Activity table and defaults summary with spending cap, slippage, passkey threshold, session duration and home-change timelock" width="900">

Activity is an indexer view of the chain. It can lag or be unavailable; a cached row is not authority to sign another trade.

The lower panel is labelled **defaults for new pockets**. It explains policy concepts, not the permissions of an arbitrary existing pocket. Read the actual pocket's policy. Home or policy changes follow the owner-proof and timelock flow rather than a silent dashboard edit.

The owner flows are documented in [owner consent](OWNER-CONSENT.md) and [owner recovery](OWNER-RECOVERY.md).
