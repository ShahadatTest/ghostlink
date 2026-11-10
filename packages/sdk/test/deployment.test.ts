import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { sha256 } from "@noble/hashes/sha256";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  CENSUS_PROGRAM_ID, DeploymentError, LOCALNET_DEPLOYMENT, POCKET_PROGRAM_ID, PUBLIC_GENESIS_HASHES, REGISTRY_PROGRAM_ID,
  hexToBytes, pk, pocketPda, toBase58, type DeploymentManifest,
} from "@ghostlink/common";
import {
  GhostLink, createGhostLinkWallet, derivePocket, prepareFundingTransaction, recoverPockets, resolveDeployment,
  sessionPublicKey, softwareSession,
} from "../src/index.js";
import { canonicalBotDeployment } from "../src/applications.js";
import { fixturePolicy } from "./fixture-policy.js";

// Published development vectors and proofs, never a user identity or bot key.
const vectors = JSON.parse(readFileSync(new URL("../../common/fixtures/vectors.json", import.meta.url), "utf8"));
const proofFor = (name: string) => JSON.parse(readFileSync(new URL(`../../../circuits/keys/${name}_proof.json`, import.meta.url), "utf8"));
const fx = vectors.circuits.login;
const DEVNET = PUBLIC_GENESIS_HASHES.devnet;
const address = (byte: number) => toBase58(new Uint8Array(32).fill(byte));
const devnet: DeploymentManifest = { version: 1, cluster: "devnet", genesisHash: DEVNET, registryProgram: address(1),
  censusProgram: address(2), pocketProgram: address(3), verifyingKeys: { ...LOCALNET_DEPLOYMENT.verifyingKeys } };
// circuits/scripts/prove-fixtures.mjs proves login_other_deployment for this pocket program and the built-in registry and census.
const otherPocket = toBase58(sha256(new TextEncoder().encode("ghostlink vector: other pocket program")));
const other: DeploymentManifest = { ...LOCALNET_DEPLOYMENT, verifyingKeys: { ...LOCALNET_DEPLOYMENT.verifyingKeys }, pocketProgram: otherPocket };

async function authorize(client: GhostLink) {
  const home = hexToBytes(vectors.identity.homeAddress), policy = fixturePolicy();
  const claim = { kind: "holdsAtLeast" as const, mint: hexToBytes(vectors.census.mint), amount: BigInt(fx.public.threshold), maxAgeSlots: 9000n };
  const authorization = await client.authorizeSession({
    identity: { secret: hexToBytes(vectors.identity.sBytes), sField: BigInt(vectors.identity.sField),
      commitment: BigInt(vectors.identity.commitment), deterministic: true, method: "signMessage", withFactor: false },
    session: sessionPublicKey(0, softwareSession(hexToBytes(vectors.identity.sessionSeed)).key32),
    claim, minSlot: BigInt(fx.public.min_slot), expirySlot: BigInt(vectors.identity.expirySlot), home, policy,
    witness: {
      registry: { walletPubkey: hexToBytes(vectors.identity.walletPubkey), index: Number(fx.private.reg_index), siblings: fx.private.reg_siblings.map(BigInt), root: BigInt(fx.public.registry_root) },
      census: { index: Number(fx.private.cen_index), siblings: fx.private.cen_siblings.map(BigInt), root: BigInt(fx.public.census_root), amount: BigInt(vectors.census.amount), slot: BigInt(vectors.census.slot) },
    },
  });
  return { authorization, home, policy };
}

