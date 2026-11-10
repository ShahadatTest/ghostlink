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
  const dir = mkdtempSync(join(tmpdir(), "watcher-diagnostics-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
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
    value !== undefined && !/^(WATCHER_|NOTIFY_WEBHOOK$|LARGE_FILL_USD_E6$|RPC_|GHOSTLINK_|PORT$)/.test(name)) as [string, string][]);
  async function run(script: string, change: Record<string, string | undefined>, args: string[] = []) {
    const env: Record<string, string | undefined> = { ...base, ...change };
    for (const [name, value] of Object.entries(env)) if (value === undefined) delete env[name];
    const child = spawn(process.execPath, [join(process.cwd(), "dist", script), ...args], { env: env as Record<string, string>, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", bytes => { output += bytes; if (output.includes("ghostlink watcher running on")) child.kill(); });
    child.stderr.on("data", bytes => { output += bytes; });
    const timer = setTimeout(() => child.kill(), 20_000);
    const [code] = await once(child, "exit") as [number | null];
    clearTimeout(timer);
    return { code, output };
  }
  const state = join(dir, "watcher");
  const init = await run("initialize.js", { WATCHER_GENESIS_HASH: genesisHash }, ["observer", state]);
  if (init.code !== 0) throw new Error(init.output);
  const deployment = JSON.parse(readFileSync(join(state, "deployment.json"), "utf8"));
  const env = { WATCHER_GENESIS_HASH: genesisHash, WATCHER_STATE_PATH: join(state, "state.sqlite"), WATCHER_STATE_KEY_PATH: join(state, "state-key"),
    WATCHER_STATE_ID: deployment.stateId as string, RPC_URL: `http://127.0.0.1:${address.port}`, WATCHER_PORT: String(await freePort()) };
  return { dir, state, genesisHash, run, start: (change: Record<string, string | undefined>) => run("index.js", { ...env, ...change }),
    answer: (value: string) => { answer = value; } };
}


it("names a missing, malformed or contradictory variable and an unusable manifest", async () => {
  const w = await fixture();
  const cases: [Record<string, string | undefined>, RegExp][] = [
    [{ WATCHER_STATE_ID: undefined }, /watcher startup failed: WATCHER_STATE_ID is required: .*stateId/],
    [{ WATCHER_STATE_KEY_PATH: undefined }, /WATCHER_STATE_KEY_PATH is required: the state-key/],
    [{ WATCHER_POLL_MS: "5" }, /WATCHER_POLL_MS must be an integer from 100 to 30000/],
    [{ WATCHER_PORT: "port" }, /WATCHER_PORT must be an integer from 1 to 65535/],
    [{ LARGE_FILL_USD_E6: "-1" }, /LARGE_FILL_USD_E6 must be a whole number of micro-dollars/],
    [{ GHOSTLINK_DEPLOYMENT: join(w.dir, "absent.json") }, /watcher startup failed: GHOSTLINK_DEPLOYMENT: cannot read/],
  ];
  for (const [change, expected] of cases) {
    const { code, output } = await w.start(change);
    expect(code, output).toBe(1); expect(output).toMatch(expected);
    expect(output).not.toMatch(/check approved configuration and dependencies/); // Classified, not the generic line.
  }
  const funded = join(w.dir, "funded.json"); writeFileSync(funded, JSON.stringify(Array.from(Keypair.generate().secretKey)));
  expect((await w.start({ GHOSTLINK_WATCHER_KEYPAIR: funded })).output).toMatch(/WATCHER_JOURNAL_PATH is required: a funded watcher/);
  const mode = await w.run("initialize.js", { WATCHER_GENESIS_HASH: w.genesisHash }, ["paid", join(w.dir, "x")]);
  expect(mode.output).toMatch(/watcher initialization failed: usage: node dist\/initialize\.js <observer\|funded>/);
  const budget = await w.run("initialize.js", { WATCHER_GENESIS_HASH: w.genesisHash }, ["funded", join(w.dir, "y")]);
  expect(budget.output).toMatch(/funded mode needs WATCHER_TOTAL_BUDGET_LAMPORTS/);
}, 120_000);

it("names unreadable files, a chain mismatch and refused state", async () => {
  const w = await fixture();
  expect((await w.start({ WATCHER_STATE_PATH: join(w.dir, "absent.sqlite") })).output).toMatch(/WATCHER_STATE_PATH: .*absent\.sqlite does not exist/);
  expect((await w.start({ WATCHER_STATE_ID: "12".repeat(32) })).output).toMatch(/WATCHER_STATE_PATH: .* was refused \(.*\); check WATCHER_STATE_KEY_PATH, WATCHER_STATE_ID/);
  // The state is scoped to its alert threshold: a changed threshold is another state.
  expect((await w.start({ LARGE_FILL_USD_E6: "5" })).output).toMatch(/WATCHER_STATE_PATH: .* was refused/);
  w.answer(Keypair.generate().publicKey.toBase58());
  expect((await w.start({})).output).toMatch(/the RPC serves a different chain than WATCHER_GENESIS_HASH/);
  w.answer(w.genesisHash);
  expect((await w.start({})).output).toContain("ghostlink watcher running on");
}, 120_000);

it("never prints key material, a damaged keypair or webhook credentials", async () => {
  const w = await fixture();
  const damaged = join(w.dir, "damaged.json"); writeFileSync(damaged, "[1,2,S3CRET");
  const parse = await w.start({ GHOSTLINK_WATCHER_KEYPAIR: damaged });
  expect(parse.output).toMatch(/GHOSTLINK_WATCHER_KEYPAIR: .*damaged\.json is not a valid Solana keypair file/);
  expect(parse.output).not.toContain("S3CRET");
  const webhook = await w.start({ NOTIFY_WEBHOOK: "https://alerts:S3CRET-TOKEN@hooks.example/notify" });
  expect(webhook.output).toMatch(/NOTIFY_WEBHOOK: notification endpoint requires HTTPS or loopback HTTP without userinfo/);
  expect(webhook.output).not.toContain("S3CRET");
  const shortKey = join(w.dir, "short-key"); writeFileSync(shortKey, "S3CRET-STATE-KEY");
  const key = await w.start({ WATCHER_STATE_KEY_PATH: shortKey });
  expect(key.output).toMatch(/WATCHER_STATE_KEY_PATH: .* must hold exactly 32 raw key bytes/);
  expect(key.output).not.toContain("S3CRET");
  mkdirSync(join(w.dir, "folder"));
  expect((await w.start({ WATCHER_STATE_KEY_PATH: join(w.dir, "folder") })).output).toMatch(/is a directory, not a file/);
}, 120_000);
