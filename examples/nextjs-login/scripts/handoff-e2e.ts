/**
 * The whole "Continue with GhostLink" journey against a local validator,
 * without a browser: the identity app's request handler and approval code
 * (examples/identity-app/lib) and this site's route handlers (app/api),
 * joined by the SDK's real handoff code over a simulated pair of windows.
 *
 *   1. A fresh wallet derives an identity, registers it and snapshots its SOL.
 *   2. The site calls requestLogin; the identity app receives the request with
 *      the site's origin taken from the (simulated) browser, proves on this
 *      machine with the real circuit, and answers.
 *   3. The site's nonce and verify routes accept the sign-in, with a token gate.
 *   4. Replays, other sites and refusals fail as they should.
 *   5. The identity app's owner actions work on a pocket at the site's origin:
 *      look up, revoke, sweep.
 *
 * Needs the local stack: GHOSTLINK_KEEP_RUNNING=1 bash scripts/localnet-e2e.sh
 * (docs/SETUP.md) and circuits/build. Run: pnpm --filter @ghostlink/example-nextjs-login e2e
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ed25519 } from "@noble/curves/ed25519";
import { bytesToHex, conservativePolicy, hexToBytes, toBase58 } from "@ghostlink/common";
import {
  GhostLink, HandoffError, deriveIdentity, jsonRpcChainReader, listenForHandoffRequest, requestLogin, sessionPublicKey, softwareSession,
  type HandoffLoginRequest, type HandoffMessageEvent, type HandoffPopup,
} from "@ghostlink/sdk";
import { createProver } from "@ghostlink/prover-wasm";
import { NATIVE_MINT, approveLogin } from "../../identity-app/lib/approve";
import { lookupPocket, revokePocket, sweepPocket } from "../../identity-app/lib/owner";
import { POST as nonceRoute } from "../app/api/ghostlink/nonce/route";
import { POST as verifyRoute } from "../app/api/ghostlink/verify/route";
import { sessionCookieId, store } from "../lib/store";

const RPC = process.env.GHOSTLINK_RPC_URL ?? "http://127.0.0.1:8899";
const INDEXER = process.env.GHOSTLINK_INDEXER_URL ?? "http://127.0.0.1:8787";
const RELAYER = process.env.GHOSTLINK_RELAYER_URL ?? "http://127.0.0.1:8788";
const SITE = "http://localhost:3000";
const OTHER_SITE = "http://localhost:3002";
const ID = "http://localhost:3001";
const SOL = 1_000_000_000n;

const ok = (step: string) => console.log(`ok - ${step}`);
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

// ---- two windows, as a browser connects them -------------------------------------
// A message reaches a window only when targetOrigin is "*" or that window's
// current origin; the receiver sees the sender's real origin and window.

type Listener = (event: HandoffMessageEvent) => void;
class Win {
  listeners = new Set<Listener>();
  opener: Win | null = null;
  closed = false;
  onOpen?: (popup: Win) => void;
  /** Every message delivered to this window, when set. */
  log?: unknown[];
  #proxies = new Map<Win, HandoffPopup>();
  constructor(public origin: string) {}
  get location() { return { origin: this.origin }; }
  addEventListener(_: "message", l: Listener) { this.listeners.add(l); }
  removeEventListener(_: "message", l: Listener) { this.listeners.delete(l); }
  proxyFor(viewer: Win): HandoffPopup {
    let proxy = this.#proxies.get(viewer);
    if (!proxy) {
      const target = this;
      proxy = { get closed() { return target.closed; }, close: () => { target.closed = true; },
        postMessage: (message: unknown, targetOrigin: string) => target.deliver(viewer, message, targetOrigin) };
      this.#proxies.set(viewer, proxy);
    }
    return proxy;
  }
  deliver(sender: Win, message: unknown, targetOrigin: string) {
    if (this.closed || (targetOrigin !== "*" && targetOrigin !== this.origin)) return;
    const event = { data: structuredClone(message), origin: sender.origin, source: sender.proxyFor(this) };
    this.log?.push(event.data);
    setTimeout(() => { for (const l of [...this.listeners]) l(event); }, 0);
  }
  open(url: string) {
    const popup = new Win(new URL(url).origin);
    popup.opener = this;
    setTimeout(() => this.onOpen?.(popup), 0);
    return popup.proxyFor(this);
  }
}
const identityWindow = (popup: Win) => ({
  get location() { return { origin: popup.origin }; },
  get opener() { return popup.opener ? popup.opener.proxyFor(popup) : null; },
  addEventListener: (t: "message", l: Listener) => popup.addEventListener(t, l),
  removeEventListener: (t: "message", l: Listener) => popup.removeEventListener(t, l),
});

