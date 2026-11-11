import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { Keypair, PublicKey, Transaction, SystemProgram } from "@solana/web3.js";
import bs58 from "bs58";
import { SubmissionJournal } from "../src/journal.js";
import { LOCALNET_DEPLOYMENT, POCKET_PROGRAM_ID, PUBLIC_GENESIS_HASHES } from "@ghostlink/common";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.reverse()) await fn(); cleanup.length = 0; });
async function port() {
  const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("port unavailable");
  await new Promise<void>(resolve => server.close(() => resolve())); return address.port;
}
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "solver-startup-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const payer = Keypair.generate(), key = randomBytes(32), genesis = Keypair.generate().publicKey.toBase58();
  const payerFile = join(dir, "payer.json"), keyFile = join(dir, "storage-key"), path = join(dir, "missing.db");
  writeFileSync(payerFile, JSON.stringify(Array.from(payer.secretKey))); writeFileSync(keyFile, key);
  let slot = 10, sends = 0;
  const rpc = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const call = JSON.parse(body);
    if (call.method === "sendTransaction") sends++;
    const result = call.method === "getGenesisHash" ? genesis : call.method === "getBalance" ? { context: { slot: ++slot }, value: 1_000_000_000 } : null;
    res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result }));
  });
  rpc.listen(0, "127.0.0.1"); await once(rpc, "listening");
  cleanup.push(() => new Promise<void>(resolve => { rpc.closeAllConnections(); rpc.close(() => resolve()); }));
  const address = rpc.address(); if (!address || typeof address === "string") throw new Error("RPC port unavailable");
  const publicPort = await port(); let opsPort = await port(); while (opsPort === publicPort) opsPort = await port();
  const env = { ...process.env, PORT: String(publicPort), OPERATIONS_PORT: String(opsPort),
    GHOSTLINK_SOLVER_KEYPAIR: payerFile, SOLVER_JOURNAL_KEY_PATH: keyFile, SOLVER_JOURNAL_PATH: path,
    SOLVER_JOURNAL_ID: "01".repeat(32), SOLVER_GENESIS_HASH: genesis, SOLVER_ROUTER: "inventory", PRICE_ACCOUNTS: "{}",
    RPC_ENDPOINTS_PATH: "", RPC_URL: `http://127.0.0.1:${address.port}` };
  async function start(extra: Record<string, string> = {}) {
    const child = spawn(process.execPath, [join(process.cwd(), "dist/index.js")], { env: { ...env, ...extra }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", started = false;
    const exited = once(child, "exit");
    const stop = async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await exited; };
    cleanup.push(stop);
    const result = await new Promise<{ started: boolean; code: number | null }>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error("startup did not settle")); }, 10000);
      child.stdout.on("data", bytes => {
        output += bytes;
        if (output.includes("ghostlink solver on")) { started = true; clearTimeout(timer); resolve({ started, code: null }); }
      });
      child.stderr.on("data", bytes => { output += bytes; });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", code => { clearTimeout(timer); resolve({ started, code }); });
    });
    return { ...result, stop, output };
  }
  return { dir, path, key, payer, genesis, env, start, sends: () => sends };
}
const scopeFor = (w: Awaited<ReturnType<typeof fixture>>) => ({ genesisHash: w.genesis,
  solver: w.payer.publicKey.toBase58(), pocketProgram: POCKET_PROGRAM_ID });

