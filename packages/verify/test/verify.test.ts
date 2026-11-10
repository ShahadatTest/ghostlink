/** Verifies the committed fixture proof through the public API. */
import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { bundledLoginVerificationKey, loginChallengeDigest, verifyLogin, verifyLoginChallenge } from "../src/index.js";
import { bytesToHex, conservativePolicy, developmentSessionDeployment, hexToBytes } from "@ghostlink/common";
import { ed25519 } from "@noble/curves/ed25519";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const vkPath = join(root, "circuits/keys/login_vk.json");
const proofPath = join(root, "circuits/keys/login_offchain_proof.json");
const built = existsSync(vkPath) && existsSync(proofPath);
const vectors = JSON.parse(readFileSync(join(root, "packages/common/fixtures/vectors.json"), "utf8"));

describe.skipIf(!built)("verifyLogin", () => {
  const fx = () => JSON.parse(readFileSync(proofPath, "utf8"));
  const pub = vectors.circuits.login.public;
  const roots = async () => ({
    registry: [pub.registry_root],
    census: [pub.census_root],
  });
  const sessionKey32 = ed25519.getPublicKey(hexToBytes(vectors.identity.sessionSeed));
  const expirySlot = BigInt(vectors.identity.expirySlot);
  const base = () => {
    const f = fx();
    return {
      proof: f.proof as object,
      publicSignals: f.publicSignals as string[],
      expectedDomain: vectors.identity.origin as string,
      roots,
    };
  };

  it("ships the same verifying key the circuits produced", () => {
    expect(bundledLoginVerificationKey()).toEqual(JSON.parse(readFileSync(vkPath, "utf8")));
  });

  it("separates website login from exact pocket policy and deployment consent", async () => {
    const f = JSON.parse(readFileSync(join(root, "circuits/keys/login_proof.json"), "utf8"));
    const policy = { ...conservativePolicy(), oracleFeeds: vectors.policyWithFeeds.feeds.map(
      (feed: { mint: string; feedId: string; decimals: number }) => ({
        mint: hexToBytes(feed.mint), feedId: hexToBytes(feed.feedId), decimals: feed.decimals,
      }),
    ) };
    const pocket = { policy, sessionKind: 0 };
    const request = { ...base(), proof: f.proof, publicSignals: f.publicSignals };
    expect((await verifyLogin(request)).ok).toBe(false);
    expect((await verifyLogin({ ...base(), expect: { pocket } })).ok).toBe(false);
    expect((await verifyLogin({ ...request, expect: { pocket } })).ok).toBe(true);
    const deployment = developmentSessionDeployment();
    deployment.pocketProgram[0] ^= 1;
    expect((await verifyLogin({ ...request, expect: { pocket: { ...pocket, deployment } } })).ok).toBe(false);
    expect((await verifyLogin({ ...request, expect: { pocket: { ...pocket, policy: { ...policy, dailyCapUsdE6: policy.dailyCapUsdE6 + 1n } } } })).ok).toBe(false);
    // The fixture authorizes a pocket that was never revoked; a revoke raises the epoch and retires it.
    expect((await verifyLogin({ ...request, expect: { pocket: { ...pocket, authorizationEpoch: 0n } } })).ok).toBe(true);
    const revoked = await verifyLogin({ ...request, expect: { pocket: { ...pocket, authorizationEpoch: 1n } } });
    expect(revoked).toMatchObject({ ok: false, reason: expect.stringMatching(/revocation epoch/) });
    expect((await verifyLogin({ ...request, expect: { pocket: { ...pocket, authorizationEpoch: -1n } } })).ok).toBe(false);
    const mutated = [...f.publicSignals];
    mutated[11] = "0";
    // Clearing the context cannot turn a spending proof into a login proof.
    expect((await verifyLogin({ ...request, publicSignals: mutated })).ok).toBe(false);
  });

  it("accepts the fixture proof for its domain, session and home", async () => {
    const res = await verifyLogin({
      ...base(),
      expect: {
        holdsAtLeast: { mintHi: pub.mint_hi, mintLo: pub.mint_lo, threshold: 100_000_000n },
        minSlot: BigInt(pub.min_slot),
        session: { key32: sessionKey32, expirySlot, currentSlot: expirySlot - 10n },
        home: hexToBytes(vectors.identity.homeAddress),
      },
    });
    expect(res.reason).toBeUndefined();
    expect(res.ok).toBe(true);
    expect(res.appId).toBe(vectors.identity.appId);
  });

  it("refuses a holdings gate without a freshness bound, and enforces the bound it is given", async () => {
    // The census only grows: with no bound, this snapshot would pass forever.
    const holdsAtLeast = { mintHi: pub.mint_hi, mintLo: pub.mint_lo, threshold: 100_000_000n };
    expect(await verifyLogin({ ...base(), expect: { holdsAtLeast } })).toEqual({
      ok: false, reason: "holdings claim needs a freshness bound: set expect.minSlot (0n accepts snapshots of any age)",
    });
    // 0n is the deliberate "any age" opt-out.
    expect(await verifyLogin({ ...base(), expect: { holdsAtLeast, minSlot: 0n } })).toMatchObject({ ok: true });
    expect(await verifyLogin({ ...base(), expect: { holdsAtLeast, minSlot: BigInt(pub.min_slot) } })).toMatchObject({ ok: true });
    expect(await verifyLogin({ ...base(), expect: { holdsAtLeast, minSlot: BigInt(pub.min_slot) + 1n } }))
      .toEqual({ ok: false, reason: "snapshot window too old" });
    // A gate the server did not ask for needs no bound: plain login is unaffected.
    expect(await verifyLogin(base())).toMatchObject({ ok: true });
  });

  it("blames server configuration, not the proof, when the verifying key cannot be loaded", async () => {
    // As if a broken build had produced no key; a wrong key type is the caller's version of it.
    vi.doMock("../src/login-vk.js", () => ({ LOGIN_VERIFICATION_KEY: undefined }));
    vi.resetModules();
    try {
      const fresh = await import("../src/index.js");
      expect(() => fresh.bundledLoginVerificationKey()).toThrow(/login_vk/);
      for (const verificationKey of [undefined, "keys/login_vk.json" as never]) {
        const res = await fresh.verifyLogin({ ...base(), verificationKey });
        expect(res.ok).toBe(false);
        expect(res.reason).toMatch(/^login verifying key unavailable \(server configuration\)/);
      }
      // Passing the key explicitly is the fix for such deployments.
      const verificationKey = JSON.parse(readFileSync(vkPath, "utf8"));
      expect(await fresh.verifyLogin({ ...base(), verificationKey })).toMatchObject({ ok: true });
    } finally {
      vi.doUnmock("../src/login-vk.js");
      vi.resetModules();
    }
  });

  it("loads without snarkjs and blames the server when snarkjs cannot load", async () => {
    // snarkjs is imported on first use, so the module, the challenge check and
    // every refusal before the proof check work wherever snarkjs cannot load.
    vi.doMock("snarkjs", () => { throw new Error("URL.createObjectURL is not a function"); });
    vi.resetModules();
    try {
      const fresh = await import("../src/index.js");
      expect(await fresh.verifyLogin({ ...base(), expectedDomain: "https://other.example" }))
        .toEqual({ ok: false, reason: "proof bound to a different domain" });
      const res = await fresh.verifyLogin(base());
      expect(res.ok).toBe(false);
      expect(res.reason).toMatch(/^proof verifier unavailable on this runtime \(server configuration\): snarkjs failed to load: /);
      vi.doUnmock("snarkjs");
      // A failed import is not cached: the next call loads snarkjs and verifies.
      expect(await fresh.verifyLogin(base())).toMatchObject({ ok: true });
    } finally {
      vi.doUnmock("snarkjs");
      vi.resetModules();
    }
  });

  it("reports a runtime that forbids compiling WebAssembly as server configuration", async () => {
    // Vercel Edge and Cloudflare Workers refuse WebAssembly.compile on bytes,
    // which snarkjs needs to build its curve. Drop the cached curve so that
    // snarkjs builds a new one under that restriction.
    const global = globalThis as { curve_bn128?: unknown };
    const cached = global.curve_bn128;
    global.curve_bn128 = null;
    const compile = vi.spyOn(WebAssembly, "compile").mockRejectedValue(
      new WebAssembly.CompileError("WebAssembly.compile(): Wasm code generation disallowed by embedder"),
    );
    try {
      const res = await verifyLogin(base());
      expect(compile).toHaveBeenCalled();
      expect(res.ok).toBe(false);
      expect(res.reason).toMatch(/^proof verifier unavailable on this runtime \(server configuration\): .*disallowed by embedder/);
    } finally {
      compile.mockRestore();
      global.curve_bn128 = cached;
    }
    expect(await verifyLogin(base())).toMatchObject({ ok: true });
  });

  it("verifies the session-signed challenge for the key the proof is bound to", async () => {
    const nonce = new Uint8Array(32).fill(19);
    // softwareSession(seed).sign(digest) in the SDK is exactly ed25519.sign(digest, seed).
    const signature = ed25519.sign(loginChallengeDigest(nonce), hexToBytes(vectors.identity.sessionSeed));
    const session = { key32: sessionKey32, expirySlot, currentSlot: expirySlot - 10n };
    expect(await verifyLogin({ ...base(), expect: { session } })).toMatchObject({ ok: true });
    expect(verifyLoginChallenge({ key32: session.key32, nonce, signature })).toBe(true);
  });

  it("rejects the proof for another domain", async () => {
    const res = await verifyLogin({ ...base(), expectedDomain: "https://evil.example.com" });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("different domain");
  });

  it("rejects unknown roots and refuses to run without a root source", async () => {
    const unknown = await verifyLogin({
      ...base(),
      roots: async () => ({ registry: ["1"], census: ["2"] }),
    });
    expect(unknown.ok).toBe(false);
    expect(unknown.reason).toContain("unknown registry root");

    const none = await verifyLogin({ ...base(), roots: undefined });
    expect(none.ok).toBe(false);
    expect(none.reason).toContain("no root source");
  });

  it("rejects a captured proof presented with another session key, and after expiry", async () => {
    const other = ed25519.getPublicKey(new Uint8Array(32).fill(9));
    const wrongKey = await verifyLogin({
      ...base(),
      expect: { session: { key32: other, expirySlot, currentSlot: expirySlot - 10n } },
    });
    expect(wrongKey.ok).toBe(false);
    expect(wrongKey.reason).toContain("different session key");

    const expired = await verifyLogin({
      ...base(),
      expect: { session: { key32: sessionKey32, expirySlot, currentSlot: expirySlot } },
    });
    expect(expired.ok).toBe(false);
    expect(expired.reason).toContain("expired");
  });

  it("returns one canonical app id however the signal is spelled", async () => {
    const f = fx();
    const padded = [...f.publicSignals];
    padded[3] = "0" + padded[3];
    const res = await verifyLogin({ ...base(), publicSignals: padded });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("malformed");
    const hex = [...f.publicSignals];
    hex[3] = "0x" + BigInt(hex[3]!).toString(16);
    expect((await verifyLogin({ ...base(), publicSignals: hex })).ok).toBe(false);
  });

  it("treats minSlot without a holdings claim as an error, not a pass", async () => {
    const f = fx();
    const signals = [...f.publicSignals];
    signals[10] = "0"; // claim off (the proof no longer verifies either way)
    const res = await verifyLogin({ ...base(), publicSignals: signals, expect: { minSlot: 1n } });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("meaningless");
  });

  it("rejects a tampered proof and malformed input without throwing", async () => {
    const f = fx();
    const tampered = JSON.parse(JSON.stringify(f.proof));
    tampered.pi_a[0] = "1";
    expect((await verifyLogin({ ...base(), proof: tampered })).ok).toBe(false);
    expect((await verifyLogin({ ...base(), proof: { nonsense: true } })).ok).toBe(false);
    expect((await verifyLogin({ ...base(), publicSignals: ["1e3"] })).ok).toBe(false);
  });

  it("fails closed for malformed request shapes and field-sized slot aliases", async () => {
    for (const publicSignals of [undefined, null, {}, "not-an-array", ["9".repeat(100_000)]]) {
      await expect(verifyLogin({ ...base(), publicSignals: publicSignals as never })).resolves.toMatchObject({ ok: false });
    }
    await expect(verifyLogin(null as never)).resolves.toMatchObject({ ok: false });
    const invalidRequirement = await verifyLogin({
      ...base(), expect: { holdsAtLeast: { mintHi: pub.mint_hi, mintLo: pub.mint_lo, threshold: NaN as never } },
    });
    expect(invalidRequirement).toMatchObject({ ok: false, reason: "expected threshold must be a u64 bigint" });
    const fieldPrime = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
    // Poseidon reduces its inputs. An expiry plus p has the same commitment,
    // but is not a real chain slot and must not revive an old session.
    const result = await verifyLogin({
      ...base(), expect: { session: { key32: sessionKey32, expirySlot: expirySlot + fieldPrime, currentSlot: expirySlot + fieldPrime - 1n } },
    });
    expect(result).toMatchObject({ ok: false, reason: "session slots must be u64 bigints" });
  });
});