// ---- chain helpers --------------------------------------------------------------

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const response = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = await response.json() as { result?: T; error?: { message?: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}
async function airdrop(address: string, lamports: bigint) {
  const signature = await rpc<string>("requestAirdrop", [address, Number(lamports)]);
  for (let i = 0; i < 60; i++) {
    const { value } = await rpc<{ value: ({ confirmationStatus?: string } | null)[] }>("getSignatureStatuses", [[signature]]);
    if (["confirmed", "finalized"].includes(value[0]?.confirmationStatus ?? "")) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("airdrop did not confirm");
}
const balance = async (address: string) => BigInt((await rpc<{ value: number }>("getBalance", [address, { commitment: "confirmed" }])).value);

async function main() {
  for (const url of [RPC, INDEXER, RELAYER]) {
    if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)) throw new Error(`${url} is not a local service: this check runs on a local validator only`);
  }
  const build = new URL("../../../circuits/build/", import.meta.url);
  const file = (name: string) => fileURLToPath(new URL(name, build));
  for (const name of ["login_js/login.wasm", "login_dev.zkey", "owner_js/owner.wasm", "owner_dev.zkey"]) {
    if (!existsSync(file(name))) throw new Error(`missing circuits/build/${name}: build the circuits first (docs/SETUP.md)`);
  }
  // The same prover the identity app runs in its worker, here on this thread, reading local files.
  const prover = createProver({
    login: { wasmUrl: "file:login.wasm", zkeyUrl: "file:login.zkey" },
    owner: { wasmUrl: "file:owner.wasm", zkeyUrl: "file:owner.zkey" },
    fetchFn: async (input) => {
      const paths: Record<string, string> = { "file:login.wasm": "login_js/login.wasm", "file:login.zkey": "login_dev.zkey",
        "file:owner.wasm": "owner_js/owner.wasm", "file:owner.zkey": "owner_dev.zkey" };
      return new Response(await readFile(file(paths[String(input)]!)));
    },
  });
  const client = await GhostLink.init({ cluster: "localnet", indexer: INDEXER, relayer: RELAYER, chain: jsonRpcChainReader(RPC), origin: ID, prover });
  await client.currentSlot(); // also checks the validator's genesis against the deployment
  ok("local stack reachable");

  // ---- 1. identity -------------------------------------------------------------
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const wallet = ed25519.getPublicKey(seed);
  const signMessage = async (message: Uint8Array) => ed25519.sign(message, seed);
  await airdrop(toBase58(wallet), 3n * SOL);
  const identity = await deriveIdentity(signMessage, { cluster: "localnet", domain: new URL(ID).host, address: toBase58(wallet) });
  await client.register({ identity, wallet, signMessage });
  await client.snapshot({ wallet, holding: wallet });
  ok(`registered a fresh wallet and snapshotted its SOL (${toBase58(wallet).slice(0, 8)}…)`);

  // ---- 2. the handoff -----------------------------------------------------------
  Object.assign(process.env, { SITE_ORIGIN: SITE, IDENTITY_ORIGIN: ID, GHOSTLINK_INDEXER_URL: INDEXER, GHOSTLINK_RPC_URL: RPC,
    LOGIN_SESSION_SLOTS: "9000", GATE_MINT: NATIVE_MINT, GATE_THRESHOLD: SOL.toString(), GATE_MAX_AGE_SLOTS: "9000" });
  const claim = { mint: NATIVE_MINT, threshold: SOL, maxAgeSlots: 9_000n };
  const sent: unknown[] = [];
  async function signInAt(siteOrigin: string, answer: (r: HandoffLoginRequest) => Promise<void>) {
    const site = new Win(siteOrigin);
    site.log = sent; // everything the site's window receives
    site.onOpen = (popup) => {
      listenForHandoffRequest({ window: identityWindow(popup), onRequest: (r) => void answer(r).catch((e) => r.fail("internal", String(e))) });
    };
    return requestLogin({ identityOrigin: ID, window: site as never, claim, sessionSlots: 9_000n, timeoutMs: 600_000 });
  }
  let seenOrigin = "";
  const approve = async (r: HandoffLoginRequest) => {
    seenOrigin = r.origin;
    await approveLogin({ client, identity, wallet, request: r, maxSessionSlots: 9_000n, wait: { timeoutMs: 300_000 } });
  };
  const started = Date.now();
  const login = await signInAt(SITE, approve);
  check(seenOrigin === SITE, "the identity app saw the site's origin from the browser");
  check(login.claim?.threshold === SOL, "the proof makes the requested holdings claim");
  ok(`identity app proved for ${seenOrigin} and answered (${Math.round((Date.now() - started) / 1000)} s including the registration bucket)`);
  const leaked = JSON.stringify(sent);
  for (const secret of [bytesToHex(identity.secret), identity.sField.toString(), identity.commitment.toString(), toBase58(wallet), bytesToHex(wallet)]) {
    check(!leaked.includes(secret), "no identity secret, commitment or wallet address reached the site");
  }
  ok("the site received no identity secret, commitment or wallet address");

  // ---- 3. the site's routes -------------------------------------------------------
  const post = (route: (r: Request) => Promise<Response>, body: unknown, origin = SITE) =>
    route(new Request(`${SITE}/api`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) }));
  const { challengeId, nonce } = await (await post(nonceRoute, {})).json() as { challengeId: string; nonce: string };
  const body = { challengeId, ...await login.signChallenge(hexToBytes(nonce)) };
  const verified = await post(verifyRoute, body);
  const answer = await verified.json() as { appId?: string; code?: string };
  check(verified.status === 200 && answer.appId, `verify route accepted the sign-in (got ${verified.status} ${answer.code ?? ""})`);
  const session = store().session(sessionCookieId(verified.headers.get("set-cookie")));
  check(session?.appId === answer.appId, "the session cookie maps to the user's ID");
  const view = await lookupPocket(client, identity, SITE);
  check(view.appId === answer.appId, "the site's ID equals the identity app's own derivation for that origin");
  ok(`site verified the proof with its own RPC and indexer and signed the user in as ${answer.appId}`);

  // ---- 4. what must fail ---------------------------------------------------------
  const replay = await (await post(verifyRoute, body)).json() as { code?: string };
  check(replay.code === "unknown_challenge", "a replayed sign-in is refused");
  const other = await signInAt(OTHER_SITE, approve);
  check(other.appId !== login.appId, "another site gets a different ID");
  const second = await (await post(nonceRoute, {})).json() as { challengeId: string; nonce: string };
  const foreign = await (await post(verifyRoute, { challengeId: second.challengeId, ...await other.signChallenge(hexToBytes(second.nonce)) })).json() as { code?: string };
  check(foreign.code === "wrong_domain", `another site's proof is refused here (got ${foreign.code})`);
  const refusal = await signInAt(SITE, async (r) => r.refuse()).catch((e: unknown) => e);
  check(refusal instanceof HandoffError && refusal.code === "refused", "a refusal reaches the site as refused");
  const tooRich = await (async () => {
    const site = new Win(SITE);
    site.onOpen = (popup) => listenForHandoffRequest({ window: identityWindow(popup), onRequest: (r) =>
      void approveLogin({ client, identity, wallet, request: r, maxSessionSlots: 9_000n }).catch((e) => r.fail("claim_unmet", String(e))) });
    return requestLogin({ identityOrigin: ID, window: site as never, claim: { ...claim, threshold: 1_000n * SOL } }).catch((e: unknown) => e);
  })();
  check(tooRich instanceof HandoffError && tooRich.code === "failed" && tooRich.identityCode === "claim_unmet", "an unmet claim fails with the identity app's code");
  ok("replay, another site's proof, a refusal and an unmet claim all fail as expected");

  // ---- 5. owner actions at the site's origin ---------------------------------------
  const forSite = client.forOrigin(SITE);
  const witness = await client.witness({ identity, wallet });
  const home = ed25519.getPublicKey(crypto.getRandomValues(new Uint8Array(32)));
  const policy = conservativePolicy();
  const bot = softwareSession();
  const authorization = await forSite.authorizeSession({ identity, witness, session: sessionPublicKey(0, bot.key32), policy, home,
    expirySlot: (await client.currentSlot()) + 5_000n });
  await forSite.openSession(authorization, forSite.pocketFor(authorization, home, policy));
  const opened = await lookupPocket(client, identity, SITE);
  check(opened.state && opened.state.sessionExpirySlot > 0n, "a pocket with a live session exists at the site");
  await airdrop(opened.address, SOL / 2n);
  await revokePocket({ client, identity, wallet, origin: SITE });
  const revoked = await lookupPocket(client, identity, SITE);
  check(revoked.state?.sessionExpirySlot === 0n, "revoke ended the session");
  const homeBefore = await balance(toBase58(home));
  await sweepPocket({ client, identity, wallet, origin: SITE, mints: [] });
  const homeAfter = await balance(toBase58(home));
  check(homeAfter - homeBefore >= SOL / 2n - 10_000_000n, `sweep returned the pocket's SOL home (${homeAfter - homeBefore} lamports)`);
  ok(`owner actions for ${SITE} from the identity app: lookup, revoke, sweep (${homeAfter - homeBefore} lamports home)`);
  console.log("handoff end-to-end: all checks passed");
}

main().then(() => process.exit(0), (error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
