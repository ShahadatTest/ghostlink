import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { Keypair, PublicKey } from "@solana/web3.js";
import { REGISTRY, CENSUS, POCKET } from "@ghostlink/service-kit";
import { EncryptedSqlite } from "@ghostlink/service-kit/storage";
import { IndexerDatabase } from "../src/database.js";
import { LOCALNET_DEPLOYMENT, PUBLIC_GENESIS_HASHES } from "@ghostlink/common";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.reverse()) await fn(); cleanup.length = 0; });
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "indexer-startup-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const key = randomBytes(32), genesisHash = Keypair.generate().publicKey.toBase58(), path = join(dir, "indexer.sqlite"), keyPath = join(dir, "key");
  writeFileSync(keyPath, key);
  const scope = JSON.stringify({ genesisHash, programs: [REGISTRY, CENSUS, POCKET].map(p => p.toBase58()), commitment: "finalized" });
  const calls: string[] = [];
  const rpc = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const call = JSON.parse(body); calls.push(call.method);
    res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, ...(call.method === "getGenesisHash" ? { result: genesisHash } :
      { error: { code: -32603, message: "synthetic outage" } }) }));
  });
  rpc.listen(0, "127.0.0.1"); await once(rpc, "listening");
  cleanup.push(() => new Promise<void>(resolve => { rpc.closeAllConnections(); rpc.close(() => resolve()); }));
  const address = rpc.address(); if (!address || typeof address === "string") throw new Error("RPC port unavailable");
  const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const listen = probe.address(); if (!listen || typeof listen === "string") throw new Error("port unavailable");
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const env = { ...process.env, PORT: String(listen.port), POLL_MS: "30000", INDEXER_GENESIS_HASH: genesisHash,
    INDEXER_STATE_PATH: path, INDEXER_STATE_KEY_PATH: keyPath, INDEXER_STATE_ID: "01".repeat(32),
    PERSIST_PATH: "", INGEST_COMMITMENT: "finalized", RPC_ENDPOINTS_PATH: "", RPC_URL: `http://127.0.0.1:${address.port}` };
  async function start(extra: Record<string, string> = {}) {
    const child = spawn(process.execPath, [join(process.cwd(), "dist/index.js")], { env: { ...env, ...extra }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const exited = once(child, "exit"); let output = "";
    const stop = async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await exited; }; cleanup.push(stop);
    const result = await new Promise<{ started: boolean; code: number | null }>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error("startup did not settle")); }, 10000);
      child.stdout.on("data", bytes => { output += bytes; if (output.includes("ghostlink indexer on")) { clearTimeout(timer); resolve({ started: true, code: null }); } });
      child.stderr.on("data", bytes => { output += bytes; });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", code => { clearTimeout(timer); resolve({ started: false, code }); });
    });
    return { ...result, stop, output };
  }
  return { dir, key, genesisHash, path, keyPath, scope, calls, env, start };
}

it("refuses missing, empty, wrong-key and wrong-scope state before serving or scanning", async () => {
  const w = await fixture();
  expect((await w.start()).code).toBe(1); expect(existsSync(w.path)).toBe(false);
  expect((await w.start({ INDEXER_STATE_ID: "" })).code).toBe(1); expect(existsSync(w.path)).toBe(false);
  const empty = join(w.dir, "empty.sqlite"); writeFileSync(empty, Buffer.alloc(0));
  expect((await w.start({ INDEXER_STATE_PATH: empty })).code).toBe(1); expect(statSync(empty).size).toBe(0);
  const state = new IndexerDatabase(w.path, w.key, w.scope), id = state.instanceId!; state.close();
  const before = readFileSync(w.path), wrongKey = join(w.dir, "wrong-key"); writeFileSync(wrongKey, randomBytes(32));
  expect((await w.start({ INDEXER_STATE_KEY_PATH: wrongKey, INDEXER_STATE_ID: id })).code).toBe(1);
  expect(() => IndexerDatabase.openExisting(w.path, w.key, "wrong scope", id)).toThrow();
  expect(readFileSync(w.path)).toEqual(before);
  expect(w.calls.every(method => method === "getGenesisHash")).toBe(true);
}, 30000);