describe("verifyLoginChallenge", () => {
  const seed = hexToBytes(vectors.identity.sessionSeed);
  const key32 = ed25519.getPublicKey(seed);
  const nonce = new Uint8Array(32).fill(19);
  // What the SDK's softwareSession(seed).sign(loginChallengeDigest(nonce)) returns.
  const signature = ed25519.sign(loginChallengeDigest(nonce), seed);

  it("accepts the session key's signature over the documented digest", () => {
    // The wire format other clients must reproduce, computed independently.
    const digest = createHash("sha256").update("ghostlink:login-challenge:v1").update(nonce).digest();
    expect(bytesToHex(loginChallengeDigest(nonce))).toBe(digest.toString("hex"));
    expect(bytesToHex(key32)).toBe(vectors.identity.sessionPubkey);
    expect(verifyLoginChallenge({ key32, nonce, signature })).toBe(true);
    expect(verifyLoginChallenge({ key32: Buffer.from(key32), nonce: Buffer.from(nonce), signature: Buffer.from(signature) })).toBe(true);
  });

  it("rejects another nonce, another key, another message and wrong sizes", () => {
    expect(verifyLoginChallenge({ key32, nonce: new Uint8Array(32).fill(20), signature })).toBe(false);
    expect(verifyLoginChallenge({ key32: ed25519.getPublicKey(new Uint8Array(32).fill(9)), nonce, signature })).toBe(false);
    // A signature over the bare nonce (an intent-style digest) is not a login.
    expect(verifyLoginChallenge({ key32, nonce, signature: ed25519.sign(nonce, seed) })).toBe(false);
    expect(verifyLoginChallenge({ key32, nonce, signature: signature.subarray(0, 63) })).toBe(false);
    expect(verifyLoginChallenge({ key32, nonce, signature: new Uint8Array([...signature, 0]) })).toBe(false);
    expect(verifyLoginChallenge({ key32: key32.subarray(0, 31), nonce, signature })).toBe(false);
    expect(verifyLoginChallenge({ key32, nonce: nonce.subarray(0, 16), signature })).toBe(false);
  });

  it("refuses small-order keys, for which anyone can sign anything", () => {
    const identityPoint = new Uint8Array(32);
    identityPoint[0] = 1;
    const forged = new Uint8Array(64); // R = identity, S = 0
    forged[0] = 1;
    // Permissive (ZIP-215) verification accepts this forgery for any message.
    expect(ed25519.verify(forged, loginChallengeDigest(nonce), identityPoint)).toBe(true);
    expect(verifyLoginChallenge({ key32: identityPoint, nonce, signature: forged })).toBe(false);
  });

  it("returns false for malformed input instead of throwing", () => {
    for (const input of [
      null, undefined, {}, "challenge", { key32: bytesToHex(key32), nonce, signature },
      { key32: Array.from(key32), nonce, signature }, { key32, nonce, signature: Array.from(signature) },
      { key32: new Uint8Array(32).fill(255), nonce, signature },
    ]) {
      expect(verifyLoginChallenge(input as never)).toBe(false);
    }
  });
});

describe("bundled verifying key", () => {
  it("compiles in exactly keys/login_vk.json, the file the package also exports", async () => {
    const { LOGIN_VERIFICATION_KEY } = await import("../src/login-vk.js");
    const shipped = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "keys", "login_vk.json"), "utf8"));
    // On a mismatch, rebuild: `pnpm --filter @ghostlink/verify build` regenerates src/login-vk.ts.
    expect(LOGIN_VERIFICATION_KEY).toEqual(shipped);
    expect(bundledLoginVerificationKey()).toEqual(shipped);
  });
});
