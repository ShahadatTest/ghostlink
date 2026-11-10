/**
 * The identity handoff, both sides, in a simulated browser. `Browser` below
 * models what matters about window.postMessage: a message reaches a window
 * only when `targetOrigin` is "*" or equals the origin that window shows
 * now, and the receiver sees the sender's real origin and window object as
 * `event.origin` and `event.source`, whatever the payload says.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import {
  IncrementalTree, bytesToHex, conservativePolicy, domainHash, hexToBytes, loginChallengeDigest, registryLeaf, toBase58,
} from "@ghostlink/common";
import {
  GhostLink, HANDOFF_PROTOCOL, HandoffError, buildLoginInput, handoffOrigin, listenForHandoffRequest, parseHandoffSignIn,
  requestLogin, sessionPublicKey, softwareSession, appIdToBase58,
  type DerivedIdentity, type HandoffLoginRequest, type HandoffMessageEvent, type HandoffPopup, type LoginWitnessData,
  type Prover, type SessionPublicKey,
} from "../src/index.js";
import { verifyLoginChallenge } from "../../verify/src/index.js";

const vectors = JSON.parse(readFileSync(new URL("../../common/fixtures/vectors.json", import.meta.url), "utf8"));
const SITE = "https://shop.example";
const ID = "https://id.example";
const EVIL = "https://evil.example";

// ---- a small browser -------------------------------------------------------

type Listener = (event: HandoffMessageEvent) => void;
type Proxy = HandoffPopup & { postMessage(message: unknown, targetOrigin: string): void };

class Win {
  listeners = new Set<Listener>();
  opener: Win | null = null;
  closed = false;
  /** Every message delivered to this window. */
  inbox: HandoffMessageEvent[] = [];
  /** Every postMessage call made to this window, delivered or not, with its target. */
  calls: { message: unknown; targetOrigin: string }[] = [];
  opens: { url: string; target: string; features: string }[] = [];
  blockPopups = false;
  onOpen?: (popup: Win, url: string) => void;
  #proxies = new Map<Win, Proxy>();
  constructor(public origin: string) {}
  get location() { return { origin: this.origin }; }
  addEventListener(_type: "message", listener: Listener) { this.listeners.add(listener); }
  removeEventListener(_type: "message", listener: Listener) { this.listeners.delete(listener); }
  /**
   * This window as a script running in `viewer` holds it (a WindowProxy): one
   * stable object per viewer. Posting through it delivers to this window with
   * `source` = the viewer's own proxy as this window sees it.
   */
  proxyFor(viewer: Win): Proxy {
    let proxy = this.#proxies.get(viewer);
    if (!proxy) {
      const target = this;
      proxy = {
        get closed() { return target.closed; },
        postMessage: (message: unknown, targetOrigin: string) => target.postFrom(viewer, message, targetOrigin),
        close: () => { target.closed = true; },
      };
      this.#proxies.set(viewer, proxy);
    }
    return proxy;
  }
  /** Delivers like a browser: only to the target origin it shows now, with the sender's real origin and window. */
  postFrom(sender: Win, message: unknown, targetOrigin: string) {
    this.calls.push({ message, targetOrigin });
    if (this.closed || (targetOrigin !== "*" && targetOrigin !== this.origin)) return;
    const event = { data: structuredClone(message), origin: sender.origin, source: sender.proxyFor(this) };
    this.inbox.push(event);
    for (const l of [...this.listeners]) l(event);
  }
  open(url: string, target: string, features: string) {
    this.opens.push({ url, target, features });
    if (this.blockPopups) return null;
    const popup = new Win(new URL(url).origin);
    popup.opener = this;
    this.onOpen?.(popup, url);
    return popup.proxyFor(this);
  }
}

/** The identity app's view of its own window: `opener` is the site's window as the popup holds it. */
function identityView(popup: Win) {
  return {
    get location() { return { origin: popup.origin }; },
    get opener() { return popup.opener ? popup.opener.proxyFor(popup) : null; },
    addEventListener: (t: "message", l: Listener) => popup.addEventListener(t, l),
    removeEventListener: (t: "message", l: Listener) => popup.removeEventListener(t, l),
  };
}

// ---- proofs ----------------------------------------------------------------

