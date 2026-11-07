/**
 * Recomputes every committed fixture from the library and compares. If this
 * fails, either the library logic changed (a protocol break — regenerate
 * vectors deliberately and flag it in review) or a refactor drifted.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "@noble/hashes/sha256";
import {
  secretToField,
  commitment,
  registryLeaf,
  censusLeaf,
  domainHash,
  appId,
  ownerTag,
  sessionCommitment,
  homeHash,
  zeroHashes,
  IncrementalTree,
  intentBytes,
  intentHash,
  policyHash,
  conservativePolicy,
  registrationMessage,
  frameOffchain,
  bytesToHex,
  hexToBytes,
  splitBytes32,
  hashToField,
  pocketPda,
  pythPushFeedAddress,
  bindingPda,
  registryTreePda,
  toBase58,
  pk,
  REGISTRY_PROGRAM_ID,
  ROOT_BUCKET_SLOTS,
  TREE_DEPTH,
  rootBucket,
  type Intent,
} from "../src/index.js";

const vectors = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "vectors.json"), "utf8"),
);

const label = (name: string) => sha256(new TextEncoder().encode(`ghostlink vector: ${name}`));
const sBytes = label("identity secret");
const walletPk = hexToBytes(vectors.identity.walletPubkey);
const mint = label("usdc mint");

describe("field encoding", () => {
  it("splits 32 bytes into hi/lo halves", () => {
    const { hi, lo } = splitBytes32(walletPk);
    expect(hi.toString()).toBe(vectors.field.split.hi);
    expect(lo.toString()).toBe(vectors.field.split.lo);
  });
  it("reduces a hash into the field", () => {
    expect(hashToField(sBytes).toString()).toBe(vectors.field.hashToField.out);
  });
});

describe("identity values", () => {
  const sField = secretToField(sBytes);
  const C = commitment(sField);
  const dHash = domainHash(vectors.identity.origin);

  it("commitment C = Poseidon(s, 0)", () => {
    expect(C.toString()).toBe(vectors.identity.commitment);
  });
  it("registry leaf", () => {
    expect(registryLeaf(walletPk, C).toString()).toBe(vectors.identity.registryLeaf);
  });
  it("domain hash, app id, owner tag", () => {
    expect(dHash.toString()).toBe(vectors.identity.domainHash);
    expect(appId(sField, dHash).toString()).toBe(vectors.identity.appId);
    expect(ownerTag(sField, dHash).toString()).toBe(vectors.identity.ownerTag);
  });
  it("wallet and session keys derive from their seeds", async () => {
    const { ed25519 } = await import("@noble/curves/ed25519");
    expect(bytesToHex(ed25519.getPublicKey(hexToBytes(vectors.identity.walletSeed)))).toBe(
      vectors.identity.walletPubkey,
    );
    expect(bytesToHex(ed25519.getPublicKey(hexToBytes(vectors.identity.sessionSeed)))).toBe(
      vectors.identity.sessionPubkey,
    );
  });
  it("session commitment and home hash", () => {
    expect(
      sessionCommitment(
        hexToBytes(vectors.identity.sessionPubkey),
        BigInt(vectors.identity.expirySlot),
      ).toString(),
    ).toBe(vectors.identity.sessionCommitment);
    expect(homeHash(label("home address")).toString()).toBe(vectors.identity.homeHash);
  });
  it("census leaf", () => {
    expect(
      censusLeaf(walletPk, mint, BigInt(vectors.census.amount), BigInt(vectors.census.slot)).toString(),
    ).toBe(vectors.census.leaf);
  });
});

describe("merkle tree", () => {
  it("zero constants and empty root", () => {
    const zeros = zeroHashes();
    expect(zeros.map((z) => z.toString())).toEqual(vectors.merkle.zeros);
    expect(zeros[TREE_DEPTH]!.toString()).toBe(vectors.merkle.emptyRoot);
  });
  it("roots after each append and a verified path", () => {
    const tree = new IncrementalTree();
    const leaves = vectors.merkle.appended.map(BigInt);
    const roots: string[] = [];
    for (const l of leaves) {
      tree.append(l);
      roots.push(tree.root.toString());
    }
    expect(roots).toEqual(vectors.merkle.rootsAfterEachAppend);
    const path = tree.path(1);
    expect(path.siblings.map((s) => s.toString())).toEqual(vectors.merkle.pathForLeaf1.siblings);
    expect(IncrementalTree.verify(leaves[1]!, path, tree.root)).toBe(true);
    expect(IncrementalTree.verify(leaves[0]!, path, tree.root)).toBe(false);
  });
  it("serves roots and paths of an older prefix, as a completed root bucket needs", () => {
    const tree = new IncrementalTree();
    const leaves = [11n, 12n, 13n, 14n, 15n, 16n, 17n];
    for (const leaf of leaves) tree.append(leaf);
    for (let size = 0; size <= leaves.length; size++) {
      const prefix = new IncrementalTree();
      for (const leaf of leaves.slice(0, size)) prefix.append(leaf);
      expect(tree.rootAt(size)).toBe(prefix.root);
      for (let i = 0; i < size; i++) {
        expect(tree.pathAt(i, size)).toEqual(prefix.path(i));
        expect(IncrementalTree.verify(leaves[i]!, tree.pathAt(i, size), prefix.root)).toBe(true);
      }
    }
    expect(() => tree.pathAt(3, 3)).toThrow(/no such leaf/);
    expect(() => tree.rootAt(leaves.length + 1)).toThrow(/size/);
  });
  it("places slots in 150-slot root buckets", () => {
    expect(ROOT_BUCKET_SLOTS).toBe(150);
    expect([0, 149, 150, 299, 300].map(slot => rootBucket(slot))).toEqual([0, 0, 1, 1, 2]);
    expect(rootBucket(123_456_789n)).toBe(823_045);
    expect(() => rootBucket(-1)).toThrow();
  });
});

describe("intent and policy", () => {
  it("refuses policy numbers that would silently encode a different value", () => {
    for (const invalid of [NaN, Infinity, 1.5]) {
      expect(() => policyHash({ ...conservativePolicy(), maxSlippageBps: invalid })).toThrow(/u16/);
      expect(() => policyHash({
        ...conservativePolicy(), oracleFeeds: [{ mint: new Uint8Array(32), feedId: new Uint8Array(32), decimals: invalid }],
      })).toThrow(/decimals/);
    }
  });
  it("policy hash", () => {
    expect(bytesToHex(policyHash(conservativePolicy()))).toBe(vectors.policy.hash);
  });
  it("canonical intent bytes and hash", () => {
    const f = vectors.intent.fields;
    const intent: Intent = {
      pocket: hexToBytes(f.pocket),
      nonce: BigInt(f.nonce),
      inMint: hexToBytes(f.inMint),
      inMax: BigInt(f.inMax),
      outMint: hexToBytes(f.outMint),
      outMin: BigInt(f.outMin),
      deadlineSlot: BigInt(f.deadlineSlot),
      policyHash: hexToBytes(f.policyHash),
    };
    expect(bytesToHex(intentBytes(intent))).toBe(vectors.intent.bytes);
    expect(bytesToHex(intentHash(intent))).toBe(vectors.intent.hash);
    expect(intentBytes(intent).length).toBe(179);
  });
});

describe("registration message", () => {
  it("canonical ASCII bytes and off-chain framing", () => {
    const sField = secretToField(sBytes);
    const msg = registrationMessage({
      commitment: commitment(sField),
      walletPubkey: walletPk,
      registryProgramId: pk(REGISTRY_PROGRAM_ID),
      cluster: "devnet",
    });
    expect(bytesToHex(msg)).toBe(vectors.registration.messageHex);
    const framed = frameOffchain(msg);
    expect(bytesToHex(framed)).toBe(vectors.registration.framedHex);
    expect(framed[0]).toBe(0xff);
    expect(framed.length).toBe(16 + 4 + msg.length);
  });
});

describe("pdas", () => {
  it("derives documented addresses", () => {
    expect(toBase58(registryTreePda().address)).toBe(vectors.pdas.registryTree.address);
    expect(toBase58(bindingPda(walletPk).address)).toBe(vectors.pdas.binding.address);
    expect(toBase58(pocketPda(BigInt(vectors.pdas.pocket.appId)).address)).toBe(
      vectors.pdas.pocket.address,
    );
    expect(vectors.pdas.pythPushFeeds).toHaveLength(2);
    for (const feed of vectors.pdas.pythPushFeeds) {
      expect(toBase58(pythPushFeedAddress(hexToBytes(feed.feedId)).address)).toBe(feed.address);
    }
  });

  it("derives Pyth's published sponsored account for SOL/USD", () => {
    // docs.pyth.network lists 7UVi…jLiE as the Solana shard-0 SOL/USD price feed account.
    const solUsd = hexToBytes("ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d");
    expect(toBase58(pythPushFeedAddress(solUsd).address)).toBe("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");
    expect(toBase58(pythPushFeedAddress(solUsd, 1).address)).not.toBe("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");
    expect(() => pythPushFeedAddress(solUsd.subarray(1))).toThrow(/32 bytes/);
    expect(() => pythPushFeedAddress(solUsd, 65_536)).toThrow(/u16/);
  });
});
