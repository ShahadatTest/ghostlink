import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import { hexToBytes, loginChallengeDigest, toBase58 } from "@ghostlink/common";
import {
  createGhostLinkWallet, deriveIdentity, proveLogin, signInMessageText, signInOutputToDto, softwareSession, type SolanaSignInInput,
} from "../src/index.js";
import { verifyLogin } from "../../verify/src/index.js";

// Published development vectors and proof, never a user identity.
const vectors = JSON.parse(readFileSync(new URL("../../common/fixtures/vectors.json", import.meta.url), "utf8"));
const fixture = JSON.parse(readFileSync(new URL("../../../circuits/keys/login_offchain_proof.json", import.meta.url), "utf8"));

describe("wallet standard", () => {
  it("advertises localnet by default and refuses public chains without a deployment manifest", () => {
    const login = async () => { throw new Error("not called"); };
    expect(createGhostLinkWallet({ login }).chains).toEqual(["solana:localnet"]);
    for (const chain of ["solana:devnet", "solana:mainnet"] as const) {
      expect(() => createGhostLinkWallet({ login, chain })).toThrow(/requires an explicit deployment manifest/);
    }
  });

  it("encodes the sign-in output as JSON a backend can decode and verify", async () => {
    const signer = softwareSession(hexToBytes(vectors.identity.sessionSeed));
    const proof = await proveLogin({ prove: async () => fixture }, {}, BigInt(vectors.identity.appId));
    const wallet = createGhostLinkWallet({ login: async () => ({
      appId: proof.appId, appIdBase58: "", proof, signer, expirySlot: BigInt(vectors.identity.expirySlot),
    }) });
    const challenge = new Uint8Array(32).fill(19);
    const output = await wallet.features["ghostlink:signIn"].signIn({ challenge });
    expect(() => JSON.stringify(output)).toThrow(/BigInt/);
    const wire = JSON.parse(JSON.stringify(signInOutputToDto(output)));
    expect(wire.account).toEqual({ address: output.account.address, chains: ["solana:localnet"] });
    const key32 = hexToBytes(wire.session.key32Hex), expirySlot = BigInt(wire.session.expirySlot);
    expect(ed25519.verify(hexToBytes(wire.challengeSignature.signatureHex), loginChallengeDigest(challenge), key32)).toBe(true);
    expect((await verifyLogin({
      proof: wire.proof, publicSignals: wire.publicSignals, expectedDomain: vectors.identity.origin,
      roots: async () => ({ registry: [fixture.publicSignals[0]], census: [fixture.publicSignals[1]] }),
      expect: { session: { key32, expirySlot, currentSlot: expirySlot - 1n } },
    })).ok).toBe(true);
  });

  it("derives the same identity through the raw solana:signIn feature, which resolves to an array", async () => {
    const seed = new Uint8Array(32).fill(7), address = toBase58(ed25519.getPublicKey(seed));
    const options = { cluster: "localnet" as const, domain: "app.ghostlink.test", address };
    const signMessage = async (message: Uint8Array) => ed25519.sign(message, seed);
    // Wallet Standard shape: variadic inputs, one output (with account) per input.
    const feature = async (...inputs: SolanaSignInInput[]) => inputs.map((input) => {
      const signedMessage = new TextEncoder().encode(signInMessageText(input));
      return { account: { address }, signedMessage, signature: ed25519.sign(signedMessage, seed), signatureType: "ed25519" as const };
    });
    const native = await deriveIdentity({ signMessage, signIn: feature }, options);
    expect(native.method).toBe("signIn");
    expect(native.secret).toEqual((await deriveIdentity(signMessage, options)).secret);
    const twice = async (input: SolanaSignInInput) => [...await feature(input), ...await feature(input)];
    await expect(deriveIdentity({ signMessage, signIn: twice }, options)).rejects.toThrow(/invalid sign-in result/);
  });
});
