/**
 * Server-side login verification: the off-chain path, no transaction.
 *
 * In plain language: an app's backend calls `verifyLogin` with the proof
 * its frontend received. The function checks the zero-knowledge proof
 * itself, that it was made for YOUR domain (not another app's), that the
 * claims match what you asked for, that the Merkle roots inside it are
 * real recent roots, and — if you tell it which session key and expiry
 * the client announced — that the proof is bound to exactly those and
 * dies with its expiry. Session details are public: the backend must ALSO
 * verify a fresh, single-use challenge signed by that session key
 * (`verifyLoginChallenge`) before granting access. Binding alone does not
 * prevent captured-proof replay.
 *
 * A proof is not a password: without `expect.session` any copy of it
 * logs in until its roots fall out of the ring. Set it, and have the
 * client additionally sign a nonce you issued with the session key.
 */
import * as snarkjs from "snarkjs";
export { loginChallengeDigest } from "@ghostlink/common";
import { createRequire } from "node:module";
import { ed25519 } from "@noble/curves/ed25519";
import {
  FIELD_PRIME,
  domainHash,
  homeHash,
  loginChallengeDigest,
  pocketAuthorizationContext,
  sessionCommitment,
  type RootsResponse,
  type Policy,
  type SessionDeployment,
} from "@ghostlink/common";

/** Public signal order of the login circuit — the protocol contract. */
export const LOGIN_SIGNALS = [
  "registry_root",
  "census_root",
  "domain_hash",
  "app_id",
  "mint_hi",
  "mint_lo",
  "threshold",
  "min_slot",
  "session_commitment",
  "home_hash",
  "claim_holdings",
  "authorization_context",
] as const;

type SignalName = (typeof LOGIN_SIGNALS)[number];
type Signals = Record<SignalName, bigint>;

/** ~24 hours of slots; the longest session the default policy allows. */
export const DEFAULT_MAX_SESSION_SLOTS = 216_000n;

export type RootSource = string | (() => Promise<{ registry: string[]; census: string[] }>);

export interface SessionExpectation {
  /**
   * 32 bytes of session key material as the pocket sees it: the Ed25519
   * public key itself, or SHA-256 of the 33-byte compressed P-256 key.
   */
  key32: Uint8Array;
  /** The expiry slot the client announced for this session. */
  expirySlot: bigint;
  /** The chain's current slot — fetch it yourself, never from the client. */
  currentSlot: bigint;
  /** Longest session you accept; default `DEFAULT_MAX_SESSION_SLOTS`. */
  maxSessionSlots?: bigint;
}

export interface VerifyLoginParams {
  /** The SDK's `session.proof.snarkjsProof`, not its on-chain proof bytes. */
  proof: object;
  /** The 12 V2 public signals, canonical decimal strings, in circuit order. */
  publicSignals: string[];
  /** Your app's origin, e.g. "https://app.example.com". */
  expectedDomain: string;
  /**
   * The login verifying key. Defaults to the key bundled with this
   * package (`bundledLoginVerificationKey()`); pass your own when you
   * verify against a different circuit build on purpose, or when your
   * bundler cannot ship `keys/login_vk.json` next to the code.
   */
  verificationKey?: object;
  /**
   * Where known roots come from: an indexer base URL, or a function —
   * for instance one that reads the 128-root ring straight from the
   * on-chain TreeState account. Required: a proof against a tree nobody
   * recognizes proves nothing. (`indexer` is the older name.)
   */
  roots?: RootSource;
  indexer?: RootSource;
  /** Skip the root check. Only for tests; never in production. */
  allowUnverifiedRoots?: boolean;
  expect?: {
    /** Token gate: at least `threshold` of this mint. Requires `minSlot`. */
    holdsAtLeast?: { mintHi: string; mintLo: string; threshold: bigint };
    /**
     * Oldest census snapshot slot you accept: `currentSlot` from your own
     * RPC minus a window a little wider than the clients' `maxAgeSlots`
     * (they subtract it from a slot read before proving). Required with
     * `holdsAtLeast`: the census tree only grows and the prover picks
     * `min_slot`, so without a bound a snapshot of a past peak or briefly
     * borrowed balance passes forever. `0n` deliberately accepts any age.
     */
    minSlot?: bigint;
    /** Binds the proof to one session key + expiry and enforces the expiry. */
    session?: SessionExpectation;
    /** The home address the client announced (32 bytes). */
    home?: Uint8Array;
    /**
     * Explicitly verify a pocket authorization; absent means off-chain login only.
     * `authorizationEpoch` is the pocket's on-chain revocation epoch (default 0n,
     * a pocket not yet created); a proof for any other epoch is refused.
     */
    pocket?: { policy: Policy; sessionKind: number; deployment?: SessionDeployment; authorizationEpoch?: bigint };
  };
  fetchFn?: typeof fetch;
}

/** `ok` narrows the result: a success always carries `appId`, a refusal always carries `reason`. */
export type VerifyLoginResult =
  | {
      ok: true;
      /** The user's stable ID for THIS app as a canonical decimal string. */
      appId: string;
      reason?: undefined;
    }
  | { ok: false; reason: string; appId?: undefined };

