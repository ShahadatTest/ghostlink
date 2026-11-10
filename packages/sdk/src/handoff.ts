/**
 * Identity handoff: "Continue with GhostLink" on a site that never holds
 * the identity secret.
 *
 * A site opens a separate identity app (another origin, run by whoever
 * operates the deployment's identity origin) in a popup and asks it for a
 * login proof. The identity app learns who is asking only from the
 * browser, as `MessageEvent.origin` of a message sent by its own
 * `window.opener`; it shows that origin to the user, proves for exactly
 * that origin, and posts the answer to exactly that origin. The identity
 * secret, the wallet's signatures and the Merkle witnesses stay in the
 * identity app. The site receives a proof, its public signals and an
 * expiry, bound to a session key the site generated itself: the site keeps
 * the private half and signs its backend's single-use nonce with it.
 *
 * Protocol version 1. The message table, origin rules and the security
 * argument are in docs/IDENTITY-HANDOFF.md; this module is the reference
 * implementation of both sides. It touches no Node built-in, so it runs in
 * any page; `parseHandoffSignIn` is the only part a backend needs.
 */
import {
  FIELD_PRIME,
  bytesToHex,
  domainHash,
  fieldToBytes32,
  homeHash,
  hexToBytes,
  loginChallengeDigest,
  pk,
  sessionCommitment,
  toBase58,
} from "@ghostlink/common";
import { provenClaim, type HoldsAtLeastClaim, type ProvenClaim } from "./login.js";
import { SESSION_KIND_ED25519, sessionPublicKey, softwareSession, type SessionPublicKey, type SessionSigner } from "./session.js";

/** The `protocol` field of every handoff message. */
export const HANDOFF_PROTOCOL = "ghostlink-handoff" as const;
/** The protocol version this module speaks; messages of any other version are not answered. */
export const HANDOFF_VERSION = 1 as const;
/** Where the identity app answers requests, unless a site is told otherwise. */
export const HANDOFF_PATH = "/handoff";
/** The longest login session a request may ask for: about 24 hours, `@ghostlink/verify`'s default limit. */
export const HANDOFF_MAX_SESSION_SLOTS = 216_000n;
/** What a request asks for when the site does not say: about one hour. */
export const HANDOFF_DEFAULT_SESSION_SLOTS = 9_000n;
/** How long a site waits for the user by default: five minutes. */
export const HANDOFF_DEFAULT_TIMEOUT_MS = 300_000;

// ---- origins ---------------------------------------------------------------

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The canonical form of an origin both sides accept, or null: exactly
 * `scheme://host[:port]` as browsers serialize `location.origin` and
 * `MessageEvent.origin`, with https, or http on a loopback host (local
 * development). Opaque origins ("null"), paths, credentials, trailing
 * slashes and other schemes are refused, so a proof is never made for a
 * string that a browser would not report as some page's origin.
 */
export function handoffOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.origin !== value) return null;
  if (url.protocol === "https:") return value;
  if (url.protocol === "http:" && (LOOPBACK_HOSTS.has(url.hostname) || url.hostname.endsWith(".localhost"))) return value;
  return null;
}

function requireOrigin(value: unknown, what: string): string {
  const origin = handoffOrigin(value);
  if (!origin) {
    throw new HandoffError("invalid_request", `${what} must be an exact origin such as https://id.example.com ` +
      "(https, or http on localhost for development; no path or trailing slash)");
  }
  return origin;
}

// ---- wire messages -----------------------------------------------------------

/** What a site may ask the identity app to prove besides membership: a holdings claim. */
export interface HandoffClaim {
  /** The token mint, as a base58 address or 32 bytes. */
  mint: string | Uint8Array;
  /** At least this many base units. */
  threshold: bigint;
  /** The census snapshot may be at most this many slots old when the proof is made. */
  maxAgeSlots: bigint;
}

/** Identity app to site, before anything else: "I am loaded; send your request". Carries nothing else. */
export interface HandoffReadyMessage {
  protocol: typeof HANDOFF_PROTOCOL;
  version: number;
  type: "ready";
}

