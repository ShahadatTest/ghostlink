import { afterEach, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Connection, SystemProgram } from "@solana/web3.js";
import { IncrementalTree, fieldToBytes32, ROOT_HISTORY_SIZE, TREE_DEPTH } from "@ghostlink/common";
import { CENSUS, REGISTRY, POCKET } from "@ghostlink/service-kit";
import { IndexerDatabase } from "../src/database.js";
import { IndexerStore } from "../src/store.js";
import { Poller, type PollerOptions } from "../src/poller.js";
import { buildServer } from "../src/server.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.reverse()) close(); cleanup.length = 0; });
const rootsOffset = 16 + 32 * TREE_DEPTH;
const cursorOffset = rootsOffset + 32 * ROOT_HISTORY_SIZE;
const slotsOffset = cursorOffset + 8;
/**
 * A TreeState account whose ring received `entries` in order (one per
 * bucket, oldest first, wrapping like the program's ring); by default one
 * entry holding the tree's current root.
 */
function account(tree: IncrementalTree, owner = REGISTRY, entries: { root: bigint; slot: number }[] = [{ root: tree.root, slot: 5 }]) {
  const data = Buffer.alloc(slotsOffset + 8 * ROOT_HISTORY_SIZE);
  createHash("sha256").update("account:TreeState").digest().copy(data, 0, 0, 8);
  data.writeBigUInt64LE(BigInt(tree.nextIndex), 8);
  entries.forEach(({ root, slot }, i) => {
    const position = i % ROOT_HISTORY_SIZE;
    Buffer.from(fieldToBytes32(root)).copy(data, rootsOffset + 32 * position);
    data.writeBigUInt64LE(BigInt(slot), slotsOffset + 8 * position);
  });
  data[cursorOffset] = (entries.length - 1) % ROOT_HISTORY_SIZE;
  return { owner, data, executable: false, lamports: 1, rentEpoch: 0 };
}
/** The Registered event the registry emits for `tree`'s newest leaf. */
function registered(tree: IncrementalTree, slot: number) {
  return { kind: "Registered" as const, leafIndex: BigInt(tree.nextIndex - 1), leaf: fieldToBytes32(tree.leafAt(tree.nextIndex - 1)!),
    root: fieldToBytes32(tree.root), wallet: "wallet", commitment: new Uint8Array(32), slot: BigInt(slot) };
}
function world(options: Partial<PollerOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "indexer-reconciliation-")), key = randomBytes(32), path = join(dir, "state.sqlite");
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const open = () => { const db = new IndexerDatabase(path, key, "synthetic root reconciliation"); cleanup.push(() => db.close()); return db; };
  const database = open();
  const store = new IndexerStore(), registry = new IncrementalTree(), census = new IncrementalTree();
  const connection = { getSlot: vi.fn(async () => 10), getSignaturesForAddress: vi.fn(async () => []),
    getMultipleAccountsInfoAndContext: vi.fn(async (_addresses?: unknown, _config?: { commitment: string; minContextSlot: number }) =>
      ({ context: { slot: 10 }, value: [account(registry), account(census, CENSUS)] })) };
  const poller = new Poller(connection as unknown as Connection, store, undefined, 1000, "finalized",
    { database, paceMs: 0, reconcileRoots: true, ...options });
  return { database, open, store, registry, census, connection, poller };
}

it("does not declare an empty RPC history ready when the finalized tree has a leaf", async () => {
  const w = world(); w.registry.append(7n);
  const server = buildServer(w.store, { database: w.database, poller: w.poller.status });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    await w.poller.tick().catch(() => undefined);
    expect((await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/ready`)).status).toBe(503);
    expect(w.database.through()).toBe(0);
    expect(w.database.scan()).toBeDefined();
    for (const route of ["roots/registry", "leaves/census", "path/registry/0", "registry/binding/example", "census/latest", "pockets/example", "activity/example", "stats"]) {
      expect((await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/${route}`)).status).toBe(503);
    }
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

