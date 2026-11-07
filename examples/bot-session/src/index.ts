/**
 * A trading bot gets a budget, not your keys.
 *
 * 1. The bot creates a temporary session key and shares only its public key.
 * 2. The owner approves that key for one pocket: a program account with an on-chain policy
 *    (daily USD cap, slippage limit, allowed mints, expiry). That step needs a proof from the
 *    owner's device and a transaction, so this offline example derives the pocket directly.
 * 3. The bot signs exact swap intents. The Pocket program recomputes the intent hash, checks
 *    this signature, then enforces the policy and the delivered amount atomically.
 *
 * Nothing here touches a network or a wallet. Run it:  pnpm --filter @ghostlink/example-bot-session start
 */
import { ed25519 } from "@noble/curves/ed25519";
import { bytesToHex, conservativePolicy, intentHash, pk, policyHash, toBase58 } from "@ghostlink/common";
import { derivePocket, sessionPublicKey, signIntent, softwareSession, SESSION_KIND_ED25519 } from "@ghostlink/sdk";

const USDC = pk("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const WSOL = pk("So11111111111111111111111111111111111111112");

// 1. Bot side: a fresh Ed25519 session key. The secret never leaves the bot.
const bot = softwareSession();
const shared = sessionPublicKey(SESSION_KIND_ED25519, bot.key32);
console.log(`bot session public key   ${toBase58(shared.key32)}  (the only thing the bot shares)`);

// 2. Owner side: the pocket is derived from the owner's private, app-scoped user ID.
//    In a real flow it comes from the owner's identity via the SDK. This is a fixed test value.
const appUserId = 12825688885195816974784361026181585588691881531552287423485218219078933215697n;
const home = ed25519.getPublicKey(ed25519.utils.randomPrivateKey()); // the owner's wallet: recovery always pays here
const policy = conservativePolicy(); // $200/day, 1% slippage, sessions up to ~24h
const pocket = derivePocket(appUserId, home, policy);
console.log(`pocket                   ${toBase58(pocket.address)}  (holds the bot's budget)`);
console.log(`policy hash              ${bytesToHex(policyHash(policy)).slice(0, 16)}...  (bound into every intent)\n`);

// 3. Bot side: sign one exact swap. Sell at most 25 USDC for at least 0.1 SOL before slot 1,000,000.
const signed = await signIntent(pocket, bot, {
  nonce: 0n,
  inMint: USDC,
  inMax: 25_000_000n,
  outMint: WSOL,
  outMin: 100_000_000n,
  deadlineSlot: 1_000_000n,
});

const verifies = (hash: Uint8Array) => ed25519.verify(signed.signature.signature, hash, shared.key32);
const checks: [string, boolean][] = [
  ["signature verifies over the canonical intent hash", verifies(intentHash(signed.intent))],
  ["raising the spend limit invalidates it", !verifies(intentHash({ ...signed.intent, inMax: 10_000_000_000n }))],
  ["lowering the minimum output invalidates it", !verifies(intentHash({ ...signed.intent, outMin: 1n }))],
  [
    "a different policy than the owner approved invalidates it",
    !verifies(intentHash({ ...signed.intent, policyHash: policyHash({ ...policy, dailyCapUsdE6: 10n ** 12n }) })),
  ],
];

let failures = 0;
for (const [label, ok] of checks) {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
}
console.log(
  failures === 0
    ? "\nOn-chain, the Pocket program also enforces the nonce window, deadline, oracle prices, the daily cap and the delivered output."
    : `\n${failures} check(s) failed.`,
);
process.exitCode = failures === 0 ? 0 : 1;
