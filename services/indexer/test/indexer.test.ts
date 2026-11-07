/**
 * Store + event-decode round trip: synthesize the exact event bytes the
 * programs emit, feed them through the log decoder into the store, and
 * check the served paths verify against the roots — including over HTTP.
 * Plus the refusal cases: gaps, bad roots, conflicting replays, foreign
 * emitters, unauthenticated webhooks and roots the chain never had, and
 * the root-history buckets: only leaves of buckets that have ended are
 * served, against each bucket's final root.
 */
import { describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CENSUS_PROGRAM_ID,
  IncrementalTree,
  REGISTRY_PROGRAM_ID,
  POCKET_PROGRAM_ID,
  fieldToBytes32,
  registryLeaf,
  censusLeaf,
  commitment,
  secretToField,
} from "@ghostlink/common";
import { decodeLogs, eventDisc, frameAsProgramLogs } from "@ghostlink/service-kit";
import bs58 from "bs58";
import { IndexerStore } from "../src/store.js";
import { buildServer } from "../src/server.js";
import type { ChainRoots } from "../src/chain-roots.js";

const wallet = new Uint8Array(32).fill(7);
const mint = new Uint8Array(32).fill(9);
/** Seeded leaves land in root bucket 0; a horizon of slot 1,000 completes it. */
const SLOT = 100n;

function registeredLog(leafIndex: bigint, leaf: Uint8Array, root: Uint8Array, w: Uint8Array = wallet, slot = SLOT): string {
  const c = new Uint8Array(32).fill(3);
  const buf = Buffer.concat([Buffer.from(eventDisc("Registered")), u64(leafIndex), leaf, root, w, c, u64(slot)]);
  return `Program data: ${buf.toString("base64")}`;
}

function snapshotLog(leafIndex: bigint, leaf: Uint8Array, root: Uint8Array, amount: bigint, slot: bigint): string {
  const buf = Buffer.concat([
    Buffer.from(eventDisc("SnapshotTaken")),
    u64(leafIndex),
    leaf,
    root,
    wallet,
    mint,
    u64(amount),
    u64(slot),
  ]);
  return `Program data: ${buf.toString("base64")}`;
}

function u64(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
}

const registryLogs = (lines: string[]) => frameAsProgramLogs(REGISTRY_PROGRAM_ID, lines);
const censusLogs = (lines: string[]) => frameAsProgramLogs(CENSUS_PROGRAM_ID, lines);

function seedStore(): { store: IndexerStore; regRoot: string; cenRoot: string; regTree: IncrementalTree; firstLog: string } {
  const store = new IndexerStore();
  const s = secretToField(new Uint8Array(32).fill(1));
  const regTree = new IncrementalTree();
  const lReg = registryLeaf(wallet, commitment(s));
  regTree.append(lReg);
  const cenTree = new IncrementalTree();
  const lCen = censusLeaf(wallet, mint, 42n, SLOT);
  cenTree.append(lCen);

  const firstLog = registeredLog(0n, fieldToBytes32(lReg), fieldToBytes32(regTree.root));
  const logs = [
    ...registryLogs([firstLog]),
    ...censusLogs([snapshotLog(0n, fieldToBytes32(lCen), fieldToBytes32(cenTree.root), 42n, SLOT)]),
  ];
  for (const event of decodeLogs(logs)) store.apply(event);
  return { store, regRoot: regTree.root.toString(), cenRoot: cenTree.root.toString(), regTree, firstLog };
}

