/** Startup diagnostics: each misconfiguration is named, and no key material or credential is ever printed. */
import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { Keypair } from "@solana/web3.js";
import { REGISTRY, CENSUS, POCKET } from "@ghostlink/service-kit";
import { IndexerDatabase } from "../src/database.js";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.reverse()) await fn(); cleanup.length = 0; });

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "indexer-diagnostics-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const genesisHash = Keypair.generate().publicKey.toBase58(), key = randomBytes(32), keyPath = join(dir, "state-key");
  writeFileSync(keyPath, key);
  let answer = genesisHash;
  const rpc = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const call = JSON.parse(body);
    res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, ...(call.method === "getGenesisHash" ? { result: answer } : { error: { code: -32603, message: "synthetic" } }) }));
  });
  rpc.listen(0, "127.0.0.1"); await once(rpc, "listening");
  cleanup.push(() => new Promise<void>(resolve => { rpc.closeAllConnections(); rpc.close(() => resolve()); }));
  const address = rpc.address(); if (!address || typeof address === "string") throw new Error("RPC port unavailable");
  const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const free = probe.address(); if (!free || typeof free === "string") throw new Error("port unavailable");
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const scope = JSON.stringify({ genesisHash, programs: [REGISTRY, CENSUS, POCKET].map(p => p.toBase58()), commitment: "finalized" });
  const statePath = join(dir, "state.sqlite"), state = new IndexerDatabase(statePath, key, scope), stateId = state.instanceId!; state.close();
  const base: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter(([name, value]) =>
    value !== undefined && !/^(INDEXER_|RPC_|GHOSTLINK_|PORT$|POLL_MS$|PERSIST_PATH$|INGEST_COMMITMENT$)/.test(name)) as [string, string][]);
  const env = { ...base, INDEXER_GENESIS_HASH: genesisHash, INDEXER_STATE_PATH: statePath, INDEXER_STATE_KEY_PATH: keyPath,
    INDEXER_STATE_ID: stateId, RPC_URL: `http://127.0.0.1:${address.port}`, PORT: String(free.port), POLL_MS: "30000" };
  /** Starts dist/index.js and returns everything it printed once it exits (or once it is listening). */
  async function start(change: Record<string, string | undefined>) {
    const merged = { ...env, ...change };
    for (const [name, value] of Object.entries(merged)) if (value === undefined) delete merged[name];
    const child = spawn(process.execPath, [join(process.cwd(), "dist/index.js")], { env: merged as Record<string, string>, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", bytes => { output += bytes; if (output.includes("ghostlink indexer on")) child.kill(); });
    child.stderr.on("data", bytes => { output += bytes; });
    const timer = setTimeout(() => child.kill(), 20_000);
    const [code] = await once(child, "exit") as [number | null];
    clearTimeout(timer);
    return { code, output };
  }
  return { dir, genesisHash, stateId, start, answer: (value: string) => { answer = value; } };
}

it("names a missing, malformed or contradictory variable and an unusable manifest", async () => {
  const w = await fixture();
  const cases: [Record<string, string | undefined>, RegExp][] = [
    [{ INDEXER_STATE_ID: undefined }, /indexer startup failed: INDEXER_STATE_ID is required: .*stateId/],
    [{ INDEXER_GENESIS_HASH: "not-a-hash" }, /INDEXER_GENESIS_HASH must be a base58 32-byte genesis hash/],
    [{ INDEXER_STATE_ID: "ABC" }, /INDEXER_STATE_ID must be 64 lowercase hex characters/],
    [{ POLL_MS: "10" }, /POLL_MS must be an integer from 50 to 30000/],
    [{ RPC_URL: undefined }, /RPC_URL or RPC_ENDPOINTS_PATH is required/],
    [{ INGEST_COMMITMENT: "confirmed" }, /INGEST_COMMITMENT must be finalized/],
    [{ GHOSTLINK_DEPLOYMENT: join(w.dir, "missing.json") }, /indexer startup failed: GHOSTLINK_DEPLOYMENT: cannot read .*missing\.json/],
    [{ INDEXER_GENESIS_HASH: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d" }, /INDEXER_GENESIS_HASH does not suit the deployment .*refuses the mainnet-beta genesis/],
  ];
  for (const [change, expected] of cases) {
    const { code, output } = await w.start(change);
    expect(code, output).toBe(1); expect(output).toMatch(expected);
    expect(output).not.toMatch(/check approved configuration and state/); // Classified, not the generic line.
  }
}, 120_000);

it("names unreadable files, a chain mismatch and refused state", async () => {
  const w = await fixture();
  const notAFile = await w.start({ INDEXER_STATE_KEY_PATH: w.dir });
  expect(notAFile.output).toMatch(/INDEXER_STATE_KEY_PATH: .* is a directory, not a file/);
  const missing = await w.start({ INDEXER_STATE_PATH: join(w.dir, "nope.sqlite") });
  expect(missing.output).toMatch(/INDEXER_STATE_PATH: .*nope\.sqlite does not exist; create state with this service's initialize\.js/);
  const pin = await w.start({ INDEXER_STATE_ID: "ab".repeat(32) });
  expect(pin.output).toMatch(/INDEXER_STATE_PATH: .* was refused \(indexer state identity mismatch\); check INDEXER_STATE_KEY_PATH, INDEXER_STATE_ID/);
  const wrongKey = join(w.dir, "wrong-key"); writeFileSync(wrongKey, randomBytes(32));
  expect((await w.start({ INDEXER_STATE_KEY_PATH: wrongKey })).output).toMatch(/INDEXER_STATE_PATH: .* was refused \(/);
  w.answer(Keypair.generate().publicKey.toBase58());
  const chain = await w.start({});
  expect(chain.code).toBe(1);
  expect(chain.output).toMatch(/the RPC serves a different chain than INDEXER_GENESIS_HASH/);
  w.answer(w.genesisHash);
  const good = await w.start({});
  expect(good.output, good.output).toContain("ghostlink indexer on");
}, 120_000);

it("never prints key material or RPC credentials", async () => {
  const w = await fixture();
  const secret = "S3CRET-KEY-MATERIAL-0123456789";
  const shortKey = join(w.dir, "short-key"); writeFileSync(shortKey, secret);
  const key = await w.start({ INDEXER_STATE_KEY_PATH: shortKey });
  expect(key.output).toMatch(/INDEXER_STATE_KEY_PATH: .* must hold exactly 32 raw key bytes/);
  expect(key.output).not.toContain(secret);
  const endpoints = join(w.dir, "endpoints.json");
  writeFileSync(endpoints, JSON.stringify([{ url: `ftp://rpc.example/?api-key=${secret}`, headers: { authorization: `Bearer ${secret}` } }]));
  const rpc = await w.start({ RPC_ENDPOINTS_PATH: endpoints });
  expect(rpc.output).toMatch(/RPC_ENDPOINTS_PATH: RPC endpoints require HTTPS or loopback HTTP/);
  expect(rpc.output).not.toContain(secret);
  const malformed = join(w.dir, "malformed.json"); writeFileSync(malformed, `[{"url": "${secret}`);
  const parse = await w.start({ RPC_ENDPOINTS_PATH: malformed });
  expect(parse.output).toMatch(/RPC_ENDPOINTS_PATH: RPC_ENDPOINTS_PATH must name a bounded valid endpoint configuration file/);
  expect(parse.output).not.toContain(secret);
}, 120_000);