/** Site to identity app. Only public values: the session's public key, a lifetime and an optional claim. */
export interface HandoffRequestMessage {
  protocol: typeof HANDOFF_PROTOCOL;
  version: typeof HANDOFF_VERSION;
  type: "login-request";
  /** 32 random bytes as lowercase hex; every answer repeats it. */
  id: string;
  request: {
    /** The site's Ed25519 session public key, 32 bytes as lowercase hex. */
    sessionKeyHex: string;
    /** Requested session lifetime in slots, decimal, 1 to `HANDOFF_MAX_SESSION_SLOTS`. */
    sessionSlots: string;
    /** Optional holdings claim, every number as a decimal string. */
    claim?: { mint: string; threshold: string; maxAgeSlots: string };
  };
}

/** The Groth16 proof JSON `@ghostlink/verify` checks (snarkjs's format). */
export interface Groth16ProofJson {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
  protocol: "groth16";
  curve: "bn128";
}

/** Identity app to site, after the user approved. */
export interface HandoffResultMessage {
  protocol: typeof HANDOFF_PROTOCOL;
  version: typeof HANDOFF_VERSION;
  type: "login-result";
  id: string;
  result: {
    proof: Groth16ProofJson;
    /** The 12 login public signals, canonical decimal strings in circuit order. */
    publicSignals: string[];
    /** The slot the session key expires at, decimal. The proof binds it with the key. */
    expirySlot: string;
  };
}

/** Identity app to site: the user declined. */
export interface HandoffRefusalMessage {
  protocol: typeof HANDOFF_PROTOCOL;
  version: typeof HANDOFF_VERSION;
  type: "login-refused";
  id: string;
}

/** Identity app to site: the login could not be completed (for example, the wallet is not registered). */
export interface HandoffFailureMessage {
  protocol: typeof HANDOFF_PROTOCOL;
  version: typeof HANDOFF_VERSION;
  type: "login-error";
  id: string;
  /** Lowercase letters and underscores, at most 40; see `HandoffFailureCode` for the reference app's. */
  code: string;
  /** Text for the user, at most 300 characters. Never contains secrets. */
  message: string;
}

/** Codes the reference identity app sends in `login-error`. Others are allowed and reported as given. */
export type HandoffFailureCode = "not_registered" | "pending" | "claim_unmet" | "unavailable" | "internal";

export type HandoffMessage = HandoffReadyMessage | HandoffRequestMessage | HandoffResultMessage |
  HandoffRefusalMessage | HandoffFailureMessage;

// ---- errors ------------------------------------------------------------------

/**
 * How a handoff ended without a login. Each is a distinct outcome:
 * - `popup_blocked`: the browser did not open the window (call `requestLogin` directly in a click handler).
 * - `closed`: the user closed the window before answering.
 * - `refused`: the user declined in the identity app.
 * - `failed`: the identity app could not complete the login; `identityCode` says why.
 * - `timeout`: no answer within `timeoutMs`.
 * - `aborted`: the caller's `AbortSignal` fired.
 * - `unsupported_version`: the identity app speaks another protocol version.
 * - `invalid_response`: the identity app answered this request with a proof that is not for this
 *   site, this session key or the requested claim. Do not retry against that identity app.
 * - `invalid_request`: the options were refused before anything was opened.
 */
export type HandoffErrorCode = "popup_blocked" | "closed" | "refused" | "failed" | "timeout" | "aborted" |
  "unsupported_version" | "invalid_response" | "invalid_request";

export class HandoffError extends Error {
  constructor(readonly code: HandoffErrorCode, message: string, readonly identityCode?: string) {
    super(message);
    this.name = "HandoffError";
  }
}

// ---- validation shared by both sides ---------------------------------------

const DECIMAL = /^(0|[1-9][0-9]*)$/;
const MAX_U64 = (1n << 64n) - 1n;
const HEX64 = /^[0-9a-f]{64}$/;
const ZERO_HOME = new Uint8Array(32);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function u64(value: unknown): bigint | null {
  if (typeof value !== "string" || value.length > 20 || !DECIMAL.test(value)) return null;
  const v = BigInt(value);
  return v <= MAX_U64 ? v : null;
}

