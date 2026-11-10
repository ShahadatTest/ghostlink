/**
 * The SDK builds instructions without web3.js for apps that send their own
 * transactions. The services' builders are the ones the program integration
 * tests and the local validator journey prove on chain, so the SDK's must
 * match them byte for byte.
 */
import { describe, expect, it } from "vitest";
import { Keypair, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import { conservativePolicy, fieldToBytes32, type Policy } from "@ghostlink/common";
import { GhostLink, associatedTokenAddress, pocketChangeBorsh, type GhostLinkInstruction, type OwnerAuthorization } from "@ghostlink/sdk";
import {
  ataAddress, cancelChangeIx, computeBudget, ed25519Ix, executeChangeIx, proposeChangeIx, registerIx, revokeSessionIx,
  snapshotIx, sweepHomeIx,
} from "@ghostlink/service-kit";

const key = () => Keypair.generate().publicKey;
const bytes = (n: number, fill: number) => new Uint8Array(n).fill(fill);
const same = (sdk: GhostLinkInstruction, kit: TransactionInstruction) => {
  expect(new PublicKey(sdk.programId).toBase58()).toBe(kit.programId.toBase58());
  expect(sdk.keys.map(k => ({ ...k, pubkey: new PublicKey(k.pubkey).toBase58() })))
    .toEqual(kit.keys.map(k => ({ ...k, pubkey: k.pubkey.toBase58() })));
  expect(Buffer.from(sdk.data).toString("hex")).toBe(Buffer.from(kit.data).toString("hex"));
};

describe("SDK instructions match the services' on-chain-tested builders", async () => {
  const client = await GhostLink.init({ cluster: "localnet", indexer: "http://127.0.0.1:1", origin: "https://app.example.test",
    chain: { getGenesisHash: async () => "11111111111111111111111111111111", getSlot: async () => 1n, getAccount: async () => null } });
  const payer = key(), pocket = key(), home = key();
  const proof = { a: bytes(64, 1), b: bytes(128, 2), c: bytes(64, 3) };
  const registryRoot = 12345n;
  const kitProof = { proofA: proof.a, proofB: proof.b, proofC: proof.c, registryRoot: fieldToBytes32(registryRoot) };
  const authorization = (action: OwnerAuthorization["action"], extra: Partial<OwnerAuthorization> = {}): OwnerAuthorization =>
    ({ action, pocket: pocket.toBytes(), appId: 1n, ownerActionNonce: 0n, registryRoot, proof, ...extra });
  const policy: Policy = { ...conservativePolicy(), allowedOutMints: [bytes(32, 4)],
    oracleFeeds: [{ mint: bytes(32, 4), feedId: bytes(32, 5), decimals: 6 }],
    speculative: { dailyBuyCapUsdE6: 3n, maxCostExposureUsdE6: 2n, maxPositions: 1, baseMints: [bytes(32, 4)] } };

  it("registration and snapshot", async () => {
    const seed = bytes(32, 9), wallet = new PublicKey(ed25519.getPublicKey(seed));
    const identity = { secret: bytes(32, 1), sField: 5n, commitment: 77n, deterministic: true, method: "signMessage" as const, withFactor: false };
    const [verify, register] = await client.registerInstructions({ identity, wallet: wallet.toBytes(), payer: payer.toBytes(),
      signMessage: async (m) => ed25519.sign(m, seed) });
    const message = verify!.data.subarray(16 + 32 + 64);
    same(verify!, ed25519Ix(wallet.toBytes(), ed25519.sign(message, seed), message));
    same(register!, registerIx(payer, wallet, fieldToBytes32(77n)));
    const mint = key();
    same((await client.snapshotInstructions({ payer: payer.toBytes(), wallet: wallet.toBytes(), mint: mint.toBytes(), maxFeeLamports: 100_000n }))[0]!,
      snapshotIx(payer, wallet, ataAddress(wallet, mint), 100_000n));
    expect(new PublicKey(associatedTokenAddress(wallet.toBytes(), mint.toBytes())).equals(ataAddress(wallet, mint))).toBe(true);
  });

  it("owner actions and the permissionless execute crank", () => {
    const pairs = [{ source: key(), destination: key() }, { source: key(), destination: key() }];
    const [budget, sweep] = client.ownerActionInstructions(authorization("sweep", { home: home.toBytes() }),
      { payer: payer.toBytes(), tokenPairs: pairs.map(p => ({ source: p.source.toBytes(), destination: p.destination.toBytes() })) });
    same(budget!, computeBudget(400_000));
    same(sweep!, sweepHomeIx({ payer, pocket, home, auth: kitProof, tokenPairs: pairs }));
    same(client.ownerActionInstructions(authorization("revoke"), { payer: payer.toBytes() })[1]!, revokeSessionIx({ payer, pocket, auth: kitProof }));
    const newHome = key();
    same(client.ownerActionInstructions(authorization("propose", { changeBorsh: pocketChangeBorsh({ home: newHome.toBytes() }) }), { payer: payer.toBytes() })[1]!,
      proposeChangeIx({ payer, pocket, change: { home: newHome }, proof: kitProof }));
    same(client.ownerActionInstructions(authorization("propose", { changeBorsh: pocketChangeBorsh({ policy }) }), { payer: payer.toBytes() })[1]!,
      proposeChangeIx({ payer, pocket, change: { policy }, proof: kitProof }));
    same(client.ownerActionInstructions(authorization("cancel"), { payer: payer.toBytes() })[1]!, cancelChangeIx({ payer, pocket, proof: kitProof }));
    same(client.executeChangeInstructions(pocket.toBytes(), payer.toBytes())[0]!, executeChangeIx(payer, pocket));
  });
});
