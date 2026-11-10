/** Startup diagnostics: each misconfiguration is named, and no key material or credential is ever printed. */
import { afterEach, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { Keypair } from "@solana/web3.js";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.reverse()) await fn(); cleanup.length = 0; });

async function freePort() {
  const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const address = probe.address(); if (!address || typeof address === "string") throw new Error("port unavailable");
  await new Promise<void>(resolve => probe.close(() => resolve())); return address.port;
}

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "solver-diagnostics-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const genesisHash = Keypair.generate().publicKey.toBase58();
  let answer = genesisHash;
  const rpc = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const call = JSON.parse(body);
    res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result: call.method === "getGenesisHash" ? answer : null }));
  });
  rpc.listen(0, "127.0.0.1"); await once(rpc, "listening");
  cleanup.push(() => new Promise<void>(resolve => { rpc.closeAllConnections(); rpc.close(() => resolve()); }));
  const address = rpc.address(); if (!address || typeof address === "string") throw new Error("RPC port unavailable");
  const base: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter(([name, value]) =>
    value !== undefined && !/^(SOLVER_|JUPITER_|PRICE_ACCOUNTS$|RPC_|GHOSTLINK_|PORT$|OPERATIONS_PORT$|TRUST_PROXY$)/.test(name)) as [string, string][]);
  async function run(script: string, change: Record<string, string | undefined>, args: string[] = []) {
    const env: Record<string, string | undefined> = { ...base, ...change };
    for (const [name, value] of Object.entries(env)) if (value === undefined) delete env[name];
    const child = spawn(process.execPath, [join(process.cwd(), "dist", script), ...args], { env: env as Record<string, string>, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", bytes => { output += bytes; if (output.includes("ghostlink solver on")) child.kill(); });
    child.stderr.on("data", bytes => { output += bytes; });
    const timer = setTimeout(() => child.kill(), 20_000);
    const [code] = await once(child, "exit") as [number | null];
    clearTimeout(timer);
    return { code, output };
  }
  const state = join(dir, "solver");
  const init = await run("initialize.js", { SOLVER_GENESIS_HASH: genesisHash }, [state]);
  if (init.code !== 0) throw new Error(init.output);
  const deployment = JSON.parse(readFileSync(join(state, "deployment.json"), "utf8"));
  const env = { SOLVER_GENESIS_HASH: genesisHash, GHOSTLINK_SOLVER_KEYPAIR: join(state, "payer.json"),
    SOLVER_JOURNAL_PATH: join(state, "journal.sqlite"), SOLVER_JOURNAL_KEY_PATH: join(state, "storage-key"),
    SOLVER_JOURNAL_ID: deployment.journalId as string, RPC_URL: `http://127.0.0.1:${address.port}`,
    PORT: String(await freePort()), OPERATIONS_PORT: String(await freePort()) };
  return { dir, state, genesisHash, run, start: (change: Record<string, string | undefined>) => run("index.js", { ...env, ...change }),
    answer: (value: string) => { answer = value; } };
}


it("names a missing, malformed or contradictory variable and an unusable manifest", async () => {
  const w = await fixture();
  const cases: [Record<string, string | undefined>, RegExp][] = [
    [{ GHOSTLINK_SOLVER_KEYPAIR: undefined }, /solver startup failed: GHOSTLINK_SOLVER_KEYPAIR is required: the payer\.json/],
    [{ SOLVER_JOURNAL_KEY_PATH: undefined }, /SOLVER_JOURNAL_KEY_PATH is required: the storage-key/],
    [{ SOLVER_ROUTER: "orca" }, /SOLVER_ROUTER must be inventory or jupiter-raydium-cp/],
    [{ PRICE_ACCOUNTS: "{not json" }, /PRICE_ACCOUNTS must be a JSON object mapping mint addresses/],
    [{ PORT: "9000", OPERATIONS_PORT: "9000" }, /PORT and OPERATIONS_PORT must differ \(both are 9000\)/],
    [{ SOLVER_ROUTER: "jupiter-raydium-cp" }, /JUPITER_POOLS_PATH is required: a private configuration file for SOLVER_ROUTER=jupiter-raydium-cp/],
    [{ GHOSTLINK_DEPLOYMENT: join(w.dir, "absent.json") }, /solver startup failed: GHOSTLINK_DEPLOYMENT: cannot read/],
  ];
  for (const [change, expected] of cases) {
    const { code, output } = await w.start(change);
    expect(code, output).toBe(1); expect(output).toMatch(expected);
    expect(output).not.toMatch(/check approved configuration, keys, journal/); // Classified, not the generic line.
  }
}, 120_000);

it("names unreadable files, a chain mismatch and refused state", async () => {
  const w = await fixture();
  expect((await w.start({ SOLVER_JOURNAL_PATH: join(w.dir, "absent.sqlite") })).output).toMatch(/SOLVER_JOURNAL_PATH: .*absent\.sqlite does not exist/);
  expect((await w.start({ SOLVER_JOURNAL_ID: "ef".repeat(32) })).output).toMatch(/SOLVER_JOURNAL_PATH: .* was refused \(.*\); check SOLVER_JOURNAL_KEY_PATH/);
  w.answer(Keypair.generate().publicKey.toBase58());
  expect((await w.start({})).output).toMatch(/the RPC serves a different chain than SOLVER_GENESIS_HASH/);
  w.answer(w.genesisHash);
  expect((await w.start({})).output).toContain("ghostlink solver on");
}, 120_000);

it("never prints key material, a damaged keypair or a private API key", async () => {
  const w = await fixture();
  const damaged = join(w.dir, "damaged.json"); writeFileSync(damaged, "[12,S3CRET-BYTES,7]");
  const parse = await w.start({ GHOSTLINK_SOLVER_KEYPAIR: damaged });
  expect(parse.output).toMatch(/GHOSTLINK_SOLVER_KEYPAIR: .*damaged\.json is not a valid Solana keypair file/);
  expect(parse.output).not.toContain("S3CRET");
  const shortKey = join(w.dir, "short-key"); writeFileSync(shortKey, "S3CRET-STORAGE-KEY");
  const key = await w.start({ SOLVER_JOURNAL_KEY_PATH: shortKey });
  expect(key.output).toMatch(/SOLVER_JOURNAL_KEY_PATH: .* must hold exactly 32 raw key bytes/);
  expect(key.output).not.toContain("S3CRET");
  const pools = join(w.dir, "pools.json"); writeFileSync(pools, "[S3CRET-POOL");
  const apiKey = join(w.dir, "api-key"); writeFileSync(apiKey, "S3CRET-API-KEY");
  const jupiter = await w.start({ SOLVER_ROUTER: "jupiter-raydium-cp", JUPITER_POOLS_PATH: pools, JUPITER_API_KEY_PATH: apiKey });
  expect(jupiter.output).toMatch(/JUPITER_POOLS_PATH must hold a JSON array of approved pools/);
  expect(jupiter.output).not.toContain("S3CRET");
  mkdirSync(join(w.dir, "folder"));
  expect((await w.start({ GHOSTLINK_SOLVER_KEYPAIR: join(w.dir, "folder") })).output).toMatch(/is a directory, not a file/);
  expect(readFileSync(apiKey, "utf8")).toBe("S3CRET-API-KEY");
}, 120_000);