const DECIMAL = /^(0|[1-9][0-9]*)$/;
const MAX_U64 = (1n << 64n) - 1n;

function parseSignals(raw: unknown): Signals | null {
  if (!Array.isArray(raw) || raw.length !== LOGIN_SIGNALS.length) return null;
  const out = {} as Signals;
  for (const [i, name] of LOGIN_SIGNALS.entries()) {
    const v = parseField(raw[i]);
    if (v === null) return null;
    out[name] = v;
  }
  return out;
}

function parseField(s: unknown): bigint | null {
  if (typeof s !== "string" || s.length > 77 || !DECIMAL.test(s)) return null;
  const v = BigInt(s);
  return v < FIELD_PRIME ? v : null;
}

export async function verifyLogin(params: VerifyLoginParams): Promise<VerifyLoginResult> {
  // This boundary is routinely called with decoded request data. Its
  // TypeScript types cannot guarantee the runtime shape of that data.
  try {
    return await verifyLoginChecked(params);
  } catch {
    return { ok: false, reason: "malformed login input" };
  }
}

async function verifyLoginChecked(params: VerifyLoginParams): Promise<VerifyLoginResult> {
  const signals = parseSignals(params.publicSignals);
  if (!signals) return { ok: false, reason: "malformed public signals" };
  if (typeof params.expectedDomain !== "string" || !params.expectedDomain) {
    return { ok: false, reason: "expected domain is required" };
  }

  // 1. The proof is bound to YOUR domain, or it is someone else's login.
  if (signals.domain_hash !== domainHash(params.expectedDomain)) {
    return { ok: false, reason: "proof bound to a different domain" };
  }

  // 2. Claim expectations.
  const want = params.expect?.holdsAtLeast;
  if (want) {
    if (typeof want.threshold !== "bigint" || want.threshold < 0n || want.threshold > MAX_U64) {
      return { ok: false, reason: "expected threshold must be a u64 bigint" };
    }
    // Census leaves are never removed and the prover picks min_slot, so a
    // gate with no freshness bound accepts a past peak or a briefly
    // borrowed balance forever. 0n is the explicit way to accept any age.
    if (params.expect?.minSlot === undefined) {
      return { ok: false, reason: "holdings claim needs a freshness bound: set expect.minSlot (0n accepts snapshots of any age)" };
    }
    if (signals.claim_holdings !== 1n) return { ok: false, reason: "holdings claim missing" };
    const hi = parseField(want.mintHi);
    const lo = parseField(want.mintLo);
    if (hi === null || lo === null) return { ok: false, reason: "malformed expected mint" };
    if (signals.mint_hi !== hi || signals.mint_lo !== lo) {
      return { ok: false, reason: "claim is for a different mint" };
    }
    if (signals.threshold < want.threshold) {
      return { ok: false, reason: "threshold below requirement" };
    }
  }
  if (params.expect?.minSlot !== undefined) {
    if (typeof params.expect.minSlot !== "bigint" || params.expect.minSlot < 0n || params.expect.minSlot > MAX_U64) {
      return { ok: false, reason: "expected minSlot must be a u64 bigint" };
    }
    // The circuit only enforces slot >= min_slot when the claim is on;
    // without it min_slot is whatever the prover typed.
    if (signals.claim_holdings !== 1n) {
      return { ok: false, reason: "minSlot is meaningless without a holdings claim" };
    }
    if (signals.min_slot < params.expect.minSlot) {
      return { ok: false, reason: "snapshot window too old" };
    }
  }

  // 3. Session binding and expiry (replay control).
  const session = params.expect?.session;
  if (session) {
    if (!(session.key32 instanceof Uint8Array) || session.key32.length !== 32) {
      return { ok: false, reason: "session key32 must be 32 bytes" };
    }
    const max = session.maxSessionSlots ?? DEFAULT_MAX_SESSION_SLOTS;
    if (![session.expirySlot, session.currentSlot, max].every((v) => typeof v === "bigint" && v >= 0n && v <= MAX_U64)) {
      return { ok: false, reason: "session slots must be u64 bigints" };
    }
    if (signals.session_commitment !== sessionCommitment(session.key32, session.expirySlot)) {
      return { ok: false, reason: "proof bound to a different session key or expiry" };
    }
    if (session.expirySlot <= session.currentSlot) return { ok: false, reason: "session expired" };
    if (session.expirySlot > session.currentSlot + max) {
      return { ok: false, reason: "session expiry too far ahead" };
    }
  }
  if (params.expect?.home) {
    if (!(params.expect.home instanceof Uint8Array) || params.expect.home.length !== 32) {
      return { ok: false, reason: "home must be 32 bytes" };
    }
    if (signals.home_hash !== homeHash(params.expect.home)) {
      return { ok: false, reason: "proof bound to a different home address" };
    }
  }

  // A website login grants no pocket authority. Callers that verify a
  // spending authorization must supply the owner-approved context.
  const pocket = params.expect?.pocket;
  const expectedContext = pocket
    ? pocketAuthorizationContext(pocket.policy, pocket.sessionKind, pocket.deployment, pocket.authorizationEpoch ?? 0n) : 0n;
  if (signals.authorization_context !== expectedContext) {
    return { ok: false, reason: "proof bound to a different authorization purpose, policy, deployment or revocation epoch" };
  }

  // 4. Roots must be known recent roots (stale-root control).
  const source = params.roots ?? params.indexer;
  if (!source) {
    if (!params.allowUnverifiedRoots) {
      return { ok: false, reason: "no root source configured (roots: indexer URL or function)" };
    }
  } else {
    let roots: { registry: string[]; census: string[] };
    try {
      roots = typeof source === "function" ? await source() : await fetchRoots(source, params.fetchFn ?? fetch);
    } catch (e) {
      return { ok: false, reason: `root source unavailable: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (!Array.isArray(roots?.registry) || !Array.isArray(roots?.census)) {
      return { ok: false, reason: "root source returned an unexpected shape" };
    }
    if (!roots.registry.some((r) => parseField(r) === signals.registry_root)) {
      return { ok: false, reason: "unknown registry root" };
    }
    if (signals.claim_holdings === 1n && !roots.census.some((r) => parseField(r) === signals.census_root)) {
      return { ok: false, reason: "unknown census root" };
    }
  }

  // 5. The proof itself. A missing key is the server's fault, not the
  // proof's: bundlers and serverless builds can drop keys/login_vk.json.
  let vk: unknown;
  try {
    vk = params.verificationKey ?? bundledLoginVerificationKey();
  } catch {
    vk = undefined;
  }
  if (typeof vk !== "object" || vk === null) {
    return {
      ok: false,
      reason: "login verifying key unavailable (server configuration): deploy keys/login_vk.json with @ghostlink/verify or pass verificationKey",
    };
  }
  let valid = false;
  try {
    valid = await snarkjs.groth16.verify(vk, params.publicSignals, params.proof);
  } catch {
    return { ok: false, reason: "proof is malformed" };
  }
  if (!valid) return { ok: false, reason: "proof failed verification" };

  return { ok: true, appId: signals.app_id.toString() };
}

export interface LoginChallengeSignature {
  /** The proof-bound Ed25519 session key: the `expect.session.key32` you verified. */
  key32: Uint8Array;
  /** The 32-byte single-use nonce your server issued for this login. */
  nonce: Uint8Array;
  /** The client's 64-byte Ed25519 signature over `loginChallengeDigest(nonce)`. */
  signature: Uint8Array;
}

/**
 * Replay control: true when the session key signed `loginChallengeDigest(nonce)`,
 * exactly as the SDK's software (Ed25519) session signs it in `ghostlink:signIn`.
 * Pass the same key32 you bound with `verifyLogin`'s `expect.session`, and
 * consume the nonce atomically: a signature cannot tell a first use from a
 * replay. Malformed input returns false; this never throws.
 *
 * Ed25519 sessions only. A passkey (P-256) session's key32 is a hash of its
 * public key and its signature is a WebAuthn assertion, so this returns false
 * for it: verify those with a WebAuthn library against the 33-byte key (whose
 * SHA-256 must equal key32), expecting the challenge `loginChallengeDigest(nonce)`.
 */
export function verifyLoginChallenge(input: LoginChallengeSignature): boolean {
  try {
    const { key32, nonce, signature } = input;
    if (!(key32 instanceof Uint8Array) || key32.length !== 32) return false;
    if (!(nonce instanceof Uint8Array) || nonce.length !== 32) return false;
    if (!(signature instanceof Uint8Array) || signature.length !== 64) return false;
    // Anyone can sign for a small-order key; the SDK refuses such session
    // keys (and mixed-order ones), so a backend must as well.
    const point = ed25519.ExtendedPoint.fromHex(key32);
    if (point.isSmallOrder() || !point.isTorsionFree()) return false;
    // RFC 8032 encoding rules rather than ZIP-215; honest signatures pass both.
    return ed25519.verify(signature, loginChallengeDigest(nonce), key32, { zip215: false });
  } catch {
    return false;
  }
}

let bundledKey: object | undefined;

/**
 * The login verifying key shipped with this package (keys/login_vk.json).
 * Throws if a bundler or deployment left the file out; call it at startup
 * to fail fast instead of on the first login.
 */
export function bundledLoginVerificationKey(): object {
  if (!bundledKey) {
    const require = createRequire(import.meta.url);
    bundledKey = require("../keys/login_vk.json") as object;
  }
  return bundledKey;
}

async function fetchRoots(
  base: string,
  fetchFn: typeof fetch,
): Promise<{ registry: string[]; census: string[] }> {
  const get = async (tree: string): Promise<RootsResponse> => {
    const res = await fetchFn(`${base}/roots/${tree}`);
    if (!res.ok) throw new Error(`roots/${tree}: HTTP ${res.status}`);
    return (await res.json()) as RootsResponse;
  };
  const [registry, census] = await Promise.all([get("registry"), get("census")]);
  return { registry: registry.roots, census: census.roots };
}