function field(value: unknown): bigint | null {
  if (typeof value !== "string" || value.length > 77 || !DECIMAL.test(value)) return null;
  const v = BigInt(value);
  return v < FIELD_PRIME ? v : null;
}

function base58Key(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || value.length < 32 || value.length > 44) return null;
  try {
    const bytes = pk(value);
    return bytes.length === 32 ? bytes : null;
  } catch {
    return null;
  }
}

function envelope(data: unknown): Record<string, unknown> | null {
  return isRecord(data) && data.protocol === HANDOFF_PROTOCOL && typeof data.type === "string" ? data : null;
}

function copyProof(value: unknown): Groth16ProofJson | null {
  if (!isRecord(value) || value.protocol !== "groth16" || value.curve !== "bn128") return null;
  const triple = (v: unknown): string[] | null =>
    Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "string" && x.length <= 78 && DECIMAL.test(x)) ? [...v] as string[] : null;
  const pairs = (v: unknown): string[][] | null => {
    if (!Array.isArray(v) || v.length !== 3) return null;
    const out: string[][] = [];
    for (const pair of v) {
      if (!Array.isArray(pair) || pair.length !== 2 || !pair.every((x) => typeof x === "string" && x.length <= 78 && DECIMAL.test(x))) return null;
      out.push([...pair] as string[]);
    }
    return out;
  };
  const pi_a = triple(value.pi_a), pi_b = pairs(value.pi_b), pi_c = triple(value.pi_c);
  return pi_a && pi_b && pi_c ? { pi_a, pi_b, pi_c, protocol: "groth16", curve: "bn128" } : null;
}

/** A request the identity app accepted, decoded. */
interface DecodedRequest {
  id: string;
  session: SessionPublicKey;
  sessionSlots: bigint;
  claim?: HoldsAtLeastClaim;
}

function decodeRequest(data: Record<string, unknown>): DecodedRequest | null {
  if (data.type !== "login-request" || data.version !== HANDOFF_VERSION) return null;
  if (typeof data.id !== "string" || !HEX64.test(data.id) || !isRecord(data.request)) return null;
  const r = data.request;
  if (typeof r.sessionKeyHex !== "string" || !HEX64.test(r.sessionKeyHex)) return null;
  let session: SessionPublicKey;
  try { session = sessionPublicKey(SESSION_KIND_ED25519, hexToBytes(r.sessionKeyHex)); } catch { return null; }
  const sessionSlots = u64(r.sessionSlots);
  if (sessionSlots === null || sessionSlots < 1n || sessionSlots > HANDOFF_MAX_SESSION_SLOTS) return null;
  let claim: HoldsAtLeastClaim | undefined;
  if (r.claim !== undefined) {
    if (!isRecord(r.claim)) return null;
    const mint = base58Key(r.claim.mint), threshold = u64(r.claim.threshold), maxAgeSlots = u64(r.claim.maxAgeSlots);
    if (!mint || threshold === null || maxAgeSlots === null) return null;
    claim = { kind: "holdsAtLeast", mint, threshold, maxAgeSlots };
  }
  return { id: data.id, session, sessionSlots, ...(claim ? { claim } : {}) };
}

/** What a site expects a result to prove. */
interface Expectation {
  origin: string;
  key32: Uint8Array;
  claim?: { mint: Uint8Array; threshold: bigint };
}

/**
 * Checks a result body against what was asked. Returns the decoded result,
 * or a reason. Both sides run it: the identity app before posting (so a bug
 * cannot send a proof for the wrong site), the site before accepting.
 */