it("refuses a conflicting root even when leaf counts agree", async () => {
  const w = world(); w.registry.append(7n);
  const other = new IncrementalTree(); other.append(8n); w.store.apply(registered(other, 5)); w.database.save(w.store.snapshot());
  await expect(w.poller.tick()).rejects.toThrow(/match finalized/);
  expect(w.database.through()).toBe(0); expect(w.database.scan()!.treeAnchor!.registry.nextIndex).toBe(1);
});

it("retains its original anchor across a bounded scan and database reopen", async () => {
  const w = world({ maximumPages: 1 });
  await w.poller.tick(); expect(w.database.scan()!.nextProgram).toBe(1);
  const anchor = w.database.scan()!.treeAnchor; w.database.close();
  w.registry.append(9n); // Arrives after the saved finalized slot; belongs to the next scan.
  w.connection.getMultipleAccountsInfoAndContext.mockImplementation(async (_addresses, config) => {
    expect(config?.commitment).toBe("confirmed");
    const current = account(w.registry);
    Buffer.from(fieldToBytes32(BigInt(anchor!.registry.root))).copy(current.data, rootsOffset);
    return { context: { slot: 20 }, value: [current, account(w.census, CENSUS)] };
  });
  const reopened = w.open(), poller = new Poller(w.connection as unknown as Connection, new IndexerStore(), undefined, 1000, "finalized",
    { database: reopened, reconcileRoots: true, maximumPages: 1, paceMs: 0 });
  expect(reopened.scan()!.treeAnchor).toEqual(anchor);
  await poller.tick(); await poller.tick();
  expect(reopened.through()).toBe(10); expect(reopened.scan()).toBeUndefined(); expect(poller.status.rootsUsable).toBe(true);
  expect(w.connection.getMultipleAccountsInfoAndContext).toHaveBeenCalledTimes(2);
  expect(w.connection.getSlot).not.toHaveBeenCalled();
});