it.each([
  ["SOLVER_MAX_SPREAD_BPS", "1OO"],
  ["SOLVER_MAX_SPREAD_BPS", "10001"],
  ["SOLVER_MAX_COMPUTE_UNITS", "0"],
  ["SOLVER_MAX_COMPUTE_UNITS", "1400001"],
  ["SOLVER_MAX_COMPUTE_UNITS", "1.5"],
  ["SOLVER_MIN_BALANCE_LAMPORTS", "-1"],
  ["SOLVER_MIN_BALANCE_LAMPORTS", "9007199254740992"],
  ["SOLVER_MIN_BALANCE_LAMPORTS", "19999"],
  ["SOLVER_PRIORITY_MICRO_LAMPORTS", "18446744073709551616"],
  ["SOLVER_PRIORITY_MICRO_LAMPORTS", "20000"],
  ["SOLVER_MAX_NETWORK_FEE_LAMPORTS", "0"],
  ["SOLVER_MAX_NETWORK_FEE_LAMPORTS", "0x10"],
  ["JUPITER_SLIPPAGE_BPS", "501"],
  ["PRICE_ACCOUNTS", "{private-config-value"],
  ["PRICE_ACCOUNTS", "null"],
  ["PRICE_ACCOUNTS", "[]"],
  ["PRICE_ACCOUNTS", '{"11111111111111111111111111111111":42}'],
  ["PRICE_ACCOUNTS", '{"private-config-value":"11111111111111111111111111111111"}'],
  ["PRICE_ACCOUNTS", '{"11111111111111111111111111111111":"2"}'],
])("refuses invalid solver startup setting %s (%s) before opening files", async (name, value) => {
  const w = await fixture();
  const result = await w.start({
    GHOSTLINK_SOLVER_KEYPAIR: join(w.dir, "missing-payer.json"),
    ...(name === "JUPITER_SLIPPAGE_BPS" ? { SOLVER_ROUTER: "jupiter-raydium-cp" } : {}),
    [name]: value,
  });
  expect(result.code).toBe(1);
  expect(result.output).toContain("solver startup failed: " + name);
  expect(result.output).not.toContain("private-config-value");
  expect(result.output).not.toContain("missing-payer.json");
}, 20000);

it("rejects a mistyped quote spread even when the journal and RPC are valid", async () => {
  const w = await fixture();
  const journal = new SubmissionJournal(w.path, w.key, scopeFor(w));
  const journalId = journal.instanceId!;
  journal.close();
  const result = await w.start({ SOLVER_JOURNAL_ID: journalId, SOLVER_MAX_SPREAD_BPS: "1OO" });
  await result.stop();
  expect(result.started).toBe(false);
  expect(result.code).toBe(1);
  expect(result.output).toContain("solver startup failed: SOLVER_MAX_SPREAD_BPS");
  expect(result.output).not.toContain("1OO");
}, 20000);

it("refuses a missing journal instead of silently forgetting transaction identity", async () => {
  const w = await fixture(), result = await w.start();
  await result.stop();
  expect(result.started).toBe(false);
  expect(result.code).toBe(1);
  expect(existsSync(w.path)).toBe(false);
  expect(w.sends()).toBe(0);
}, 20000);

it("pins existing state and retains exact packets, nonce ownership and authority floors across hosted restart", async () => {
  const w = await fixture(), scope = scopeFor(w);
  writeFileSync(w.path, ""); expect((await w.start()).code).toBe(1); expect(readFileSync(w.path)).toHaveLength(0);
  const original = new SubmissionJournal(w.path, w.key, scope);
  const identity = { intentHashHex: "21".repeat(32), pocket: Keypair.generate().publicKey.toBase58(), nonce: "7", sessionKind: 0 as const, sessionKeyHex: "22".repeat(32) };
  const tx = new Transaction({ feePayer: w.payer.publicKey, recentBlockhash: w.genesis })
    .add(SystemProgram.transfer({ fromPubkey: w.payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1n }));
  tx.sign(w.payer);
  const claim = original.claim(identity);
  original.observePocketContext(identity.pocket, 10);
  const packet = { rawBase64: tx.serialize().toString("base64"), signature: bs58.encode(tx.signature!),
    blockhash: w.genesis, minContextSlot: 10, lastValidBlockHeight: 100 };
  original.prepared(identity.intentHashHex, claim.token!, packet);
  const journalId = original.instanceId!; original.close();
  expect((await w.start()).code).toBe(1);
  expect((await w.start({ SOLVER_JOURNAL_ID: "" })).code).toBe(1);
  const good = await w.start({ SOLVER_JOURNAL_ID: journalId }); expect(good.started).toBe(true); await good.stop();
  const reopened = SubmissionJournal.openExisting(w.path, w.key, scope, journalId);
  expect(reopened.get(identity.intentHashHex)!.transaction).toEqual(packet);
  expect(reopened.authorizationSlot(identity.pocket)).toBe(10);
  expect(() => reopened.claim({ ...identity, intentHashHex: "23".repeat(32) })).toThrow(/nonce/);
  reopened.close();
  const otherPath = join(w.dir, "other.sqlite"), other = new SubmissionJournal(otherPath, w.key, scope);
  expect(other.instanceId).not.toBe(journalId); other.close();
  expect((await w.start({ SOLVER_JOURNAL_PATH: otherPath, SOLVER_JOURNAL_ID: journalId })).code).toBe(1);
  const damaged = new DatabaseSync(w.path); damaged.exec("DROP TABLE pocket_contexts"); damaged.close();
  expect((await w.start({ SOLVER_JOURNAL_ID: journalId })).code).toBe(1);
  const check = new DatabaseSync(w.path, { readOnly: true });
  expect(check.prepare("SELECT name FROM sqlite_master WHERE name='pocket_contexts'").all()).toHaveLength(0); check.close();
  expect(w.sends()).toBe(0);
}, 30000);