function checkResult(body: unknown, want: Expectation):
  { ok: true; proof: Groth16ProofJson; publicSignals: string[]; expirySlot: bigint; claim: ProvenClaim | null } | { ok: false; reason: string } {
  if (!isRecord(body)) return { ok: false, reason: "result is not an object" };
  const proof = copyProof(body.proof);
  if (!proof) return { ok: false, reason: "proof is not a Groth16 proof object" };
  const raw = body.publicSignals;
  if (!Array.isArray(raw) || raw.length !== 12) return { ok: false, reason: "expected 12 public signals" };
  const signals: bigint[] = [];
  for (const s of raw) {
    const v = field(s);
    if (v === null) return { ok: false, reason: "public signals are not canonical field elements" };
    signals.push(v);
  }
  const expirySlot = u64(body.expirySlot);
  if (expirySlot === null) return { ok: false, reason: "expiry slot is not a u64" };
  if (signals[2] !== domainHash(want.origin)) return { ok: false, reason: "proof is bound to another origin" };
  if (signals[8] !== sessionCommitment(want.key32, expirySlot)) return { ok: false, reason: "proof is bound to another session key or expiry" };
  // A login proof publishes home_hash; it must be the zero home, never the wallet.
  if (signals[9] !== homeHash(ZERO_HOME)) return { ok: false, reason: "login proof binds a home address" };
  if (signals[11] !== 0n) return { ok: false, reason: "proof is a pocket authorization, not a login" };
  const publicSignals = (raw as string[]).slice();
  const claim = provenClaim(publicSignals);
  if (want.claim) {
    if (!claim) return { ok: false, reason: "proof makes no holdings claim" };
    if (bytesToHex(claim.mint) !== bytesToHex(want.claim.mint) || claim.threshold < want.claim.threshold) {
      return { ok: false, reason: "proof claims another mint or a lower threshold" };
    }
  } else if (claim) {
    return { ok: false, reason: "proof makes a holdings claim the site did not ask for" };
  }
  return { ok: true, proof, publicSignals, expirySlot, claim };
}

