import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import { REGISTRY_PROGRAM_ID, bytesToHex, fieldToBytes32, hexToBytes, pk } from "@ghostlink/common";
import { buildRegistration, identityMessageBytes, registrationClusterTag } from "../src/index.js";

// Published development vectors, never a user identity.
const vectors = JSON.parse(readFileSync(new URL("../../common/fixtures/vectors.json", import.meta.url), "utf8"));
const identity = {
  secret: hexToBytes(vectors.identity.sBytes), sField: BigInt(vectors.identity.sField), commitment: BigInt(vectors.identity.commitment),
  deterministic: true, method: "signMessage" as const, withFactor: false,
};
const seed = hexToBytes(vectors.identity.walletSeed), wallet = hexToBytes(vectors.identity.walletPubkey);
const sign = async (message: Uint8Array) => ed25519.sign(message, seed);

/**
 * `canonical_message` in programs/registry/src/lib.rs. `CLUSTER` is "mainnet-beta" in the
 * `mainnet` feature build and "devnet" in the default build, which a local validator runs.
 */
const registryAccepts = (cluster: "devnet" | "mainnet-beta") =>
  `ghostlink:register:v1\ncommitment:${bytesToHex(fieldToBytes32(identity.commitment))}` +
  `\nwallet:${vectors.identity.walletBase58}\nprogram:${REGISTRY_PROGRAM_ID}\ncluster:${cluster}`;

describe("registration message", () => {
  it("signs exactly the text each registry build accepts, so localnet registration is not rejected", async () => {
    for (const [cluster, tag] of [["localnet", "devnet"], ["devnet", "devnet"], ["mainnet-beta", "mainnet-beta"]] as const) {
      const { message, signature } = await buildRegistration(identity, wallet, pk(REGISTRY_PROGRAM_ID), cluster, sign);
      expect(registrationClusterTag(cluster)).toBe(tag);
      expect(new TextDecoder().decode(message), cluster).toBe(registryAccepts(tag));
      expect(ed25519.verify(signature, message, wallet)).toBe(true);
    }
    // The very bytes the Rust flow tests replay against the registry program.
    const local = await buildRegistration(identity, wallet, pk(REGISTRY_PROGRAM_ID), "localnet", sign);
    expect(bytesToHex(local.message)).toBe(vectors.registration.messageHex);
    expect(() => registrationClusterTag("testnet" as never)).toThrow(/unknown cluster/);
    await expect(buildRegistration(identity, wallet.subarray(0, 31), pk(REGISTRY_PROGRAM_ID), "localnet", sign)).rejects.toThrow(/32-byte/);
  });

  it("keeps the identity sign-in text on the real cluster name", () => {
    const text = new TextDecoder().decode(identityMessageBytes({ cluster: "localnet", domain: "app.ghostlink.test", address: vectors.identity.walletBase58 }));
    expect(text).toContain("\nChain ID: localnet");
  });
});
