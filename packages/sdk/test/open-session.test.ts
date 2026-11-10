import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import bs58 from "bs58";
import { bytesToHex, fieldToBytes32, hexToBytes } from "@ghostlink/common";
import {
  GhostLink, RelayerOperationFailedError, RelayerOperationPendingError, sessionPublicKey, softwareSession,
} from "../src/index.js";
import { fixturePolicy } from "./fixture-policy.js";

// Published development vectors and proof, never a user identity or bot key.
const vectors = JSON.parse(readFileSync(new URL("../../common/fixtures/vectors.json", import.meta.url), "utf8"));
const fixture = JSON.parse(readFileSync(new URL("../../../circuits/keys/login_proof.json", import.meta.url), "utf8"));
const fx = vectors.circuits.login;
const signature = "1".repeat(64);

async function authorized(reply: (requestIdHex: string) => Response) {
  const fetchFn = vi.fn(async (_url: unknown, init?: RequestInit) => reply(JSON.parse(String(init?.body)).requestIdHex));
  const client = await GhostLink.init({ cluster: "localnet", indexer: "https://indexer.test", relayer: "https://relayer.test",
    origin: vectors.identity.origin, prover: { prove: async () => structuredClone(fixture) }, fetchFn });
  const home = hexToBytes(vectors.identity.homeAddress), policy = fixturePolicy(), minSlot = BigInt(fx.public.min_slot);
  const claim = { kind: "holdsAtLeast" as const, mint: hexToBytes(vectors.census.mint), amount: BigInt(fx.public.threshold), maxAgeSlots: 9000n };
  const authorization = await client.authorizeSession({
    identity: { secret: hexToBytes(vectors.identity.sBytes), sField: BigInt(vectors.identity.sField),
      commitment: BigInt(vectors.identity.commitment), deterministic: true, method: "signMessage", withFactor: false },
    session: sessionPublicKey(0, softwareSession(hexToBytes(vectors.identity.sessionSeed)).key32),
    claim, minSlot, expirySlot: BigInt(vectors.identity.expirySlot), home, policy,
    witness: {
      registry: { walletPubkey: hexToBytes(vectors.identity.walletPubkey), index: Number(fx.private.reg_index), siblings: fx.private.reg_siblings.map(BigInt), root: BigInt(fx.public.registry_root) },
      census: { index: Number(fx.private.cen_index), siblings: fx.private.cen_siblings.map(BigInt), root: BigInt(fx.public.census_root), amount: BigInt(vectors.census.amount), slot: BigInt(vectors.census.slot) },
    },
  });
  const claimFields = { mint: claim.mint, threshold: claim.amount, minSlot, claim: true };
  return { client, authorization, pocket: client.pocketFor(authorization, home, policy), claimFields, fetchFn };
}

describe("openSession receipts", () => {
  it("reports a final on-chain failure as failed, not as a pending operation worth retrying", async () => {
    const { client, authorization, pocket, claimFields, fetchFn } = await authorized((requestIdHex) =>
      Response.json({ requestIdHex, state: "failed", signature, slot: 50, confirmationStatus: "finalized" }, { status: 502 }));
    const first = await client.openSession(authorization, pocket, claimFields).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(RelayerOperationFailedError);
    expect(first).not.toBeInstanceOf(RelayerOperationPendingError);
    expect(first).toMatchObject({ name: "RelayerOperationFailedError", receipt: { state: "failed", signature } });
    // A retry reuses the deterministic request ID, so it can only replay the same failure.
    const again = await client.openSession(authorization, pocket).catch((e: unknown) => e);
    expect(again).toBeInstanceOf(RelayerOperationFailedError);
    expect((again as RelayerOperationFailedError).operation.requestIdHex).toBe((first as RelayerOperationFailedError).operation.requestIdHex);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("keeps unknown outcomes pending", async () => {
    for (const state of ["preparing", "pending", "unknown"] as const) {
      const { client, authorization, pocket, claimFields } = await authorized((requestIdHex) =>
        Response.json({ requestIdHex, state, ...(state === "pending" && { signature }) }, { status: 202 }));
      const error = await client.openSession(authorization, pocket, { timeoutMs: 0 }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RelayerOperationPendingError);
      expect(error).toMatchObject({ receipt: { state } });
    }
  });

  it("refuses claim fields, roots, domain hash or expiry that differ from the proof before contacting the relayer", async () => {
    const { client, authorization, pocket, claimFields, fetchFn } = await authorized((requestIdHex) =>
      Response.json({ requestIdHex, state: "confirmed", signature, slot: 50, confirmationStatus: "confirmed" }));
    const roots = { registry: BigInt(fixture.publicSignals[0]), census: BigInt(fixture.publicSignals[1]) };
    const domain = BigInt(fixture.publicSignals[2]);
    const open = (fields: typeof claimFields | null = claimFields, r?: typeof roots, d?: bigint, session = authorization) =>
      client.openSession(session, pocket, { claim: fields, roots: r, domainHash: d });
    for (const mismatched of [
      () => open({ ...claimFields, mint: new Uint8Array(32).fill(1) }), () => open({ ...claimFields, threshold: claimFields.threshold + 1n }),
      () => open({ ...claimFields, minSlot: claimFields.minSlot - 1n }), () => open({ ...claimFields, claim: false }), () => open(null),
      () => open(claimFields, { ...roots, registry: roots.registry + 1n }), () => open(claimFields, { ...roots, census: 1n }),
      () => open(claimFields, roots, domain + 1n), () => open(claimFields, roots, domain, { ...authorization, expirySlot: authorization.expirySlot + 1n }),
    ]) {
      await expect(mismatched()).rejects.toThrow(/public signals/);
    }
    expect(fetchFn).not.toHaveBeenCalled();
    // Values equal to the proved ones, given or omitted, are accepted.
    // The deprecated 0.1 positional form still works.
    await expect(client.openSession(authorization, pocket, claimFields, roots, domain)).resolves.toEqual({ signature });
    await expect(client.openSession(authorization, pocket, { claim: { mint: claimFields.mint, threshold: claimFields.threshold, minSlot: claimFields.minSlot }, roots, domainHash: domain }))
      .resolves.toEqual({ signature });
    // Nothing to restate: every relayed value is read from the proof.
    await expect(client.openSession(authorization, pocket)).resolves.toEqual({ signature });
    const sent = JSON.parse(String(fetchFn.mock.calls.at(-1)![1]!.body));
    expect(sent).toMatchObject({ mint: bs58.encode(claimFields.mint), threshold: claimFields.threshold.toString(), minSlot: claimFields.minSlot.toString(), claimHoldings: true,
      registryRootHex: bytesToHex(fieldToBytes32(roots.registry)), domainHashHex: bytesToHex(fieldToBytes32(domain)) });
  });
});