function randomHex32(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

// ---- site side ---------------------------------------------------------------

/** A popup window as the site sees it (a `WindowProxy`). */
export interface HandoffPopup {
  readonly closed: boolean;
  postMessage(message: unknown, targetOrigin: string): void;
  close(): void;
}

/** The fields of a `MessageEvent` the protocol reads. */
export interface HandoffMessageEvent {
  readonly data: unknown;
  readonly origin: string;
  readonly source: unknown;
}

/** The parts of `window` the site side uses; injectable for tests and non-browser hosts. */
export interface HandoffSiteWindow {
  readonly location: { readonly origin: string };
  open(url: string, target: string, features: string): HandoffPopup | null;
  addEventListener(type: "message", listener: (event: HandoffMessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: HandoffMessageEvent) => void): void;
  readonly screenX?: number;
  readonly screenY?: number;
  readonly outerWidth?: number;
  readonly outerHeight?: number;
}

export interface RequestLoginOptions {
  /** The identity app's exact origin, e.g. "https://id.example.com". Must differ from this page's origin. */
  identityOrigin: string;
  /** The identity app's handoff page; default `HANDOFF_PATH`. */
  path?: string;
  /** Ask the user to prove a holding as well. */
  claim?: HandoffClaim;
  /** Session lifetime to ask for, in slots; default `HANDOFF_DEFAULT_SESSION_SLOTS`. The identity app may grant less. */
  sessionSlots?: bigint;
  /**
   * The Ed25519 session key the proof binds; default a fresh in-memory
   * `softwareSession()`. Its private half never leaves this page.
   */
  session?: SessionSigner;
  /** Give up after this long; default `HANDOFF_DEFAULT_TIMEOUT_MS`. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Defaults to the global `window`. */
  window?: HandoffSiteWindow;
}

/** The JSON a site sends its backend: everything `verifyLogin` and `verifyLoginChallenge` need. */
export interface HandoffSignInBody {
  proof: Groth16ProofJson;
  publicSignals: string[];
  /** The session public key, 32 bytes as hex: `expect.session.key32` and `verifyLoginChallenge`'s `key32`. */
  key32Hex: string;
  expirySlot: string;
  /** The session key's signature over `loginChallengeDigest(nonce)`, 64 bytes as hex. */
  signatureHex: string;
}

/** A login the identity app approved for this site. Nothing in it is secret except `session`. */
export interface HandoffLogin {
  identityOrigin: string;
  /** This page's origin: the proof's domain, and `expectedDomain` on the backend. */
  origin: string;
  /** The user's stable ID for this site (the proof's app_id), decimal. The backend learns it from `verifyLogin`. */
  appId: string;
  proof: Groth16ProofJson;
  publicSignals: string[];
  expirySlot: bigint;
  /** The holdings claim the proof makes, or null. */
  claim: ProvenClaim | null;
  /** The session key the proof binds; keep it in memory only. */
  session: SessionSigner;
  /** Signs the backend's single-use 32-byte nonce and returns the body to send it. */
  signChallenge(nonce: Uint8Array): Promise<HandoffSignInBody>;
}

function popupFeatures(host: HandoffSiteWindow): string {
  const width = 460, height = 680;
  const parts = ["popup=yes", `width=${width}`, `height=${height}`];
  const { screenX, screenY, outerWidth, outerHeight } = host;
  if ([screenX, screenY, outerWidth, outerHeight].every((v) => typeof v === "number" && Number.isFinite(v))) {
    parts.push(`left=${Math.max(0, Math.round(screenX! + (outerWidth! - width) / 2))}`,
      `top=${Math.max(0, Math.round(screenY! + (outerHeight! - height) / 2))}`);
  }
  return parts.join(",");
}

function claimMint(mint: string | Uint8Array): Uint8Array {
  const bytes = typeof mint === "string" ? base58Key(mint) : mint instanceof Uint8Array && mint.length === 32 ? mint.slice() : null;
  if (!bytes) throw new HandoffError("invalid_request", "claim mint must be a base58 address or 32 bytes");
  return bytes;
}

/**
 * Opens the identity app in a popup and resolves with a login it approved
 * for this page's origin. Call it directly from a click handler: the popup
 * is opened synchronously, before this function first awaits, so popup
 * blockers allow it. Rejects with a `HandoffError` whose `code` says how the
 * handoff ended. Ignores every message that is not from the popup it
 * opened, from `identityOrigin`, in protocol form and about this request.
 *
 * The result has not been verified cryptographically here (that needs the
 * verifying key and the roots): send `signChallenge(nonce)` to a backend
 * that runs `verifyLogin` and `verifyLoginChallenge`.
 */
export function requestLogin(options: RequestLoginOptions): Promise<HandoffLogin> {
  try {
    return start(options);
  } catch (error) {
    return Promise.reject(error);
  }
}

function start(options: RequestLoginOptions): Promise<HandoffLogin> {
  const host = options.window ?? (globalThis as { window?: HandoffSiteWindow }).window;
  if (!host || typeof host.open !== "function") throw new HandoffError("invalid_request", "requestLogin needs a browser window");
  const origin = requireOrigin(host.location?.origin, "this page's origin");
  const identityOrigin = requireOrigin(options.identityOrigin, "identityOrigin");
  if (identityOrigin === origin) {
    throw new HandoffError("invalid_request", "the identity app must run on its own origin, not this site's: " +
      "a page on the identity origin could read the identity secret");
  }
  const path = options.path ?? HANDOFF_PATH;
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) {
    throw new HandoffError("invalid_request", "path must be an absolute path on the identity origin");
  }
  const url = new URL(path, identityOrigin);
  if (url.origin !== identityOrigin) throw new HandoffError("invalid_request", "path leaves the identity origin");

  const sessionSlots = options.sessionSlots ?? HANDOFF_DEFAULT_SESSION_SLOTS;
  if (typeof sessionSlots !== "bigint" || sessionSlots < 1n || sessionSlots > HANDOFF_MAX_SESSION_SLOTS) {
    throw new HandoffError("invalid_request", `sessionSlots must be a bigint from 1 to ${HANDOFF_MAX_SESSION_SLOTS}`);
  }
  let want: Expectation["claim"];
  let wireClaim: HandoffRequestMessage["request"]["claim"];
  if (options.claim !== undefined) {
    const { threshold, maxAgeSlots } = options.claim;
    if (typeof threshold !== "bigint" || threshold < 0n || threshold > MAX_U64 ||
      typeof maxAgeSlots !== "bigint" || maxAgeSlots < 0n || maxAgeSlots > MAX_U64) {
      throw new HandoffError("invalid_request", "claim threshold and maxAgeSlots must be u64 bigints");
    }
    const mint = claimMint(options.claim.mint);
    want = { mint, threshold };
    wireClaim = { mint: toBase58(mint), threshold: threshold.toString(), maxAgeSlots: maxAgeSlots.toString() };
  }
  const session = options.session ?? softwareSession();
  if (session.kind !== SESSION_KIND_ED25519 || typeof session.sign !== "function") {
    throw new HandoffError("invalid_request", "the handoff binds an Ed25519 session key (verifyLoginChallenge checks only those)");
  }
  const key32 = sessionPublicKey(SESSION_KIND_ED25519, session.key32).key32;
  const timeoutMs = options.timeoutMs ?? HANDOFF_DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new HandoffError("invalid_request", "timeoutMs must be positive");
  if (options.signal?.aborted) throw new HandoffError("aborted", "the login request was cancelled");

  const id = randomHex32();
  const message: HandoffRequestMessage = {
    protocol: HANDOFF_PROTOCOL, version: HANDOFF_VERSION, type: "login-request", id,
    request: { sessionKeyHex: bytesToHex(key32), sessionSlots: sessionSlots.toString(), ...(wireClaim ? { claim: wireClaim } : {}) },
  };

  // Synchronous on purpose: a popup opened after an await is no longer a user gesture.
  const opened = host.open(url.href, `ghostlink-handoff-${id.slice(0, 16)}`, popupFeatures(host));
  if (!opened) {
    throw new HandoffError("popup_blocked", "the browser blocked the sign-in window; allow pop-ups for this site and try again");
  }
  const popup: HandoffPopup = opened;

  return new Promise<HandoffLogin>((resolve, reject) => {
    let settled = false, sent = 0;
    const timers: ReturnType<typeof setTimeout>[] = [];
    let poll: ReturnType<typeof setInterval> | undefined;

    const finish = (outcome: { login: HandoffLogin } | { error: HandoffError }) => {
      if (settled) return;
      settled = true;
      host.removeEventListener("message", onMessage);
      for (const t of timers) clearTimeout(t);
      if (poll !== undefined) clearInterval(poll);
      options.signal?.removeEventListener("abort", onAbort);
      try { if (!popup.closed) popup.close(); } catch { /* a cross-origin close can be refused; nothing to do */ }
      if ("login" in outcome) resolve(outcome.login); else reject(outcome.error);
    };
    const onAbort = () => finish({ error: new HandoffError("aborted", "the login request was cancelled") });

    function onMessage(event: HandoffMessageEvent) {
      if (settled) return;
      // Only the window this call opened, at the origin it was opened for.
      if (event.source !== popup || event.origin !== identityOrigin) return;
      const data = envelope(event.data);
      if (!data) return;
      if (data.type === "ready") {
        if (data.version !== HANDOFF_VERSION) {
          finish({ error: new HandoffError("unsupported_version", `the identity app speaks handoff version ${String(data.version)}, not ${HANDOFF_VERSION}`) });
          return;
        }
        // A reload of the popup announces itself again; resend the same request a bounded number of times.
        if (sent >= 5) return;
        sent += 1;
        popup.postMessage(message, identityOrigin);
        return;
      }
      // Answers count only for this request, after it was sent, in this version.
      if (sent === 0 || data.id !== id || data.version !== HANDOFF_VERSION) return;
      if (data.type === "login-refused") {
        finish({ error: new HandoffError("refused", "you declined the sign-in request") });
      } else if (data.type === "login-error") {
        if (typeof data.code !== "string" || !/^[a-z_]{1,40}$/.test(data.code) || typeof data.message !== "string") return;
        finish({ error: new HandoffError("failed", data.message.slice(0, 300) || "the identity app could not sign you in", data.code) });
      } else if (data.type === "login-result") {
        const checked = checkResult(data.result, { origin, key32, claim: want });
        if (!checked.ok) {
          finish({ error: new HandoffError("invalid_response", `the identity app answered with an unusable proof: ${checked.reason}`) });
          return;
        }
        const { proof, publicSignals, expirySlot, claim } = checked;
        finish({ login: {
          identityOrigin, origin, appId: publicSignals[3]!, proof, publicSignals, expirySlot, claim, session,
          async signChallenge(nonce: Uint8Array): Promise<HandoffSignInBody> {
            const { signature } = await session.sign(loginChallengeDigest(nonce));
            return { proof: copyProof(proof)!, publicSignals: [...publicSignals], key32Hex: bytesToHex(key32),
              expirySlot: expirySlot.toString(), signatureHex: bytesToHex(signature) };
          },
        } });
      }
    }

    host.addEventListener("message", onMessage);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    timers.push(setTimeout(() => finish({ error: new HandoffError("timeout", "the sign-in window did not answer in time") }), timeoutMs));
    poll = setInterval(() => {
      if (settled || !popup.closed) return;
      if (poll !== undefined) clearInterval(poll);
      poll = undefined;
      // An answer posted just before the window closed is still queued; let it arrive first.
      timers.push(setTimeout(() => finish({ error: new HandoffError("closed", "the sign-in window was closed") }), 300));
    }, 400);
  });
}