it("preserves partial scan history under its pin and rejects substitution before acquiring a lease", async () => {
  const w = await fixture(), state = new IndexerDatabase(w.path, w.key, w.scope), id = state.instanceId!, program = REGISTRY.toBase58();
  state.begin(7, [program], new Map()); state.page(program, undefined, [{ signature: "A", slot: 7, err: null, memo: null, blockTime: null }], 1000);
  const scan = state.scan(); state.close();
  expect((await w.start({ INDEXER_STATE_ID: "ff".repeat(32) })).code).toBe(1);
  const otherPath = join(w.dir, "replacement.sqlite"), other = new IndexerDatabase(otherPath, w.key, w.scope); other.close();
  expect((await w.start({ INDEXER_STATE_ID: id, INDEXER_STATE_PATH: otherPath })).code).toBe(1);
  const check = new DatabaseSync(w.path, { readOnly: true });
  expect(check.prepare("SELECT name FROM state WHERE name='lease'").all()).toHaveLength(0); check.close();
  const reopened = IndexerDatabase.openExisting(w.path, w.key, w.scope, id);
  try { expect(reopened.scan()).toEqual(scan); expect(reopened.oldest().map(row => row.signature)).toEqual(["A"]); }
  finally { reopened.close(); }
}, 20000);

it("rejects deleted identity, checkpoint records, and spool tables without recreating them", async () => {
  const w = await fixture();
  for (const [name, sql] of Object.entries({ snapshot: "DELETE FROM state WHERE name='snapshot'", through: "DELETE FROM state WHERE name='through'",
    scan: "DELETE FROM state WHERE name='scan'", identity: "DELETE FROM metadata WHERE name='indexer-instance-v1'", schema: "DROP TABLE pending" })) {
    const path = join(w.dir, name + ".sqlite"), state = new IndexerDatabase(path, w.key, w.scope), id = state.instanceId!; state.close();
    const changed = new DatabaseSync(path); changed.exec(sql); changed.close();
    expect((await w.start({ INDEXER_STATE_PATH: path, INDEXER_STATE_ID: id })).code).toBe(1);
    const check = new DatabaseSync(path, { readOnly: true });
    try {
      expect(check.prepare("SELECT name FROM state WHERE name='lease'").all()).toHaveLength(0);
      const rows = name === "schema" ? check.prepare("SELECT name FROM sqlite_master WHERE name='pending'").all() :
        name === "identity" ? check.prepare("SELECT name FROM metadata WHERE name='indexer-instance-v1'").all() :
        check.prepare("SELECT name FROM state WHERE name=?").all(name);
      expect(rows).toHaveLength(0);
    } finally { check.close(); }
  }
  expect(w.calls.every(method => method === "getGenesisHash")).toBe(true);
}, 30000);

it("refuses a supported backup restore despite a matching instance pin", async () => {
  const w = await fixture(), state = new IndexerDatabase(w.path, w.key, w.scope), id = state.instanceId!; state.close();
  const namespace = "ghostlink:indexer:v1:" + createHash("sha256").update(w.scope).digest("hex"), archive = join(w.dir, "archive");
  const storage = new EncryptedSqlite(w.path, w.key, namespace, { existing: true });
  try { await storage.backupTo(archive); } finally { storage.close(); }
  const restored = EncryptedSqlite.restoreBackup(archive, join(w.dir, "restored"), w.key, namespace);
  expect(() => IndexerDatabase.openExisting(restored, w.key, w.scope, id)).toThrow(/reconciled history/);
  expect((await w.start({ INDEXER_STATE_PATH: restored, INDEXER_STATE_ID: id })).code).toBe(1);
});