const identity: DerivedIdentity = {
  secret: hexToBytes(vectors.identity.sBytes), sField: BigInt(vectors.identity.sField), commitment: BigInt(vectors.identity.commitment),
  deterministic: true, method: "signMessage", withFactor: false,
};
const wallet = hexToBytes(vectors.identity.walletPubkey);
const tree = new IncrementalTree();
tree.append(registryLeaf(wallet, identity.commitment));
const witness: LoginWitnessData = { registry: { walletPubkey: wallet, index: 0, siblings: tree.path(0).siblings, root: tree.root } };

const SIGNALS = ["registry_root", "census_root", "domain_hash", "app_id", "mint_hi", "mint_lo", "threshold", "min_slot",
  "session_commitment", "home_hash", "claim_holdings", "authorization_context"];
const PROOF = { pi_a: ["1", "2", "1"], pi_b: [["1", "2"], ["3", "4"], ["1", "0"]], pi_c: ["5", "6", "1"], protocol: "groth16", curve: "bn128" };
/** Stands in for snarkjs: the signals a real proof of this input would publish. */
const echoProver: Prover = { prove: async (_circuit, input) => ({ proof: PROOF, publicSignals: SIGNALS.map((n) => String(input[n])) }) };

/** What a correct identity app produces for `origin`, through the real SDK path (forOrigin + authorizeLogin). */
async function loginFor(origin: string, session: SessionPublicKey, expirySlot = 1_000n, home = new Uint8Array(32)) {
  const { input } = buildLoginInput({ identity, origin, session, expirySlot, home, witness });
  return { proof: { snarkjsProof: PROOF, publicSignals: SIGNALS.map((n) => String(input[n])) }, expirySlot };
}

// ---- harness ---------------------------------------------------------------