/**
 * Decodes a `HandoffSignInBody` on a backend, or returns null when any
 * field is malformed. The result feeds `verifyLogin` (`proof`,
 * `publicSignals`, `expect.session.key32`/`expirySlot`) and
 * `verifyLoginChallenge` (`key32`, `signature`).
 */
export function parseHandoffSignIn(body: unknown):
  { proof: Groth16ProofJson; publicSignals: string[]; key32: Uint8Array; expirySlot: bigint; signature: Uint8Array } | null {
  if (!isRecord(body)) return null;
  const proof = copyProof(body.proof);
  const signals = body.publicSignals;
  if (!proof || !Array.isArray(signals) || signals.length !== 12 || !signals.every((s) => field(s) !== null)) return null;
  const expirySlot = u64(body.expirySlot);
  if (expirySlot === null) return null;
  if (typeof body.key32Hex !== "string" || !HEX64.test(body.key32Hex)) return null;
  if (typeof body.signatureHex !== "string" || !/^[0-9a-f]{128}$/.test(body.signatureHex)) return null;
  return { proof, publicSignals: [...signals] as string[], key32: hexToBytes(body.key32Hex), expirySlot, signature: hexToBytes(body.signatureHex) };
}

// ---- identity app side -----------------------------------------------------

/** The site's window as the identity app sees it (`window.opener`). */
export interface HandoffOpener {
  postMessage(message: unknown, targetOrigin: string): void;
}

