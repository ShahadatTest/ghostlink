/**
 * The two server steps of "Continue with GhostLink", without Next.js types
 * so the route handlers, the tests and the local end-to-end check share them.
 *
 *   1. issueChallenge: a single-use 32-byte nonce for one sign-in attempt.
 *   2. verifySignIn: take that nonce (once), check the proof is valid, bound
 *      to THIS site's origin and to the session key the browser announced,
 *      built on roots your indexer knows, and that the same key signed the
 *      nonce. Only then create a session.
 *
 * Every trusted input comes from this server's configuration: the expected
 * origin, the indexer (roots) and the RPC (current slot). The browser
 * supplies only the proof, its public signals, the session key, the expiry
 * and the signature, and the server checks each of them.
 */
import { bytesToHex } from "@ghostlink/common";
import { appIdToBase58, parseHandoffSignIn } from "@ghostlink/sdk";
import { holdingsClaim, verifyLogin, verifyLoginChallenge, type VerifyLoginErrorCode } from "@ghostlink/verify";
import type { SiteConfig } from "./config";
import type { MemoryStore } from "./store";

export type SignInResult =
  | { ok: true; sessionId: string; appId: string; maxAgeSeconds: number }
  | { ok: false; status: number; code: VerifyLoginErrorCode | "cross_origin" | "malformed_request" | "unknown_challenge" | "bad_signature" | "rpc_unavailable" };

/** Refuse requests a browser sent from another site (login CSRF). Browsers always send Origin on POST. */
export function sameOrigin(originHeader: string | null, config: SiteConfig): boolean {
  return originHeader === config.siteOrigin;
}

export function issueChallenge(store: MemoryStore): { challengeId: string; nonce: string } {
  const { challengeId, nonce } = store.issue();
  return { challengeId, nonce: bytesToHex(nonce) };
}

/** The chain's current slot from your own RPC; never from the client. */
export async function rpcSlot(rpc: string, fetchFn: typeof fetch = fetch): Promise<bigint> {
  const response = await fetchFn(rpc, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSlot", params: [{ commitment: "confirmed" }] }) });
  const body = await response.json() as { result?: unknown };
  if (!response.ok || typeof body.result !== "number" || !Number.isSafeInteger(body.result)) throw new Error("RPC getSlot failed");
  return BigInt(body.result);
}

/** A slot is about 400 ms; a session cookie never outlives the proof's session key. */
const SLOT_MS = 400;
const MAX_SESSION_SECONDS = 3_600;

export async function verifySignIn(params: {
  body: unknown;
  config: SiteConfig;
  store: MemoryStore;
  currentSlot?: () => Promise<bigint>;
  fetchFn?: typeof fetch;
}): Promise<SignInResult> {
  const { body, config, store } = params;
  const challengeId = (body as { challengeId?: unknown } | null)?.challengeId;
  if (typeof challengeId !== "string" || !/^[0-9a-f]{64}$/.test(challengeId)) return { ok: false, status: 400, code: "malformed_request" };
  // Taken first and deleted whatever happens next: one attempt per nonce.
  const nonce = store.take(challengeId);
  if (!nonce) return { ok: false, status: 400, code: "unknown_challenge" };
  const signIn = parseHandoffSignIn(body);
  if (!signIn) return { ok: false, status: 400, code: "malformed_request" };

  let currentSlot: bigint;
  try {
    currentSlot = await (params.currentSlot ?? (() => rpcSlot(config.rpc, params.fetchFn)))();
  } catch {
    return { ok: false, status: 503, code: "rpc_unavailable" };
  }
  const gate = config.gate;
  const result = await verifyLogin({
    proof: signIn.proof,
    publicSignals: signIn.publicSignals,
    expectedDomain: config.siteOrigin,
    roots: config.indexer,
    ...(params.fetchFn ? { fetchFn: params.fetchFn } : {}),
    expect: {
      session: { key32: signIn.key32, expirySlot: signIn.expirySlot, currentSlot, maxSessionSlots: config.maxSessionSlots },
      ...(gate ? {
        holdsAtLeast: holdingsClaim(gate.mint, gate.threshold),
        minSlot: currentSlot > gate.windowSlots ? currentSlot - gate.windowSlots : 0n,
      } : {}),
    },
  });
  if (!result.ok) {
    const status = ["server_configuration", "roots_unavailable", "invalid_expectation"].includes(result.code) ? 503 : 401;
    return { ok: false, status, code: result.code };
  }
  // The proof is public; only the holder of its session key can sign this server's fresh nonce.
  if (!verifyLoginChallenge({ key32: signIn.key32, nonce, signature: signIn.signature })) {
    return { ok: false, status: 401, code: "bad_signature" };
  }
  const maxAgeSeconds = Math.max(1, Math.min(MAX_SESSION_SECONDS, Math.floor(Number(signIn.expirySlot - currentSlot) * SLOT_MS / 1000)));
  const appId = appIdToBase58(result.appId);
  const sessionId = store.createSession({
    appId,
    ...(gate ? { gate: { mint: gate.mint, threshold: gate.threshold.toString() } } : {}),
    expiresAt: Date.now() + maxAgeSeconds * 1000,
  });
  return { ok: true, sessionId, appId, maxAgeSeconds };
}