function setup(options: { approve?: boolean } = {}) {
  const site = new Win(SITE);
  let popup: Win | undefined;
  let request: HandoffLoginRequest | undefined;
  site.onOpen = (p) => {
    popup = p;
    // The identity app loads after the opener's click handler returns.
    queueMicrotask(() => {
      listenForHandoffRequest({ window: identityView(p), onRequest: (r) => {
        request = r;
        if (options.approve) void loginFor(r.origin, r.session).then((a) => r.approve(a));
      } });
    });
  };
  return { site, get popup() { return popup!; }, get request() { return request; } };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

// ---- origins -----------------------------------------------------------------

describe("handoffOrigin", () => {
  it("accepts exact https origins and loopback http, nothing else", () => {
    for (const ok of ["https://a.example", "https://a.example:8443", "http://localhost:3000", "http://127.0.0.1:3001", "http://[::1]:3000", "http://app.localhost:3000"]) {
      expect(handoffOrigin(ok)).toBe(ok);
    }
    for (const bad of ["null", "", "https://a.example/", "https://a.example/handoff", "https://user@a.example", "http://a.example",
      "javascript:alert(1)", "file:///x", "HTTPS://A.EXAMPLE", "https://a.example?x", "ws://localhost:3000", 42, undefined]) {
      expect(handoffOrigin(bad)).toBeNull();
    }
  });
});

// ---- site side -----------------------------------------------------------------

describe("requestLogin (site)", () => {
  it("opens the popup synchronously, without noopener, and sends only public values to exactly the identity origin", async () => {
    const h = setup({ approve: true });
    const session = softwareSession();
    const pending = requestLogin({ identityOrigin: ID, window: h.site, session, sessionSlots: 500n });
    // Opened before the first await, so a click handler's user gesture still counts.
    expect(h.site.opens).toHaveLength(1);
    const { url, target, features } = h.site.opens[0]!;
    expect(url).toBe(`${ID}/handoff`);
    expect(target).toMatch(/^ghostlink-handoff-[0-9a-f]{16}$/);
    expect(features).not.toMatch(/noopener|noreferrer/);
    const login = await pending;
    const sent = h.popup.calls.filter((c) => (c.message as { type?: string }).type === "login-request");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.targetOrigin).toBe(ID);
    const request = sent[0]!.message as Record<string, unknown>;
    expect(Object.keys(request).sort()).toEqual(["id", "protocol", "request", "type", "version"]);
    expect(request.request).toEqual({ sessionKeyHex: bytesToHex(session.key32), sessionSlots: "500" });
    expect(login).toMatchObject({ identityOrigin: ID, origin: SITE, expirySlot: 1_000n, claim: null, session });
    expect(login.publicSignals[2]).toBe(domainHash(SITE).toString());
    expect(h.popup.closed).toBe(true);
    expect(h.site.listeners.size).toBe(0);
  });

  it("returns a body the backend can decode and check with verifyLoginChallenge", async () => {
    const h = setup({ approve: true });
    const login = await requestLogin({ identityOrigin: ID, window: h.site });
    const nonce = new Uint8Array(32).fill(9);
    const wire = JSON.parse(JSON.stringify(await login.signChallenge(nonce)));
    const parsed = parseHandoffSignIn(wire)!;
    expect(parsed.expirySlot).toBe(1_000n);
    expect(parsed.publicSignals).toEqual(login.publicSignals);
    expect(verifyLoginChallenge({ key32: parsed.key32, nonce, signature: parsed.signature })).toBe(true);
    expect(verifyLoginChallenge({ key32: parsed.key32, nonce: new Uint8Array(32), signature: parsed.signature })).toBe(false);
    for (const broken of [null, [], { ...wire, key32Hex: "zz" }, { ...wire, signatureHex: "00" }, { ...wire, expirySlot: "-1" },
      { ...wire, publicSignals: wire.publicSignals.slice(1) }, { ...wire, proof: { ...wire.proof, protocol: "plonk" } }]) {
      expect(parseHandoffSignIn(broken)).toBeNull();
    }
    expect(appIdToBase58(login.appId)).toBe(toBase58(hexToBytes(BigInt(login.appId).toString(16).padStart(64, "0"))));
  });

  it("reports a blocked popup, and refuses bad options before opening anything", async () => {
    const site = new Win(SITE);
    site.blockPopups = true;
    await expect(requestLogin({ identityOrigin: ID, window: site })).rejects.toMatchObject({ code: "popup_blocked" });
    const fresh = new Win(SITE);
    for (const options of [
      { identityOrigin: `${ID}/` }, { identityOrigin: "http://id.example" }, { identityOrigin: SITE }, { identityOrigin: "null" },
      { identityOrigin: ID, path: "//evil.example/handoff" }, { identityOrigin: ID, path: "handoff" },
      { identityOrigin: ID, sessionSlots: 0n }, { identityOrigin: ID, sessionSlots: 216_001n },
      { identityOrigin: ID, claim: { mint: "not-a-mint", threshold: 1n, maxAgeSlots: 1n } },
      { identityOrigin: ID, claim: { mint: new Uint8Array(32), threshold: -1n, maxAgeSlots: 1n } },
      { identityOrigin: ID, session: { ...softwareSession(), kind: 1 as const } },
      { identityOrigin: ID, timeoutMs: 0 },
    ]) {
      await expect(requestLogin({ ...options, window: fresh } as never)).rejects.toMatchObject({ code: "invalid_request" });
    }
    await expect(requestLogin({ identityOrigin: ID, window: new Win("null") })).rejects.toMatchObject({ code: "invalid_request" });
    expect(fresh.opens).toHaveLength(0);
  });

  it("ignores spoofed, unsolicited, mismatched and malformed messages, then accepts the real answer once", async () => {
    const site = new Win(SITE);
    let popup!: Win;
    site.onOpen = (p) => { popup = p; };
    const session = softwareSession();
    let outcome: unknown = "pending";
    const pending = requestLogin({ identityOrigin: ID, window: site, session }).then((l) => { outcome = l; return l; },
      (e) => { outcome = e; throw e; });
    const other = new Win(ID); // same origin as the identity app, but not the popup this call opened
    const evil = new Win(EVIL);
    const ready = { protocol: HANDOFF_PROTOCOL, version: 1, type: "ready" };
    const good = await loginFor(SITE, sessionPublicKey(0, session.key32));
    const result = (id: string) => ({ protocol: HANDOFF_PROTOCOL, version: 1, type: "login-result", id,
      result: { proof: good.proof.snarkjsProof, publicSignals: good.proof.publicSignals, expirySlot: "1000" } });

    // An answer before any request was sent is unsolicited.
    site.postFrom(popup, result("00".repeat(32)), SITE);
    // A ready from another window, or from the popup under another origin, is not the identity app.
    site.postFrom(other, ready, "*");
    popup.origin = EVIL;
    site.postFrom(popup, ready, "*");
    popup.origin = ID;
    expect(popup.calls).toHaveLength(0);
    // Now the real one.
    site.postFrom(popup, ready, "*");
    const request = popup.inbox.at(-1)!.data as { id: string };
    expect(request).toMatchObject({ type: "login-request" });
    // Malformed, wrong id, wrong version, wrong window, wrong origin: all ignored.
    for (const junk of [null, "login-result", [], { type: "login-result" }, { ...result(request.id), protocol: "other" },
      result("11".repeat(32)), { ...result(request.id), version: 2 }]) {
      site.postFrom(popup, junk, SITE);
    }
    site.postFrom(other, result(request.id), SITE);
    site.postFrom(evil, result(request.id), SITE);
    await tick();
    expect(outcome).toBe("pending");
    // A refusal from another window cannot cancel the login either.
    site.postFrom(evil, { protocol: HANDOFF_PROTOCOL, version: 1, type: "login-refused", id: request.id }, SITE);
    site.postFrom(popup, result(request.id), SITE);
    const login = await pending;
    expect(login.appId).toBe(good.proof.publicSignals[3]);
    // Duplicates and late refusals change nothing; nobody is listening any more.
    site.postFrom(popup, result(request.id), SITE);
    site.postFrom(popup, { protocol: HANDOFF_PROTOCOL, version: 1, type: "login-refused", id: request.id }, SITE);
    expect(site.listeners.size).toBe(0);
    expect(outcome).toBe(login);
  });

  it("resends the same request when the popup reloads, a bounded number of times", async () => {
    const site = new Win(SITE);
    let popup!: Win;
    site.onOpen = (p) => { popup = p; };
    void requestLogin({ identityOrigin: ID, window: site, timeoutMs: 1_000 }).catch(() => undefined);
    for (let i = 0; i < 8; i++) site.postFrom(popup, { protocol: HANDOFF_PROTOCOL, version: 1, type: "ready" }, "*");
    const requests = popup.calls.map((c) => c.message as { id: string });
    expect(requests).toHaveLength(5);
    expect(new Set(requests.map((r) => r.id)).size).toBe(1);
  });

  it("turns a refusal, a failure, a closed window, a timeout, an abort and another version into distinct errors", async () => {
    const answer = async (respond: (r: HandoffLoginRequest) => void) => {
      const site = new Win(SITE);
      site.onOpen = (p) => queueMicrotask(() => listenForHandoffRequest({ window: identityView(p), onRequest: respond }));
      return requestLogin({ identityOrigin: ID, window: site });
    };
    await expect(answer((r) => r.refuse())).rejects.toMatchObject({ code: "refused" });
    const failure = await answer((r) => r.fail("not_registered", "This wallet has no identity yet.")).catch((e: HandoffError) => e);
    expect(failure).toBeInstanceOf(HandoffError);
    expect(failure).toMatchObject({ code: "failed", identityCode: "not_registered", message: "This wallet has no identity yet." });

    vi.useFakeTimers();
    const closing = setup();
    const closed = requestLogin({ identityOrigin: ID, window: closing.site }).catch((e: HandoffError) => e.code);
    closing.popup.closed = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await closed).toBe("closed");

    const slow = setup();
    const timedOut = requestLogin({ identityOrigin: ID, window: slow.site, timeoutMs: 5_000 }).catch((e: HandoffError) => e.code);
    await vi.advanceTimersByTimeAsync(5_001);
    expect(await timedOut).toBe("timeout");
    expect(slow.popup.closed).toBe(true);
    // A late answer to the timed-out request goes nowhere: nobody listens and the window is closed.
    expect(slow.site.listeners.size).toBe(0);

    const controller = new AbortController();
    const cancelled = setup();
    const aborted = requestLogin({ identityOrigin: ID, window: cancelled.site, signal: controller.signal }).catch((e: HandoffError) => e.code);
    controller.abort();
    expect(await aborted).toBe("aborted");
    vi.useRealTimers();

    const site = new Win(SITE);
    let popup!: Win;
    site.onOpen = (p) => { popup = p; };
    const newer = requestLogin({ identityOrigin: ID, window: site }).catch((e: HandoffError) => e.code);
    site.postFrom(popup, { protocol: HANDOFF_PROTOCOL, version: 2, type: "ready" }, "*");
    expect(await newer).toBe("unsupported_version");
  });

  it("refuses a correlated answer whose proof is for another site, key, purpose or claim", async () => {
    const mint = new Uint8Array(32).fill(5);
    const cases: [string, (r: HandoffLoginRequest) => Promise<{ proof: { snarkjsProof: object; publicSignals: string[] }; expirySlot: bigint }>, object?][] = [
      ["another origin", (r) => loginFor(EVIL, r.session)],
      ["another session key", (r) => loginFor(r.origin, sessionPublicKey(0, softwareSession().key32))],
      ["a bound home", (r) => loginFor(r.origin, r.session, 1_000n, wallet)],
      ["a pocket authorization", async (r) => {
        const { input } = buildLoginInput({ identity, origin: r.origin, session: r.session, expirySlot: 1_000n, home: new Uint8Array(32), witness, policy: conservativePolicy() });
        return { proof: { snarkjsProof: PROOF, publicSignals: SIGNALS.map((n) => String(input[n])) }, expirySlot: 1_000n };
      }],
      ["a missing claim", (r) => loginFor(r.origin, r.session), { mint, threshold: 1n, maxAgeSlots: 10n }],
    ];
    for (const [, prove] of cases.slice(0, 4)) {
      const site = new Win(SITE);
      site.onOpen = (p) => queueMicrotask(() => listenForHandoffRequest({ window: identityView(p), onRequest: (r) => {
        // A broken identity app that skips the SDK's own check and posts straight to the opener.
        void prove(r).then((a) => identityView(p).opener!.postMessage({ protocol: HANDOFF_PROTOCOL, version: 1, type: "login-result", id: r.id,
          result: { proof: a.proof.snarkjsProof, publicSignals: a.proof.publicSignals, expirySlot: a.expirySlot.toString() } }, SITE));
      } }));
      await expect(requestLogin({ identityOrigin: ID, window: site })).rejects.toMatchObject({ code: "invalid_response" });
    }
    const [, prove, claim] = cases[4]!;
    const site = new Win(SITE);
    site.onOpen = (p) => queueMicrotask(() => listenForHandoffRequest({ window: identityView(p), onRequest: (r) => {
      void prove(r).then((a) => identityView(p).opener!.postMessage({ protocol: HANDOFF_PROTOCOL, version: 1, type: "login-result", id: r.id,
        result: { proof: a.proof.snarkjsProof, publicSignals: a.proof.publicSignals, expirySlot: "1000" } }, SITE));
    } }));
    await expect(requestLogin({ identityOrigin: ID, window: site, claim: claim as never })).rejects.toMatchObject({ code: "invalid_response" });
  });
});