/** The parts of `window` the identity app side uses; injectable for tests. */
export interface HandoffIdentityWindow {
  readonly location: { readonly origin: string };
  readonly opener: HandoffOpener | null;
  addEventListener(type: "message", listener: (event: HandoffMessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: HandoffMessageEvent) => void): void;
}

/** What the identity app may answer with: the proof, made for `request.origin` and `request.session`. */
export interface HandoffApproval {
  proof: { snarkjsProof: object; publicSignals: string[] };
  expirySlot: bigint;
}

/**
 * A login request as the identity app received it. `origin` comes from the
 * browser (the `MessageEvent.origin` of a message sent by this window's
 * opener), never from the message; show it to the user. Answer once.
 */
export interface HandoffLoginRequest {
  /** The requesting site's origin: prove for exactly this, and show it. */
  readonly origin: string;
  readonly id: string;
  /** The site's session public key; the proof binds it. */
  readonly session: SessionPublicKey;
  /** The lifetime the site asked for (1 to `HANDOFF_MAX_SESSION_SLOTS`); grant at most this. */
  readonly sessionSlots: bigint;
  readonly claim?: HoldsAtLeastClaim;
  /** False once any answer was sent. */
  readonly open: boolean;
  /**
   * Posts the proof to `origin` only. Throws, and sends nothing, if the
   * proof is not a login for `origin` and `session` making the requested claim.
   */
  approve(approval: HandoffApproval): void;
  refuse(): void;
  fail(code: string, message: string): void;
}

export interface HandoffResponderOptions {
  /** Defaults to the global `window`. */
  window?: HandoffIdentityWindow;
  /** Called once, for the first valid request from the opener. */
  onRequest(request: HandoffLoginRequest): void;
}

export interface HandoffResponder {
  /** False when this page has no opener: it was not opened by a site, so no request can come. */
  readonly opened: boolean;
  /** Stops listening. Answers to a request already received still go out. */
  stop(): void;
}