it("provisions a fresh rebuild exactly once and starts the real service with its independent pin", async () => {
  const w = await fixture(), directory = join(w.dir, "fresh");
  const init = (target: string, genesis = w.genesisHash) => spawnSync(process.execPath, [join(process.cwd(), "dist/initialize.js"), target], {
    env: { ...w.env, INDEXER_GENESIS_HASH: genesis }, encoding: "utf8", timeout: 10000, windowsHide: true,
  });
  const result = init(directory); expect(result.status, result.stderr).toBe(0); expect(w.calls).toEqual([]);
  const bytes = readFileSync(join(directory, "deployment.json")), manifest = JSON.parse(bytes.toString()), files = manifest.files;
  expect(manifest.stateId).toMatch(/^[0-9a-f]{64}$/); expect(JSON.stringify(manifest.scope)).toBe(w.scope);
  expect(readFileSync(join(directory, files.stateKey))).toHaveLength(32);
  if (process.platform !== "win32") {
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    for (const file of [files.state, files.stateKey, files.scope, "deployment.json"]) expect(statSync(join(directory, file)).mode & 0o777).toBe(0o600);
  }
  expect(init(directory).status).toBe(1); expect(readFileSync(join(directory, "deployment.json"))).toEqual(bytes);
  const started = await w.start({ INDEXER_STATE_PATH: join(directory, files.state), INDEXER_STATE_KEY_PATH: join(directory, files.stateKey), INDEXER_STATE_ID: manifest.stateId });
  expect(started.started, started.output).toBe(true); await started.stop();
  const publicTarget = join(w.dir, "public-chain");
  expect(init(publicTarget, "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d").status).toBe(1); expect(existsSync(publicTarget)).toBe(false);
}, 30000);

it("provisions and starts under a non-default deployment manifest and refuses mismatched deployments", async () => {
  const w = await fixture(), cli = join(process.cwd(), "dist/initialize.js");
  const id = (byte: number) => new PublicKey(new Uint8Array(32).fill(byte)).toBase58();
  const ids = { registryProgram: id(1), censusProgram: id(2), pocketProgram: id(3) };
  const manifest = (name: string, fields: Record<string, unknown>) => {
    const path = join(w.dir, `${name}.json`);
    writeFileSync(path, JSON.stringify({ version: 1, ...ids, verifyingKeys: LOCALNET_DEPLOYMENT.verifyingKeys, ...fields }));
    return path;
  };
  const local = manifest("local", { cluster: "localnet" });
  const devnet = manifest("devnet", { cluster: "devnet", genesisHash: PUBLIC_GENESIS_HASHES.devnet });
  const builtinDevnet = manifest("builtin-devnet", { cluster: "devnet", genesisHash: PUBLIC_GENESIS_HASHES.devnet,
    registryProgram: LOCALNET_DEPLOYMENT.registryProgram, censusProgram: LOCALNET_DEPLOYMENT.censusProgram, pocketProgram: LOCALNET_DEPLOYMENT.pocketProgram });
  const init = (target: string, deployment: string, genesis = w.genesisHash) => spawnSync(process.execPath, [cli, target], {
    env: { ...w.env, INDEXER_GENESIS_HASH: genesis, GHOSTLINK_DEPLOYMENT: deployment }, encoding: "utf8", timeout: 10000, windowsHide: true,
  });
  const directory = join(w.dir, "custom");
  const result = init(directory, local); expect(result.status, result.stderr).toBe(0);
  const d = JSON.parse(readFileSync(join(directory, "deployment.json"), "utf8"));
  expect(d.scope.programs).toEqual([ids.registryProgram, ids.censusProgram, ids.pocketProgram]);
  const config = { INDEXER_STATE_PATH: join(directory, d.files.state), INDEXER_STATE_KEY_PATH: join(directory, d.files.stateKey), INDEXER_STATE_ID: d.stateId };
  const started = await w.start({ ...config, GHOSTLINK_DEPLOYMENT: local }); expect(started.started, started.output).toBe(true); await started.stop();
  // The same state under the built-in programs is another deployment's state.
  expect((await w.start({ ...config, GHOSTLINK_DEPLOYMENT: devnet })).code).toBe(1);
  const builtin = { ...config }; expect((await w.start(builtin)).code).toBe(1);
  // A public chain needs its own manifest: accepted with one, refused with the built-in IDs or another chain's genesis.
  const publicTarget = join(w.dir, "devnet-chain");
  const accepted = init(publicTarget, devnet, PUBLIC_GENESIS_HASHES.devnet); expect(accepted.status, accepted.stderr).toBe(0);
  for (const [deployment, genesis] of [[builtinDevnet, PUBLIC_GENESIS_HASHES.devnet], [devnet, PUBLIC_GENESIS_HASHES["mainnet-beta"]],
    [local, PUBLIC_GENESIS_HASHES.devnet], [join(w.dir, "missing.json"), w.genesisHash]] as const) {
    const target = join(w.dir, `refused-${Math.random().toString(16).slice(2)}`);
    expect(init(target, deployment, genesis).status).toBe(1); expect(existsSync(target)).toBe(false);
  }
  
}, 60000);