it("retains the pin through backup and key rotation without clearing restored owner-recovery requirements", async () => {
  const w = await fixture(), scope = scopeFor(w), original = new SubmissionJournal(w.path, w.key, scope);
  const journalId = original.instanceId!, archive = join(w.dir, "backup.enc");
  try { await original.backupTo(archive); } finally { original.close(); }
  const restoredPath = SubmissionJournal.restoreBackup(archive, join(w.dir, "restore"), w.key, scope);
  const restored = SubmissionJournal.openExisting(restoredPath, w.key, scope, journalId), newKey = randomBytes(32);
  const authority = { sessionKind: 0, sessionKeyHex: "33".repeat(32) + "00", maxSessionExpirySlot: "1000", slot: 10 };
  const pocket = Keypair.generate().publicKey.toBase58();
  const epoch = restored.recoveryId; expect(epoch).toBeTruthy();
  expect(restored.recoveredAuthority(pocket, authority)).toBe(false);
  restored.rotateKey(newKey); expect(restored.instanceId).toBe(journalId); restored.close();
  expect(() => SubmissionJournal.openExisting(restoredPath, w.key, scope, journalId)).toThrow();
  const reopened = SubmissionJournal.openExisting(restoredPath, newKey, scope, journalId);
  try { expect(reopened.recoveryId).toBe(epoch); expect(reopened.recoveredAuthority(pocket, authority)).toBe(false); }
  finally { reopened.close(); }
}, 20000);

it("refuses legacy or deleted instance markers without inventing an identity or permitting maintenance trades", async () => {
  const w = await fixture(), scope = scopeFor(w), original = new SubmissionJournal(w.path, w.key, scope);
  const journalId = original.instanceId!, identity = { intentHashHex: "21".repeat(32), pocket: w.payer.publicKey.toBase58(), nonce: "7", sessionKind: 0 as const, sessionKeyHex: "22".repeat(32) };
  original.claim(identity);
  const changed = new DatabaseSync(w.path); changed.exec("DELETE FROM metadata WHERE name='solver-instance-v1'"); changed.close();
  expect(() => original.checkWritable()).toThrow(/identity/);
  expect(() => original.claim(identity)).toThrow(/identity/); original.close();
  expect((await w.start({ SOLVER_JOURNAL_ID: journalId })).code).toBe(1);
  const maintenance = SubmissionJournal.openForMaintenance(w.path, w.key, scope);
  try {
    expect(maintenance.instanceId).toBeUndefined(); expect(maintenance.get(identity.intentHashHex)!.identity).toEqual(identity);
    expect(() => maintenance.claim(identity)).toThrow(/maintenance/);
    expect(() => maintenance.observePocketContext(identity.pocket, 20)).toThrow(/maintenance/);
    maintenance.rotateKey(randomBytes(32)); expect(maintenance.instanceId).toBeUndefined();
  } finally { maintenance.close(); }
  expect(w.sends()).toBe(0);
}, 20000);