/**
 * The identity app's side. Announces itself to `window.opener`, then waits
 * for one login request from it. A message counts only if its `source` is
 * this window's opener, its `origin` is an acceptable origin other than
 * this app's own, and it is a well-formed version-1 request; everything
 * else, including any request after the first, is ignored. The answer is
 * posted to the opener with `targetOrigin` set to the requesting origin, so
 * the browser drops it if the opener has navigated anywhere else meanwhile.
 */
export function listenForHandoffRequest(options: HandoffResponderOptions): HandoffResponder {
  const host = options.window ?? (globalThis as { window?: HandoffIdentityWindow }).window;
  if (!host) throw new Error("listenForHandoffRequest needs a browser window");
  const self = host.location.origin;
  const opener = host.opener;
  if (!opener) return { opened: false, stop: () => undefined };
  let received = false, stopped = false;

  const onMessage = (event: HandoffMessageEvent) => {
    if (received || stopped) return;
    // The opener at the time of the message: another window, or a frame inside the opener, is ignored.
    if (!host.opener || event.source !== host.opener) return;
    const origin = handoffOrigin(event.origin);
    if (!origin || origin === self) return;
    const data = envelope(event.data);
    const decoded = data && decodeRequest(data);
    if (!decoded) return;
    received = true;
    host.removeEventListener("message", onMessage);
    options.onRequest(answerable(host, origin, decoded));
  };
  host.addEventListener("message", onMessage);
  // The one message sent before the opener's origin is known. It carries no data, so "*" reveals
  // only that this page loaded, which the opener already knows: it opened it.
  const ready: HandoffReadyMessage = { protocol: HANDOFF_PROTOCOL, version: HANDOFF_VERSION, type: "ready" };
  opener.postMessage(ready, "*");
  return {
    opened: true,
    stop() {
      stopped = true;
      host.removeEventListener("message", onMessage);
    },
  };
}

function answerable(host: HandoffIdentityWindow, origin: string, request: DecodedRequest): HandoffLoginRequest {
  let open = true;
  const post = (message: HandoffResultMessage | HandoffRefusalMessage | HandoffFailureMessage) => {
    open = false;
    // Exactly the requesting origin, never "*": if the opener now shows another site, the browser drops this.
    host.opener?.postMessage(message, origin);
  };
  const base = { protocol: HANDOFF_PROTOCOL, version: HANDOFF_VERSION, id: request.id } as const;
  return {
    origin, id: request.id, session: request.session, sessionSlots: request.sessionSlots,
    ...(request.claim ? { claim: request.claim } : {}),
    get open() { return open; },
    approve(approval: HandoffApproval) {
      if (!open) throw new Error("this request was already answered");
      const body = {
        proof: approval?.proof?.snarkjsProof,
        publicSignals: approval?.proof?.publicSignals,
        expirySlot: typeof approval?.expirySlot === "bigint" ? approval.expirySlot.toString() : undefined,
      };
      const checked = checkResult(body, { origin, key32: request.session.key32,
        claim: request.claim && { mint: request.claim.mint, threshold: request.claim.threshold } });
      if (!checked.ok) throw new Error(`refusing to send this proof: ${checked.reason}`);
      post({ ...base, type: "login-result",
        result: { proof: checked.proof, publicSignals: checked.publicSignals, expirySlot: checked.expirySlot.toString() } });
    },
    refuse() {
      if (open) post({ ...base, type: "login-refused" });
    },
    fail(code: string, message: string) {
      if (!open) return;
      const safeCode = typeof code === "string" && /^[a-z_]{1,40}$/.test(code) ? code : "internal";
      post({ ...base, type: "login-error", code: safeCode, message: String(message ?? "").slice(0, 300) });
    },
  };
}

/** The user's stable ID for a site as the identity app and the backend see it, in base58 (display form). */
export function appIdToBase58(appId: string | bigint): string {
  const v = typeof appId === "bigint" ? appId : field(appId);
  if (v === null || v < 0n || v >= FIELD_PRIME) throw new Error("not an app ID");
  return toBase58(fieldToBytes32(v));
}