it("withholds paths while a new scan is in flight and when root checks expire", async () => {
  const w = world(); await w.poller.tick();
  const server = buildServer(w.store, { database: w.database, poller: w.poller.status });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/leaves/registry`;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const original = w.connection.getMultipleAccountsInfoAndContext.getMockImplementation()!;
  w.connection.getMultipleAccountsInfoAndContext.mockImplementationOnce(async (...args) => { await held; return original(...args); });
  const tick = w.poller.tick();
  try {
    expect((await fetch(url)).status).toBe(503);
    release(); await tick; expect((await fetch(url)).status).toBe(200);
    w.poller.status.rootsCheckedAt = new Date(Date.now() - 31_000).toISOString();
    expect((await fetch(url)).status).toBe(503);
  } finally { release(); await tick; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

it.each(["missing", "owner", "executable", "truncated", "discriminator", "index", "cursor", "field", "context"])("refuses %s account evidence before scanning", async variant => {
  const w = world();
  w.connection.getMultipleAccountsInfoAndContext.mockImplementation(async () => {
    const a = account(w.registry), b = account(w.census, CENSUS);
    if (variant === "missing") return { context: { slot: 10 }, value: [null, b] } as never;
    if (variant === "owner") a.owner = SystemProgram.programId;
    if (variant === "executable") a.executable = true;
    if (variant === "truncated") a.data = a.data.subarray(0, -1);
    if (variant === "discriminator") a.data[0] ^= 1;
    if (variant === "index") a.data.writeBigUInt64LE(1n << 50n, 8);
    if (variant === "cursor") a.data[rootsOffset + 32 * ROOT_HISTORY_SIZE] = 1;
    if (variant === "field") a.data.fill(255, rootsOffset, rootsOffset + 32);
    return { context: { slot: variant === "context" ? -1 : 10 }, value: [a, b] };
  });
  await expect(w.poller.tick()).rejects.toThrow();
  expect(w.database.scan()).toBeUndefined(); expect(w.connection.getSignaturesForAddress).not.toHaveBeenCalled();
});

it("does not silently attach current roots to a legacy in-progress scan", async () => {
  const w = world(); w.database.begin(9, [REGISTRY, CENSUS, POCKET].map(p => p.toBase58()), w.store.cursors);
  await expect(w.poller.tick()).rejects.toThrow(/legacy scan/);
  expect(w.database.scan()!.upperSlot).toBe(9); expect(w.database.scan()!.treeAnchor).toBeUndefined();
  expect(w.connection.getMultipleAccountsInfoAndContext).not.toHaveBeenCalled();
});

/**
 * One registration at slot 155 (bucket 1), finalized by an anchor at slot 400: the indexer serves
 * bucket 1's root. The confirmed ring then shows `later` buckets after it.
 */
function servedWorld(later: number, tamper?: "root" | "missing") {
  const w = world(); w.registry.append(7n);
  const served = w.registry.root;
  w.store.apply(registered(w.registry, 155)); w.database.save(w.store.snapshot());
  w.connection.getMultipleAccountsInfoAndContext.mockImplementation(async (_addresses, config) => {
    if (config?.commitment !== "confirmed") {
      return { context: { slot: 400 }, value: [account(w.registry, REGISTRY, [{ root: served, slot: 155 }]), account(w.census, CENSUS)] };
    }
    const chain = new IncrementalTree(); chain.append(7n);
    const entries = [{ root: tamper === "root" ? 99n : served, slot: 155 }];
    for (let b = 2; b <= later + 1; b++) { chain.append(BigInt(1000 + b)); entries.push({ root: chain.root, slot: b * 150 + 7 }); }
    // An older bucket's entry where bucket 1's should be: history the indexer never saw.
    if (tamper === "missing") entries.splice(0, 1, { root: 98n, slot: 3 });
    return { context: { slot: 401 + later * 150 }, value: [account(chain, REGISTRY, entries), account(w.census, CENSUS)] };
  });
  return w;
}

it.each([127, 128])("reports usable roots only while the served bucket survives %i later buckets", async later => {
  const w = servedWorld(later);
  await w.poller.tick(); expect(w.database.through()).toBe(400); expect(w.store.completedSize("registry")).toBe(1);
  expect(w.poller.status.rootsUsable).toBe(later < 128);
  const server = buildServer(w.store, { database: w.database, poller: w.poller.status });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try { expect((await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/ready`)).status).toBe(later < 128 ? 200 : 503); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

it.each(["root", "missing"] as const)("refuses a confirmed ring that contradicts the served bucket (%s)", async tamper => {
  const w = servedWorld(3, tamper);
  await expect(w.poller.tick()).rejects.toThrow(tamper === "root" ? /contradicts an indexed bucket root/ : /no entry for an indexed bucket/);
  expect(w.poller.status.rootsUsable).toBe(false);
});

it("preserves a reconciled checkpoint on probe outage and rejects regressing confirmed evidence", async () => {
  const w = world(); let confirmed = 20;
  w.connection.getMultipleAccountsInfoAndContext.mockImplementation(async (_addresses, config) => {
    if (config?.commitment === "confirmed" && confirmed === -1) throw new Error("synthetic outage");
    return { context: { slot: config?.commitment === "confirmed" ? confirmed : 10 }, value: [account(w.registry), account(w.census, CENSUS)] };
  });
  await w.poller.tick(); expect(w.poller.status.rootsUsable).toBe(true);
  confirmed = -1; await expect(w.poller.tick()).rejects.toThrow(/outage/);
  expect(w.database.through()).toBe(10); expect(w.poller.status.rootsUsable).toBe(false);
  confirmed = 19; await expect(w.poller.tick()).rejects.toThrow(/regressed/);
  expect(w.connection.getMultipleAccountsInfoAndContext.mock.calls.at(-1)![1]).toMatchObject({ minContextSlot: 20 });
  confirmed = 21; await w.poller.tick(); expect(w.poller.status.rootsUsable).toBe(true);
});