async function withServer<T>(
  store: IndexerStore,
  options: Parameters<typeof buildServer>[1],
  fn: (base: string) => Promise<T>,
): Promise<T> {
  const server = buildServer(store, options);
  server.listen(0);
  await once(server, "listening");
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

describe("indexer store", () => {
  it("deduplicates pocket transactions across replay and snapshot restore", () => {
    const dir = mkdtempSync(join(tmpdir(), "ghostlink-indexer-"));
    const path = join(dir, "snapshot.json");
    try {
      const store = new IndexerStore(path);
      const opened = { kind: "SessionOpened" as const, pocket: "pocket", appId: new Uint8Array(32), created: true, sessionExpirySlot: 100n };
      expect(store.applyTransaction("open", [opened])).toBe(1);
      expect(store.applyTransaction("revoke", [{ kind: "SessionRevoked", pocket: "pocket" }])).toBe(1);
      store.flush();
      const restored = IndexerStore.load(path);
      expect(restored.applyTransaction("open", [opened])).toBe(0);
      expect(restored.pockets.get("pocket")?.revoked).toBe(true);
      expect(restored.activity).toHaveLength(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("rebuilds trees from events and serves verifiable paths", () => {
    const { store, regRoot, cenRoot } = seedStore();
    // Bucket 0 may still change until the horizon passes its last slot.
    expect(store.recentRoots("registry")).toEqual([]);
    expect(store.bindings.size).toBe(0);
    expect(store.advance(1_000)).toBe(true);
    expect(store.recentRoots("registry")).toContain(regRoot);
    expect(store.recentRoots("census")).toContain(cenRoot);
    expect(store.bindings.get(bs58.encode(wallet))?.leafIndex).toBe(0);
    const entry = store.latestCensus.get(`${bs58.encode(wallet)}:${bs58.encode(mint)}`);
    expect(entry?.amount).toBe("42");

    const path = store.registry.path(0);
    expect(IncrementalTree.verify(BigInt(store.registryLeaves[0]!), path, store.registry.root)).toBe(true);
  });

  it("refuses an event whose root does not chain, leaving the tree untouched", () => {
    const { store } = seedStore();
    const badRoot = new Uint8Array(32).fill(5);
    const leaf = fieldToBytes32(123n);
    const rootBefore = store.registry.root;
    expect(() =>
      store.apply({
        kind: "Registered",
        leafIndex: 1n,
        leaf,
        root: badRoot,
        wallet: bs58.encode(wallet),
        commitment: new Uint8Array(32),
        slot: SLOT,
      }),
    ).toThrow(/root mismatch/);
    expect(store.registry.nextIndex).toBe(1);
    expect(store.registry.root).toBe(rootBefore);
    expect(store.registryLeaves).toHaveLength(1);
  });

  it("refuses a gap without mutating, then accepts the missing leaf", () => {
    const { store, regTree } = seedStore();
    const l1 = registryLeaf(new Uint8Array(32).fill(8), commitment(secretToField(new Uint8Array(32).fill(2))));
    const l2 = registryLeaf(new Uint8Array(32).fill(9), commitment(secretToField(new Uint8Array(32).fill(3))));
    regTree.append(l1);
    const rootAfter1 = regTree.root;
    regTree.append(l2);
    const rootAfter2 = regTree.root;

    const gap = decodeLogs(registryLogs([registeredLog(2n, fieldToBytes32(l2), fieldToBytes32(rootAfter2))]))[0]!;
    expect(() => store.apply(gap)).toThrow(/gap/);
    expect(store.registry.nextIndex).toBe(1);

    const next = decodeLogs(registryLogs([registeredLog(1n, fieldToBytes32(l1), fieldToBytes32(rootAfter1))]))[0]!;
    expect(store.apply(next)).toBe(true);
    expect(store.apply(gap)).toBe(true);
    expect(store.registry.root).toBe(rootAfter2);
  });

  it("treats a redelivered identical leaf as a no-op and a conflicting one as fatal", () => {
    const { store, firstLog } = seedStore();
    const replay = decodeLogs(registryLogs([firstLog]))[0]!;
    expect(store.apply(replay)).toBe(false);
    expect(store.registry.nextIndex).toBe(1);

    const conflicting = decodeLogs(
      registryLogs([registeredLog(0n, fieldToBytes32(777n), fieldToBytes32(store.registry.root))]),
    )[0]!;
    expect(() => store.apply(conflicting)).toThrow(/different contents/);
    expect(store.registry.nextIndex).toBe(1);
  });

  it("ignores byte-identical events from a foreign program", () => {
    const { firstLog } = seedStore();
    const store = new IndexerStore();
    const forged = decodeLogs(frameAsProgramLogs("Attack3r11111111111111111111111111111111111", [firstLog]));
    expect(forged).toHaveLength(0);
    expect(store.registry.nextIndex).toBe(0);
  });

  it("serves roots and paths over HTTP", async () => {
    const { store, regRoot } = seedStore();
    store.advance(1_000);
    await withServer(store, {}, async (base) => {
      const roots = (await (await fetch(`${base}/roots/registry`)).json()) as { roots: string[]; nextIndex: number };
      expect(roots.roots).toContain(regRoot);
      expect(roots.nextIndex).toBe(1);

      const path = (await (await fetch(`${base}/path/registry/0`)).json()) as { siblings: string[]; root: string };
      expect(path.root).toBe(regRoot);
      expect(path.siblings.length).toBe(26);

      expect((await fetch(`${base}/path/registry/abc`)).status).toBe(400);
      expect((await fetch(`${base}/path/registry/5`)).status).toBe(404);
      // Browser preflight for any route answers 204 with CORS headers.
      const pre = await fetch(`${base}/roots/registry`, { method: "OPTIONS" });
      expect(pre.status).toBe(204);
      expect(pre.headers.get("access-control-allow-methods")).toContain("POST");
    });
  });

  it("cannot bypass the leaf page cap using negative or fractional limits", async () => {
    const store = new IndexerStore();
    store.registryLeaves = Array.from({ length: 6000 }, () => "1");
    (store as unknown as { completed: Record<string, number> }).completed.registry = 6000;
    await withServer(store, {}, async (base) => {
      for (const limit of ["-1", "0", "1.5", "NaN", "Infinity"]) {
        expect((await fetch(`${base}/leaves/registry?limit=${limit}`)).status).toBe(400);
      }
      const response = await fetch(`${base}/leaves/registry?limit=10000`);
      expect((await response.json()).leaves).toHaveLength(5000);
    });
  });

  it("webhook: off without a secret, 401 with the wrong one, applies with the right one", async () => {
    const { store, regTree } = seedStore();
    const l1 = registryLeaf(new Uint8Array(32).fill(8), commitment(secretToField(new Uint8Array(32).fill(2))));
    regTree.append(l1);
    const body = JSON.stringify({ logs: registryLogs([registeredLog(1n, fieldToBytes32(l1), fieldToBytes32(regTree.root))]) });
    const headers = { "content-type": "application/json" };

    await withServer(store, {}, async (base) => {
      expect((await fetch(`${base}/webhook`, { method: "POST", headers, body })).status).toBe(404);
    });
    await withServer(store, { webhookSecret: "s3cret" }, async (base) => {
      expect((await fetch(`${base}/webhook`, { method: "POST", headers, body })).status).toBe(401);
      expect(
        (await fetch(`${base}/webhook`, { method: "POST", headers: { ...headers, authorization: "wrong" }, body })).status,
      ).toBe(401);
      expect(store.registry.nextIndex).toBe(1);
      const ok = await fetch(`${base}/webhook`, { method: "POST", headers: { ...headers, authorization: "s3cret" }, body });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ applied: 1, ignored: 0 });
      expect(store.registry.nextIndex).toBe(2);
      // Redelivery is harmless.
      const again = await fetch(`${base}/webhook`, { method: "POST", headers: { ...headers, authorization: "s3cret" }, body });
      expect(await again.json()).toEqual({ applied: 0, ignored: 1 });
      expect(store.registry.nextIndex).toBe(2);
    });
  });

  it("webhook: a well-formed event whose root the chain never had is ignored", async () => {
    const { store, regTree } = seedStore();
    const l1 = registryLeaf(new Uint8Array(32).fill(8), commitment(secretToField(new Uint8Array(32).fill(2))));
    regTree.append(l1);
    const chainRoots = { accepts: async () => false } as unknown as ChainRoots;
    const body = JSON.stringify({ logs: registryLogs([registeredLog(1n, fieldToBytes32(l1), fieldToBytes32(regTree.root))]) });
    await withServer(store, { webhookSecret: "s3cret", chainRoots }, async (base) => {
      const res = await fetch(`${base}/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer s3cret" },
        body,
      });
      expect(await res.json()).toEqual({ applied: 0, ignored: 1 });
      expect(store.registry.nextIndex).toBe(1);
    });
  });

  it("webhook: asks the chain to vouch for each tree event by root, leaf index and slot", async () => {
    const { store, regTree } = seedStore();
    const l1 = registryLeaf(new Uint8Array(32).fill(8), commitment(secretToField(new Uint8Array(32).fill(2))));
    regTree.append(l1);
    const accepts = vi.fn(async () => true);
    const body = JSON.stringify({ logs: registryLogs([registeredLog(1n, fieldToBytes32(l1), fieldToBytes32(regTree.root))]) });
    await withServer(store, { webhookSecret: "s3cret", chainRoots: { accepts } as unknown as ChainRoots }, async (base) => {
      const res = await fetch(`${base}/webhook`, { method: "POST", headers: { "content-type": "application/json", authorization: "s3cret" }, body });
      expect(await res.json()).toEqual({ applied: 1, ignored: 0 });
      expect(accepts).toHaveBeenCalledWith("registry", fieldToBytes32(regTree.root), 1n, SLOT);
    });
  });

  it("webhook: failed transactions in a Helius batch are skipped", async () => {
    const { store, regTree } = seedStore();
    const l1 = registryLeaf(new Uint8Array(32).fill(8), commitment(secretToField(new Uint8Array(32).fill(2))));
    regTree.append(l1);
    const logMessages = registryLogs([registeredLog(1n, fieldToBytes32(l1), fieldToBytes32(regTree.root))]);
    await withServer(store, { webhookSecret: "s3cret" }, async (base) => {
      const res = await fetch(`${base}/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "s3cret" },
        body: JSON.stringify([{ meta: { err: { InstructionError: [0, "Custom"] }, logMessages } }]),
      });
      expect(await res.json()).toEqual({ applied: 0, ignored: 0 });
      expect(store.registry.nextIndex).toBe(1);
    });
  });

  it("requires pocket transaction identities and deduplicates retry delivery", async () => {
    const store = new IndexerStore();
    const logs = frameAsProgramLogs(POCKET_PROGRAM_ID, [`Program data: ${Buffer.concat([
      eventDisc("SessionOpened"), wallet, Buffer.alloc(32), Buffer.from([1]), u64(100n),
    ]).toString("base64")}`]);
    await withServer(store, { webhookSecret: "secret" }, async (base) => {
      const post = (signature?: string) => fetch(`${base}/webhook`, { method: "POST",
        headers: { "content-type": "application/json", authorization: "secret" }, body: JSON.stringify({ logs, signature }) });
      expect((await post()).status).toBe(400);
      expect(await (await post("transaction")).json()).toEqual({ applied: 1, ignored: 0 });
      expect(await (await post("transaction")).json()).toEqual({ applied: 0, ignored: 1 });
      expect(store.activity).toHaveLength(1);
    });
  });
});

describe("completed root buckets", () => {
  /** A registration of a fresh wallet at `slot`, appended to `tree` (the chain's view). */
  function registration(tree: IncrementalTree, n: number, slot: bigint) {
    const w = new Uint8Array(32).fill(n);
    const leaf = registryLeaf(w, commitment(secretToField(new Uint8Array(32).fill(n))));
    const index = tree.append(leaf);
    const event = decodeLogs(registryLogs([registeredLog(BigInt(index), fieldToBytes32(leaf), fieldToBytes32(tree.root), w, slot)]))[0]!;
    return { wallet: bs58.encode(w), root: tree.root, event };
  }

  it("serves only leaves whose bucket has ended, against each bucket's final root", async () => {
    const store = new IndexerStore(), tree = new IncrementalTree();
    // Bucket 10 (slots 1,500-1,649) gets two registrations, bucket 11 one.
    const a = registration(tree, 21, 1_500n), b = registration(tree, 22, 1_520n), c = registration(tree, 23, 1_650n);
    store.apply(a.event); store.apply(b.event);
    expect(store.completedSize("registry")).toBe(0);
    expect(store.recentRoots("registry")).toEqual([]);
    // A leaf in bucket 11 proves bucket 10 has ended, even with no poller horizon.
    store.apply(c.event);
    expect(store.completedSize("registry")).toBe(2);
    expect(store.recentRoots("registry")).toEqual([b.root.toString()]);
    expect(store.bindings.has(b.wallet)).toBe(true);
    expect(store.bindings.has(c.wallet)).toBe(false);
    await withServer(store, {}, async (base) => {
      expect(await (await fetch(`${base}/roots/registry`)).json())
        .toEqual({ tree: "registry", roots: [b.root.toString()], nextIndex: 2, completeBeforeSlot: "1650" });
      const path = (await (await fetch(`${base}/path/registry/0`)).json()) as { root: string; siblings: string[] };
      expect(path.root).toBe(b.root.toString());
      expect(IncrementalTree.verify(BigInt(store.registryLeaves[0]!), { index: 0, siblings: path.siblings.map(BigInt) }, b.root)).toBe(true);
      const pending = await fetch(`${base}/path/registry/2`);
      expect(pending.status).toBe(404);
      expect(await pending.json()).toMatchObject({ completesAfterSlot: "1799" });
      expect((await fetch(`${base}/path/registry/3`)).status).toBe(404);
      const binding = await fetch(`${base}/registry/binding/${c.wallet}`);
      expect(binding.status).toBe(404);
      expect(await binding.json()).toMatchObject({ completesAfterSlot: "1799" });
      expect(await (await fetch(`${base}/registry/binding/${b.wallet}`)).json()).toMatchObject({ leafIndex: 1, slot: "1520" });
      expect(await (await fetch(`${base}/leaves/registry`)).json())
        .toMatchObject({ from: 0, nextIndex: 2, leaves: store.registryLeaves.slice(0, 2), completeBeforeSlot: "1650" });
    });
    // The poller horizon completes bucket 11 once every transaction through its last slot is applied.
    expect(store.advance(1_798)).toBe(false);
    expect(store.advance(1_799)).toBe(true);
    expect(store.advance(1_799)).toBe(false);
    expect(store.recentRoots("registry")).toEqual([b.root.toString(), c.root.toString()]);
    expect(store.bindings.get(c.wallet)?.slot).toBe("1650");
    expect(store.completedPath("registry", 2).root).toBe(c.root);
  });

  it("answers census/latest with the newest snapshot of a completed bucket", async () => {
    const store = new IndexerStore(), tree = new IncrementalTree();
    const snap = (amount: bigint, slot: bigint) => {
      const leaf = censusLeaf(wallet, mint, amount, slot);
      const index = tree.append(leaf);
      store.apply(decodeLogs(censusLogs([snapshotLog(BigInt(index), fieldToBytes32(leaf), fieldToBytes32(tree.root), amount, slot)]))[0]!);
    };
    const query = `wallet=${bs58.encode(wallet)}&mint=${bs58.encode(mint)}`;
    snap(5n, 3_000n); // bucket 20
    await withServer(store, {}, async (base) => {
      const pending = await fetch(`${base}/census/latest?${query}`);
      expect(pending.status).toBe(404);
      expect(await pending.json()).toMatchObject({ completesAfterSlot: "3149" });
      snap(9n, 3_200n); // bucket 21: bucket 20 has ended, 21 has not
      expect(await (await fetch(`${base}/census/latest?${query}`)).json()).toMatchObject({ leafIndex: 0, amount: "5", slot: "3000" });
      store.advance(3_299);
      expect(await (await fetch(`${base}/census/latest?${query}`)).json()).toMatchObject({ leafIndex: 1, amount: "9", slot: "3200" });
    });
  });

  it("keeps one root per bucket within the ring's 128 entries", () => {
    const store = new IndexerStore(), tree = new IncrementalTree();
    const finals: string[] = [], superseded: string[] = [];
    for (let bucket = 0; bucket < 130; bucket++) {
      // Two registrations in the newest buckets: only the second root is a bucket root.
      if (bucket >= 126) { store.apply(registration(tree, 200 + bucket - 126, BigInt(bucket * 150)).event); superseded.push(tree.root.toString()); }
      store.apply(registration(tree, 1 + bucket, BigInt(bucket * 150 + 50)).event);
      finals.push(tree.root.toString());
    }
    store.advance(130 * 150);
    expect(store.recentRoots("registry")).toEqual(finals.slice(-128));
    expect(store.recentRoots("registry", 3)).toEqual(finals.slice(-3));
    expect(superseded.some(root => store.recentRoots("registry").includes(root))).toBe(false);
  }, 30_000);

  it("refuses a leaf whose slot runs backwards, and state without leaf slots", () => {
    const store = new IndexerStore(), tree = new IncrementalTree();
    const a = registration(tree, 31, 900n), b = registration(tree, 32, 899n);
    store.apply(a.event);
    expect(() => store.apply(b.event)).toThrow(/slot regressed/);
    expect(store.registry.nextIndex).toBe(1);
    const saved = JSON.parse(JSON.stringify(store.snapshot())) as Record<string, unknown>;
    const copy = new IndexerStore(); copy.restore(saved as never);
    expect(copy.pendingBindings).toHaveLength(1);
    expect(copy.completeBeforeSlot("registry")).toBe(store.completeBeforeSlot("registry"));
    delete saved.registrySlots;
    expect(() => new IndexerStore().restore(saved as never)).toThrow(/slots/);
  });

  it("restores served and pending entries exactly", () => {
    const store = new IndexerStore(), tree = new IncrementalTree();
    for (const [n, slot] of [[41, 10n], [42, 160n], [43, 170n], [44, 400n]] as const) store.apply(registration(tree, n, slot).event);
    store.advance(299);
    const copy = new IndexerStore();
    copy.restore(JSON.parse(JSON.stringify(store.snapshot())));
    for (const s of [store, copy]) {
      expect(s.completedSize("registry")).toBe(3);
      expect(s.bindings.size).toBe(3);
      expect(s.pendingBindings.map(p => p.entry.leafIndex)).toEqual([3]);
    }
    expect(copy.recentRoots("registry")).toEqual(store.recentRoots("registry"));
    expect(copy.completedRoot("registry")).toBe(store.completedRoot("registry"));
  });
});