// ---- identity app side -------------------------------------------------------

describe("listenForHandoffRequest (identity app)", () => {
  const request = (overrides: Record<string, unknown> = {}, body: Record<string, unknown> = {}) => ({
    protocol: HANDOFF_PROTOCOL, version: 1, type: "login-request", id: "ab".repeat(32),
    request: { sessionKeyHex: bytesToHex(softwareSession().key32), sessionSlots: "9000", ...body }, ...overrides,
  });
  function identityApp() {
    const site = new Win(SITE);
    const popup = new Win(ID);
    popup.opener = site;
    const received: HandoffLoginRequest[] = [];
    const responder = listenForHandoffRequest({ window: identityView(popup), onRequest: (r) => received.push(r) });
    return { site, popup, received, responder };
  }

  it("does nothing without an opener, and otherwise announces itself with an empty ready message", () => {
    const lone = new Win(ID);
    const onRequest = vi.fn();
    expect(listenForHandoffRequest({ window: identityView(lone), onRequest }).opened).toBe(false);
    expect(lone.listeners.size).toBe(0);
    const { site, responder } = identityApp();
    expect(responder.opened).toBe(true);
    expect(site.calls).toEqual([{ message: { protocol: HANDOFF_PROTOCOL, version: 1, type: "ready" }, targetOrigin: "*" }]);
  });

  it("takes the origin from the browser, never from the payload", () => {
    const { site, popup, received } = identityApp();
    // A request claiming to come from another site, in every field a payload could use.
    popup.postFrom(site, { ...request({ origin: "https://bank.example" }, { origin: "https://bank.example", returnTo: "https://bank.example" }) }, ID);
    expect(received).toHaveLength(1);
    expect(received[0]!.origin).toBe(SITE);
  });

  it("ignores requests from other windows, frames, opaque or insecure origins, its own origin, and malformed ones", () => {
    const { site, popup, received } = identityApp();
    const stranger = new Win(SITE); // same origin as the opener, different window (another tab, a frame)
    popup.postFrom(stranger, request(), ID);
    for (const origin of ["null", "http://shop.example", ID]) {
      const sender = Object.assign(site, { origin });
      popup.postFrom(sender, request(), ID);
    }
    site.origin = SITE;
    const smallOrder = "01" + "00".repeat(31);
    for (const junk of [
      null, "x", request({ version: 2 }), request({ protocol: "x" }), request({ type: "login-result" }), request({ id: "short" }),
      request({}, { sessionKeyHex: "zz" }), request({}, { sessionKeyHex: smallOrder }), request({}, { sessionSlots: "0" }),
      request({}, { sessionSlots: "216001" }), request({}, { sessionSlots: "01" }), request({}, { claim: { mint: "x", threshold: "1", maxAgeSlots: "1" } }),
      request({}, { claim: { mint: toBase58(new Uint8Array(32).fill(3)), threshold: "-1", maxAgeSlots: "1" } }),
      request({ request: null }),
    ]) {
      popup.postFrom(site, junk, ID);
    }
    expect(received).toHaveLength(0);
    popup.postFrom(site, request({}, { claim: { mint: toBase58(new Uint8Array(32).fill(3)), threshold: "100", maxAgeSlots: "9000" } }), ID);
    expect(received).toHaveLength(1);
    expect(received[0]!.claim).toEqual({ kind: "holdsAtLeast", mint: new Uint8Array(32).fill(3), threshold: 100n, maxAgeSlots: 9000n });
  });

  it("accepts one request per page: a replayed or second request is ignored", () => {
    const { site, popup, received } = identityApp();
    popup.postFrom(site, request(), ID);
    popup.postFrom(site, request(), ID);
    popup.postFrom(site, request({ id: "cd".repeat(32) }), ID);
    expect(received).toHaveLength(1);
    expect(popup.listeners.size).toBe(0);
  });

  it("answers only the requesting origin, only once, and only with a proof for that origin and key", async () => {
    const { site, popup, received } = identityApp();
    popup.postFrom(site, request(), ID);
    const r = received[0]!;
    expect(() => r.approve({ proof: { snarkjsProof: PROOF, publicSignals: [] }, expirySlot: 1n })).toThrow(/12 public signals/);
    await expect(loginFor(EVIL, r.session).then((a) => r.approve(a))).rejects.toThrow(/another origin/);
    await expect(loginFor(r.origin, sessionPublicKey(0, softwareSession().key32)).then((a) => r.approve(a))).rejects.toThrow(/session key/);
    expect(site.calls).toHaveLength(1); // only "ready" so far
    r.approve(await loginFor(r.origin, r.session));
    const answer = site.calls.at(-1)!;
    expect(answer.targetOrigin).toBe(SITE);
    expect(answer.message).toMatchObject({ type: "login-result", id: r.id, result: { expirySlot: "1000" } });
    expect(r.open).toBe(false);
    await expect(loginFor(r.origin, r.session).then((a) => r.approve(a))).rejects.toThrow(/already answered/);
    r.refuse();
    r.fail("internal", "x");
    expect(site.calls).toHaveLength(2);
  });

  it("is dropped by the browser when the opener has navigated to another site", async () => {
    const { site, popup, received } = identityApp();
    popup.postFrom(site, request(), ID);
    site.origin = EVIL; // the opener tab now shows another site
    received[0]!.approve(await loginFor(SITE, received[0]!.session));
    expect(site.calls.at(-1)!.targetOrigin).toBe(SITE);
    expect(site.inbox.filter((e) => (e.data as { type?: string }).type === "login-result")).toHaveLength(0);
  });

  it("sanitizes failure codes and messages", () => {
    const { site, popup, received } = identityApp();
    popup.postFrom(site, request(), ID);
    received[0]!.fail("Bad Code!", "x".repeat(1000));
    expect(site.calls.at(-1)!.message).toMatchObject({ type: "login-error", code: "internal" });
    expect((site.calls.at(-1)!.message as { message: string }).message).toHaveLength(300);
  });
});

