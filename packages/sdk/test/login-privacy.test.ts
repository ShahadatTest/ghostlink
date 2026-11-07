import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { IncrementalTree, commitment, conservativePolicy, homeHash, registryLeaf, secretToField } from "@ghostlink/common";
import { GhostLink, sessionPublicKey, softwareSession, type CircuitInput } from "../src/index.js";

const fixture = JSON.parse(readFileSync(new URL("../../../circuits/keys/login_proof.json", import.meta.url), "utf8"));

async function setup() {
  const secret = new Uint8Array(32).fill(2), sField = secretToField(secret);
  const identity = { secret, sField, commitment: commitment(sField), deterministic: true, method: "signMessage" as const, withFactor: false };
  const wallet = new Uint8Array(32).fill(3);
  const tree = new IncrementalTree();
  tree.append(registryLeaf(wallet, identity.commitment));
  const inputs: CircuitInput[] = [];
  const prover = { prove: vi.fn(async (_circuit: string, input: CircuitInput) => { inputs.push(input); return structuredClone(fixture); }) };
  const client = await GhostLink.init({ cluster: "localnet", indexer: "https://indexer.test", origin: "https://app.test", prover });
  const params = { identity, expirySlot: 10n, witness: { registry: { walletPubkey: wallet, ...tree.path(0), root: tree.root } } };
  return { client, params, prover, inputs, wallet };
}

describe("login proof privacy", () => {
  it("binds 32 zero bytes, never the public wallet, as home in a login-only proof", async () => {
    const { client, params, prover, inputs, wallet } = await setup();
    await client.prove(params);
    expect(inputs[0]!.home_hash).toBe(homeHash(new Uint8Array(32)).toString());
    expect(inputs[0]!.authorization_context).toBe("0");
    // A verifier could hash every registered wallet and find this one.
    await expect(client.prove({ ...params, home: wallet })).rejects.toThrow(/must not bind the wallet/);
    expect(prover.prove).toHaveBeenCalledOnce();
  });

  it("requires an explicit home for a pocket authorization", async () => {
    const { client, params, prover, inputs, wallet } = await setup();
    await expect(client.prove({ ...params, policy: conservativePolicy() })).rejects.toThrow(/explicit home/);
    const session = sessionPublicKey(0, softwareSession().key32);
    await expect(client.authorizeSession({ ...params, session, policy: conservativePolicy() } as never)).rejects.toThrow(/explicit home/);
    expect(prover.prove).not.toHaveBeenCalled();
    // A pocket's home is published on-chain anyway, so the wallet stays a valid explicit choice there.
    await client.prove({ ...params, home: wallet, policy: conservativePolicy() });
    expect(inputs[0]!.home_hash).toBe(homeHash(wallet).toString());
  });
});