describe("GhostLink deployments", () => {
  it("keeps localnet without a manifest exactly as before", async () => {
    const client = await GhostLink.init({ cluster: "localnet", indexer: "http://localhost:8787" });
    expect(client.deployment).toBe(LOCALNET_DEPLOYMENT);
    expect(resolveDeployment("localnet")).toBe(LOCALNET_DEPLOYMENT);
  });

  it("allows a public cluster only with its own valid manifest, before contacting any service", async () => {
    const fetchFn = vi.fn();
    const init = (cluster: "devnet" | "mainnet-beta" | "localnet", deployment?: unknown) =>
      GhostLink.init({ cluster, deployment: deployment as DeploymentManifest, indexer: "https://indexer.test", fetchFn });
    for (const cluster of ["devnet", "mainnet-beta"] as const) {
      await expect(init(cluster)).rejects.toThrow(new RegExp(`${cluster} requires an explicit deployment manifest.*preserved V1`));
    }
    await expect(init("devnet", { ...devnet, pocketProgram: POCKET_PROGRAM_ID })).rejects.toThrow(/pocketProgram uses a built-in program ID/);
    await expect(init("devnet", { ...LOCALNET_DEPLOYMENT, cluster: "devnet", genesisHash: DEVNET }))
      .rejects.toThrow(/registryProgram, censusProgram, pocketProgram uses a built-in program ID/);
    await expect(init("devnet", { ...devnet, genesisHash: undefined })).rejects.toThrow(/must name the devnet genesis/);
    await expect(init("devnet", { ...devnet, verifyingKeys: {} })).rejects.toThrow(/verifyingKeys/);
    await expect(init("devnet", "devnet")).rejects.toThrow(DeploymentError);
    await expect(init("mainnet-beta", devnet)).rejects.toThrow(/manifest is for devnet, not mainnet-beta/);
    await expect(init("localnet", devnet)).rejects.toThrow(/manifest is for devnet, not localnet/);
    expect(fetchFn).not.toHaveBeenCalled();
    const client = await init("devnet", devnet);
    expect(client.deployment).toEqual(devnet);
    expect(Object.isFrozen(client.deployment)).toBe(true);
  });

  it("derives pockets, funding and recovery addresses from the manifest's pocket program", async () => {
    const client = await GhostLink.init({ cluster: "devnet", deployment: devnet, indexer: "https://indexer.test",
      actions: "https://actions.test" });
    const appId = BigInt(vectors.identity.appId), home = new Uint8Array(32).fill(4);
    const custom = pocketPda(appId, pk(devnet.pocketProgram)).address;
    expect(custom).not.toEqual(pocketPda(appId).address);
    const pocket = derivePocket(appId, home, undefined, devnet);
    expect(pocket.address).toEqual(custom);
    expect(client.funding(pocket).address).toBe(toBase58(custom));
    // A handle derived for another deployment is refused instead of funding the wrong address.
    expect(() => client.funding(derivePocket(appId, home))).toThrow(/does not match app id/);
    expect(recoverPockets(BigInt(vectors.identity.sField), ["https://a.example"], devnet)[0]!.pocketAddress)
      .not.toEqual(recoverPockets(BigInt(vectors.identity.sField), ["https://a.example"])[0]!.pocketAddress);
    const wallet = new PublicKey(new Uint8Array(32).fill(7));
    const tx = new Transaction({ feePayer: wallet, recentBlockhash: address(8) }).add(SystemProgram.transfer({
      fromPubkey: wallet, toPubkey: new PublicKey(custom), lamports: 5n }));
    const bytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    const approval = { appId, funder: wallet.toBytes(), asset: { kind: "sol" as const, lamports: 5n }, recentBlockhash: new Uint8Array(32).fill(9) };
    expect(() => prepareFundingTransaction(bytes, approval)).toThrow(/funding/);
    expect(prepareFundingTransaction(bytes, { ...approval, deployment: devnet })).toBeInstanceOf(Uint8Array);
  });

  it("binds the manifest's program IDs into authorizations and checks real proofs against them", async () => {
    // The committed other-deployment proof was made for `other`'s program IDs.
    const prover = (name: string) => ({ prove: vi.fn(async () => structuredClone(proofFor(name))) });
    const forOther = await GhostLink.init({ cluster: "localnet", deployment: other, indexer: "https://indexer.test",
      origin: vectors.identity.origin, prover: prover("login_other_deployment") });
    const { authorization, home, policy } = await authorize(forOther);
    const input = (forOther.config.prover!.prove as ReturnType<typeof vi.fn>).mock.calls[0]![1] as Record<string, string>;
    expect(input.authorization_context).toBe(proofFor("login_other_deployment").publicSignals[11]);
    expect(forOther.pocketFor(authorization, home, policy).address).toEqual(pocketPda(authorization.appId, pk(otherPocket)).address);
    // The built-in deployment refuses that proof, and the other deployment refuses the built-in one.
    const builtin = await GhostLink.init({ cluster: "localnet", indexer: "https://indexer.test",
      origin: vectors.identity.origin, prover: prover("login") });
    expect(() => builtin.pocketFor(authorization, home, policy)).toThrow(/deployment/);
    const fromBuiltin = (await authorize(builtin)).authorization;
    expect(builtin.pocketFor(fromBuiltin, home, policy).address).toEqual(pocketPda(fromBuiltin.appId).address);
    expect(() => forOther.pocketFor(fromBuiltin, home, policy)).toThrow(/deployment/);
  });

  it("advertises the deployment's chain and pocket in the wallet standard facade", () => {
    const login = async () => { throw new Error("not called"); };
    expect(createGhostLinkWallet({ login, deployment: devnet }).chains).toEqual(["solana:devnet"]);
    expect(createGhostLinkWallet({ login, chain: "solana:devnet", deployment: devnet }).chains).toEqual(["solana:devnet"]);
    expect(() => createGhostLinkWallet({ login, chain: "solana:mainnet", deployment: devnet })).toThrow(/for devnet, not mainnet-beta/);
    expect(() => createGhostLinkWallet({ login, chain: "solana:devnet" })).toThrow(/explicit deployment manifest/);
    expect(() => createGhostLinkWallet({ login, chain: "solana:testnet" as never })).toThrow(/unsupported wallet chain/);
  });

  it("applies the same rule to bot consent deployments", () => {
    const bot = { cluster: "devnet", genesisHash: DEVNET, pocketProgram: devnet.pocketProgram,
      registryProgram: devnet.registryProgram, censusProgram: devnet.censusProgram };
    expect(canonicalBotDeployment(bot)).toEqual(bot);
    const localGenesis = address(5);
    const builtin = { cluster: "localnet", genesisHash: localGenesis, pocketProgram: POCKET_PROGRAM_ID,
      registryProgram: REGISTRY_PROGRAM_ID, censusProgram: CENSUS_PROGRAM_ID };
    expect(canonicalBotDeployment(builtin)).toEqual(builtin);
    expect(() => canonicalBotDeployment({ ...builtin, cluster: "devnet", genesisHash: DEVNET })).toThrow(/built-in program ID/);
    expect(() => canonicalBotDeployment({ ...builtin, genesisHash: DEVNET })).toThrow(/localnet deployment cannot name the devnet genesis/);
    expect(() => canonicalBotDeployment({ ...bot, genesisHash: localGenesis })).toThrow(/not the devnet genesis/);
  });
});