// ---- the client methods an identity app uses -----------------------------------

describe("GhostLink.forOrigin and authorizeLogin", () => {
  it("proves for the browser-reported origin, binds the site's public key and the zero home, and nothing else", async () => {
    vi.stubGlobal("window", { location: { origin: ID } });
    const client = await GhostLink.init({ cluster: "localnet", indexer: "https://indexer.invalid", prover: echoProver });
    expect(client.origin()).toBe(ID);
    for (const bad of ["https://shop.example/", "null", "http://shop.example", "shop.example"]) expect(() => client.forOrigin(bad)).toThrow(/exact origin/);
    const forSite = client.forOrigin(SITE);
    expect(forSite.origin()).toBe(SITE);
    expect(client.origin()).toBe(ID);
    const site = softwareSession();
    const key = sessionPublicKey(0, site.key32);
    const authorization = await forSite.authorizeLogin({ identity, witness, session: key, expirySlot: 2_000n });
    const { input } = buildLoginInput({ identity, origin: SITE, session: key, expirySlot: 2_000n, home: new Uint8Array(32), witness });
    expect(authorization.proof.publicSignals).toEqual(SIGNALS.map((n) => String(input[n])));
    expect(authorization.signer).toEqual(key);
    expect("sign" in authorization.signer).toBe(false);
    await expect(forSite.authorizeLogin({ identity, witness, session: { ...key, kind: 1 }, expirySlot: 2_000n })).rejects.toThrow(/Ed25519/);
    // It extends to the handoff: approve accepts exactly this.
    const app = new Win(ID);
    const opener = new Win(SITE);
    app.opener = opener;
    let received: HandoffLoginRequest | undefined;
    listenForHandoffRequest({ window: identityView(app), onRequest: (r) => { received = r; } });
    app.postFrom(opener, { protocol: HANDOFF_PROTOCOL, version: 1, type: "login-request", id: "ef".repeat(32),
      request: { sessionKeyHex: bytesToHex(site.key32), sessionSlots: "100" } }, ID);
    received!.approve({ proof: authorization.proof, expirySlot: authorization.expirySlot });
    expect(opener.calls.at(-1)!.message).toMatchObject({ type: "login-result" });
  });

  it("verifies a real Groth16 proof made through the handoff, when circuit artifacts are present", async () => {
    const build = new URL("../../../circuits/build/", import.meta.url);
    const wasmPath = fileURLToPath(new URL("login_js/login.wasm", build)), zkeyPath = fileURLToPath(new URL("login_dev.zkey", build));
    if (!existsSync(wasmPath) || !existsSync(zkeyPath)) {
      console.log("circuits/build not present: skipped the real handoff proof (run scripts/build-circuits.sh to include it)");
      return;
    }
    const snarkjs = await import("snarkjs");
    const { verifyLogin } = await import("../../verify/src/index.js");
    const prover: Prover = { prove: async (_c, input) => snarkjs.groth16.fullProve(input as never, wasmPath, zkeyPath) as never };
    const client = await GhostLink.init({ cluster: "localnet", indexer: "https://indexer.invalid", origin: ID, prover });
    const h = setup();
    const pending = requestLogin({ identityOrigin: ID, window: h.site });
    await vi.waitFor(() => expect(h.request).toBeDefined());
    const r = h.request!;
    const authorization = await client.forOrigin(r.origin).authorizeLogin({ identity, witness, session: r.session, expirySlot: 5_000n });
    r.approve({ proof: authorization.proof, expirySlot: authorization.expirySlot });
    const login = await pending;
    const nonce = new Uint8Array(32).fill(4);
    const body = parseHandoffSignIn(JSON.parse(JSON.stringify(await login.signChallenge(nonce))))!;
    const result = await verifyLogin({ proof: body.proof, publicSignals: body.publicSignals, expectedDomain: SITE,
      roots: async () => ({ registry: [tree.root.toString()], census: [] }),
      expect: { session: { key32: body.key32, expirySlot: body.expirySlot, currentSlot: 4_000n } } });
    expect(result).toEqual({ ok: true, appId: login.appId });
    expect(await verifyLogin({ proof: body.proof, publicSignals: body.publicSignals, expectedDomain: EVIL,
      roots: async () => ({ registry: [tree.root.toString()], census: [] }) })).toMatchObject({ ok: false, code: "wrong_domain" });
    expect(verifyLoginChallenge({ key32: body.key32, nonce, signature: body.signature })).toBe(true);
    // The site learned nothing it could use elsewhere: no secret, no wallet, no witness.
    const everything = JSON.stringify([h.popup.calls, h.site.calls, h.site.inbox.map((e) => e.data)]);
    for (const secret of [vectors.identity.sBytes, vectors.identity.sField, vectors.identity.walletPubkey, vectors.identity.walletBase58,
      identity.commitment.toString(), bytesToHex(identity.secret)]) {
      expect(everything).not.toContain(secret);
    }
    expect(ed25519.verify(body.signature, loginChallengeDigest(nonce), body.key32)).toBe(true);
  }, 120_000);
});
