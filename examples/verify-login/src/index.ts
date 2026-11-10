/**
 * Verify a real GhostLink zero-knowledge login proof, the way a website backend would.
 *
 * The proof was produced by the login circuit for a test identity and is committed at
 * circuits/keys/login_offchain_proof.json. It proves that its owner is registered and held at
 * least 100 tokens of a given mint in a census snapshot taken at or after its public min_slot.
 * The wallet address is not in it.
 *
 * Run it:  pnpm --filter @ghostlink/example-verify-login start
 */
import { readFileSync } from "node:fs";
import { holdingsClaim, verifyLogin, type VerifyLoginErrorCode, type VerifyLoginParams } from "@ghostlink/verify";

const repo = new URL("../../../", import.meta.url);
const readJson = (path: string) => JSON.parse(readFileSync(new URL(path, repo), "utf8"));

const fixture = readJson("circuits/keys/login_offchain_proof.json");
const vectors = readJson("packages/common/fixtures/vectors.json");
const signals = vectors.circuits.login.public;

// Production code reads the recent roots from the on-chain tree accounts or a trusted indexer.
// Never take them from the client: a proof against a tree nobody recognises proves nothing.
const trustedRoots = async () => ({ registry: [signals.registry_root], census: [signals.census_root] });

// The census only grows, so an old snapshot (a past peak, a briefly borrowed balance) stays
// provable forever. The site decides how old a snapshot it accepts. Production code reads
// currentSlot from its own RPC; here the chain is pretended to be an hour past the proof's bound.
const maxAgeSlots = 9_000n; // about an hour of Solana slots
const currentSlot = BigInt(signals.min_slot) + maxAgeSlots;
// The token gate: at least 100 tokens (6 decimals) of the fixture mint.
const holdsAtLeast = holdingsClaim(Buffer.from(vectors.census.mint, "hex"), 100_000_000n);

const login: VerifyLoginParams = {
  proof: fixture.proof,
  publicSignals: fixture.publicSignals,
  expectedDomain: "https://app.example.com",
  roots: trustedRoots,
  expect: { holdsAtLeast, minSlot: currentSlot - maxAgeSlots },
};
// A real backend also binds the proof to the client's session key (expect.session) and checks
// that key's signature over a single-use nonce with verifyLoginChallenge: see packages/verify.

const tampered = [...login.publicSignals];
tampered[3] = "1"; // app_id: try to log in as a different user

// `reject` is the code each bad login must fail with, so a case cannot pass by failing for
// some other reason. Servers branch on the code; the reason is for people.
const cases: { label: string; request: VerifyLoginParams; reject?: VerifyLoginErrorCode }[] = [
  { label: "valid proof for this site", request: login },
  {
    label: "replayed on another site",
    request: { ...login, expectedDomain: "https://evil.example.com" },
    reject: "wrong_domain",
  },
  {
    label: "site demands 200 tokens, proof shows 100",
    request: { ...login, expect: { ...login.expect, holdsAtLeast: { ...holdsAtLeast, threshold: 200_000_000n } } },
    reject: "threshold_too_low",
  },
  {
    label: "same proof a day later: snapshot too old",
    request: { ...login, expect: { ...login.expect, minSlot: currentSlot + 216_000n - maxAgeSlots } },
    reject: "snapshot_too_old",
  },
  {
    label: "built against an unknown tree",
    request: { ...login, roots: async () => ({ registry: ["42"], census: [signals.census_root] }) },
    reject: "unknown_root",
  },
  { label: "tampered public signal", request: { ...login, publicSignals: tampered }, reject: "invalid_proof" },
];

console.log("GhostLink login verification: a real Groth16 proof with no wallet address inside\n");
let failures = 0;
for (const { label, request, reject } of cases) {
  const result = await verifyLogin(request);
  const asExpected = reject === undefined ? result.ok : !result.ok && result.code === reject;
  if (!asExpected) failures++;
  const outcome = result.ok
    ? `accepted, app user ID ${result.appId!.slice(0, 6)}...${result.appId!.slice(-4)}`
    : `rejected: ${result.reason}`;
  console.log(`${asExpected ? "ok  " : "FAIL"}  ${label.padEnd(42)} ${outcome}`);
}
console.log(
  failures === 0
    ? "\nThe app user ID is stable for this site and unlinkable across sites. The proof is bound to its domain."
    : `\n${failures} case(s) did not behave as expected.`,
);
// snarkjs keeps its curve worker threads alive, so exit explicitly.
process.exit(failures === 0 ? 0 : 1);
