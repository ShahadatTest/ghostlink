/**
 * The starter's route handlers with a real Groth16 login proof (the
 * repository's published development fixture, made for
 * https://app.example.com) and the matching session key. The RPC and the
 * indexer are stubbed; everything else is the code the site runs.
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bytesToHex, hexToBytes, joinBytes32, loginChallengeDigest, toBase58 } from "@ghostlink/common";
import { appIdToBase58, softwareSession } from "@ghostlink/sdk";
import { POST as nonceRoute } from "../app/api/ghostlink/nonce/route";
import { POST as verifyRoute } from "../app/api/ghostlink/verify/route";
import { POST as signOutRoute } from "../app/api/ghostlink/sign-out/route";
import { SESSION_COOKIE, sessionCookieId, store } from "../lib/store";

const vectors = JSON.parse(readFileSync(new URL("../../../packages/common/fixtures/vectors.json", import.meta.url), "utf8"));
const fixture = JSON.parse(readFileSync(new URL("../../../circuits/keys/login_offchain_proof.json", import.meta.url), "utf8"));
const SITE = vectors.identity.origin as string; // the origin the fixture proof is bound to
const session = softwareSession(hexToBytes(vectors.identity.sessionSeed));
const expirySlot = BigInt(vectors.identity.expirySlot);
const signals = fixture.publicSignals as string[];
const mint = toBase58(joinBytes32(BigInt(signals[4]!), BigInt(signals[5]!)));

let slot = expirySlot - 100n;
let indexerUp = true;

beforeEach(() => {
  slot = expirySlot - 100n;
  indexerUp = true;
  for (const key of ["GATE_MINT", "GATE_THRESHOLD", "GATE_MAX_AGE_SLOTS"]) delete process.env[key];
  Object.assign(process.env, { SITE_ORIGIN: SITE, IDENTITY_ORIGIN: "https://id.example", GHOSTLINK_INDEXER_URL: "https://indexer.test",
    GHOSTLINK_RPC_URL: "https://rpc.test", LOGIN_SESSION_SLOTS: "216000" });
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://rpc.test") {
      expect(JSON.parse(String(init?.body)).method).toBe("getSlot");
      return Response.json({ jsonrpc: "2.0", id: 1, result: Number(slot) });
    }
    if (!indexerUp) return new Response("down", { status: 503 });
    if (url === "https://indexer.test/roots/registry") return Response.json({ tree: "registry", roots: ["1", signals[0]], nextIndex: 1 });
    if (url === "https://indexer.test/roots/census") return Response.json({ tree: "census", roots: [signals[1]], nextIndex: 1 });
    throw new Error(`unexpected fetch ${url}`);
  });
});
afterEach(() => vi.unstubAllGlobals());

const post = (route: (r: Request) => Promise<Response>, body: unknown, origin: string | null = SITE, cookie?: string) =>
  route(new Request(`${SITE}/api`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json", ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}) } }));

async function signInBody(nonceHex?: string) {
  const challenge = await (await post(nonceRoute, {})).json() as { challengeId: string; nonce: string };
  const signed = await session.sign(loginChallengeDigest(hexToBytes(nonceHex ?? challenge.nonce)));
  return { challengeId: challenge.challengeId, proof: fixture.proof, publicSignals: signals, key32Hex: bytesToHex(session.key32),
    expirySlot: expirySlot.toString(), signatureHex: bytesToHex(signed.signature) };
}

describe("starter routes", () => {
  it("signs in once with a valid proof and challenge, and the cookie names the user's per-site ID", async () => {
    const body = await signInBody();
    const response = await post(verifyRoute, body);
    expect(response.status).toBe(200);
    const { appId } = await response.json() as { appId: string };
    expect(appId).toBe(appIdToBase58(vectors.identity.appId));
    const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toMatch(new RegExp(`^${SESSION_COOKIE}=[0-9a-f]{64}; Path=/; HttpOnly; SameSite=Lax; Max-Age=40; Secure$`)); // https site: Secure
    const id = sessionCookieId(cookie.split(";")[0]!);
    expect(store().session(id)).toMatchObject({ appId });
    // The same body again: the nonce is gone, so a copied sign-in is worth nothing.
    expect(await (await post(verifyRoute, body)).json()).toEqual({ code: "unknown_challenge" });
    const out = await post(signOutRoute, {}, SITE, cookie.split(";")[0]);
    expect(out.status).toBe(303);
    expect(store().session(id)).toBeUndefined();
  });

  it("refuses requests from another site, malformed bodies, and unknown challenges", async () => {
    expect((await post(nonceRoute, {}, "https://evil.example")).status).toBe(403);
    expect((await post(nonceRoute, {}, null)).status).toBe(403);
    const body = await signInBody();
    expect((await post(verifyRoute, body, "https://evil.example")).status).toBe(403);
    expect((await post(signOutRoute, {}, "https://evil.example")).status).toBe(403);
    expect(await (await post(verifyRoute, "{")).json()).toEqual({ code: "malformed_request" });
    expect(await (await post(verifyRoute, "x".repeat(20_000))).json()).toEqual({ code: "malformed_request" });
    expect(await (await post(verifyRoute, { ...body, challengeId: "00".repeat(32) })).json()).toEqual({ code: "unknown_challenge" });
    // A malformed body still uses up its challenge.
    expect(await (await post(verifyRoute, { ...body, key32Hex: "zz" })).json()).toEqual({ code: "malformed_request" });
    expect(await (await post(verifyRoute, body)).json()).toEqual({ code: "unknown_challenge" });
  });

  it("refuses a signature over another nonce, a proof for another site, an expired session and unknown roots", async () => {
    expect(await (await post(verifyRoute, await signInBody("11".repeat(32)))).json()).toEqual({ code: "bad_signature" });
    const prepared = await signInBody();
    process.env.SITE_ORIGIN = "https://other.example";
    // Posted from the old site: the browser's Origin is not this site's.
    expect((await post(verifyRoute, prepared)).status).toBe(403);
    // Posted properly to the other site: the proof is bound to the first one.
    const forged = await nonceRoute(new Request("https://other.example/api", { method: "POST", headers: { origin: "https://other.example" } }));
    const { challengeId, nonce } = await forged.json() as { challengeId: string; nonce: string };
    const signature = bytesToHex((await session.sign(loginChallengeDigest(hexToBytes(nonce)))).signature);
    const wrongSite = await verifyRoute(new Request("https://other.example/api", { method: "POST", headers: { origin: "https://other.example" },
      body: JSON.stringify({ challengeId, proof: fixture.proof, publicSignals: signals, key32Hex: bytesToHex(session.key32), expirySlot: expirySlot.toString(), signatureHex: signature }) }));
    expect(await wrongSite.json()).toEqual({ code: "wrong_domain" });
    process.env.SITE_ORIGIN = SITE;
    slot = expirySlot;
    expect(await (await post(verifyRoute, await signInBody())).json()).toEqual({ code: "session_expired" });
    slot = expirySlot - 100n;
    const tampered = await signInBody();
    tampered.publicSignals = [...signals];
    tampered.publicSignals[0] = "2";
    expect(await (await post(verifyRoute, tampered)).json()).toEqual({ code: "unknown_root" });
    indexerUp = false;
    const down = await post(verifyRoute, await signInBody());
    expect(down.status).toBe(503);
    expect(await down.json()).toEqual({ code: "roots_unavailable" });
  });

  it("enforces a token gate from the configuration", async () => {
    Object.assign(process.env, { GATE_MINT: mint, GATE_THRESHOLD: signals[6], GATE_MAX_AGE_SLOTS: "99000" });
    expect((await post(verifyRoute, await signInBody())).status).toBe(200);
    process.env.GATE_THRESHOLD = (BigInt(signals[6]!) + 1n).toString();
    expect(await (await post(verifyRoute, await signInBody())).json()).toEqual({ code: "threshold_too_low" });
    Object.assign(process.env, { GATE_THRESHOLD: signals[6], GATE_MAX_AGE_SLOTS: "1000" });
    expect(await (await post(verifyRoute, await signInBody())).json()).toEqual({ code: "snapshot_too_old" });
  });
});