it("provisions a fresh solver once without adopting an existing payer and starts the actual service", async () => {
  const w = await fixture(), directory = join(w.dir, "fresh"), cli = join(process.cwd(), "dist/initialize.js");
  const init = (target: string, genesis = w.genesis) => spawnSync(process.execPath, [cli, target], {
    env: { ...w.env, SOLVER_GENESIS_HASH: genesis }, encoding: "utf8", timeout: 10000, windowsHide: true,
  });
  const result = init(directory); expect(result.status, result.stderr).toBe(0);
  const deployment = JSON.parse(readFileSync(join(directory, "deployment.json"), "utf8"));
  const payerFile = join(directory, deployment.files.payer), keyFile = join(directory, deployment.files.storageKey);
  const payerBytes = readFileSync(payerFile), keyBytes = readFileSync(keyFile);
  expect(deployment.scope.solver).not.toBe(w.payer.publicKey.toBase58()); expect(keyBytes).toHaveLength(32);
  expect(result.stdout).not.toContain(payerBytes.toString().trim());
  if (process.platform !== "win32") for (const file of [directory, payerFile, keyFile]) expect(statSync(file).mode & 0o077).toBe(0);
  expect(init(directory).status).toBe(1); expect(readFileSync(payerFile)).toEqual(payerBytes); expect(readFileSync(keyFile)).toEqual(keyBytes);
  const started = await w.start({ GHOSTLINK_SOLVER_KEYPAIR: payerFile, SOLVER_JOURNAL_KEY_PATH: keyFile,
    SOLVER_JOURNAL_PATH: join(directory, deployment.files.journal), SOLVER_JOURNAL_ID: deployment.journalId,
    SOLVER_MAX_SPREAD_BPS: "0", SOLVER_MAX_COMPUTE_UNITS: "1", SOLVER_MAX_NETWORK_FEE_LAMPORTS: "20000",
    SOLVER_MIN_BALANCE_LAMPORTS: "20000", SOLVER_PRIORITY_MICRO_LAMPORTS: "1000000",
    PRICE_ACCOUNTS: JSON.stringify({ [w.payer.publicKey.toBase58()]: "11111111111111111111111111111111" }) });
  expect(started.started).toBe(true); await started.stop();
  const publicTarget = join(w.dir, "public-chain");
  expect(init(publicTarget, "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d").status).toBe(1); expect(existsSync(publicTarget)).toBe(false);
  expect(w.sends()).toBe(0);
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
  const init = (target: string, deployment: string, genesis = w.genesis) => spawnSync(process.execPath, [cli, target], {
    env: { ...w.env, SOLVER_GENESIS_HASH: genesis, GHOSTLINK_DEPLOYMENT: deployment }, encoding: "utf8", timeout: 10000, windowsHide: true,
  });
  const directory = join(w.dir, "custom");
  const result = init(directory, local); expect(result.status, result.stderr).toBe(0);
  const d = JSON.parse(readFileSync(join(directory, "deployment.json"), "utf8"));
  expect(d.scope.pocketProgram).toBe(ids.pocketProgram);
  const config = { GHOSTLINK_SOLVER_KEYPAIR: join(directory, d.files.payer), SOLVER_JOURNAL_KEY_PATH: join(directory, d.files.storageKey),
    SOLVER_JOURNAL_PATH: join(directory, d.files.journal), SOLVER_JOURNAL_ID: d.journalId };
  const started = await w.start({ ...config, GHOSTLINK_DEPLOYMENT: local }); expect(started.started, started.output).toBe(true); await started.stop();
  // The same state under the built-in programs is another deployment's state.
  expect((await w.start({ ...config, GHOSTLINK_DEPLOYMENT: devnet })).code).toBe(1);
  const builtin = { ...config }; expect((await w.start(builtin)).code).toBe(1);
  // A public chain needs its own manifest: accepted with one, refused with the built-in IDs or another chain's genesis.
  const publicTarget = join(w.dir, "devnet-chain");
  const accepted = init(publicTarget, devnet, PUBLIC_GENESIS_HASHES.devnet); expect(accepted.status, accepted.stderr).toBe(0);
  for (const [deployment, genesis] of [[builtinDevnet, PUBLIC_GENESIS_HASHES.devnet], [devnet, PUBLIC_GENESIS_HASHES["mainnet-beta"]],
    [local, PUBLIC_GENESIS_HASHES.devnet], [join(w.dir, "missing.json"), w.genesis]] as const) {
    const target = join(w.dir, `refused-${Math.random().toString(16).slice(2)}`);
    expect(init(target, deployment, genesis).status).toBe(1); expect(existsSync(target)).toBe(false);
  }
  expect(w.sends()).toBe(0);
}, 60000);
