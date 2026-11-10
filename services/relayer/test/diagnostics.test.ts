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
  const dir = mkdtempSync(join(tmpdir(), "relayer-diagnostics-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
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
    value !== undefined && !/^(RELAYER_|RPC_|GHOSTLINK_|PORT$|OPERATIONS_PORT$|TRUST_PROXY$)/.test(name)) as [string, string][]);
  async function run(script: string, change: Record<string, string | undefined>, args: string[] = []) {
    const env: Record<string, string | undefined> = { ...base, ...change };
    for (const [name, value] of Object.entries(env)) if (value === undefined) delete env[name];
    const child = spawn(process.execPath, [join(process.cwd(), "dist", script), ...args], { env: env as Record<string, string>, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", bytes => { output += bytes; if (output.includes("ghostlink relayer on")) child.kill(); });
    child.stderr.on("data", bytes => { output += bytes; });
    const timer = setTimeout(() => child.kill(), 20_000);
    const [code] = await once(child, "exit") as [number | null];
    clearTimeout(timer);
    return { code, output };
  }
  const state = join(dir, "relayer");
  const init = await run("initialize.js", { RELAYER_GENESIS_HASH: genesisHash }, [state]);
  if (init.code !== 0) throw new Error(init.output);
  const deployment = JSON.parse(readFileSync(join(state, "deployment.json"), "utf8"));
  const env = { RELAYER_GENESIS_HASH: genesisHash, GHOSTLINK_RELAYER_KEYPAIR: join(state, "payer.json"),
    RELAYER_JOURNAL_PATH: join(state, "journal.sqlite"), RELAYER_JOURNAL_KEY_PATH: join(state, "storage-key"),
    RELAYER_JOURNAL_ID: deployment.journalId as string, RPC_URL: `http://127.0.0.1:${address.port}`,
    PORT: String(await freePort()), OPERATIONS_PORT: String(await freePort()) };
  return { dir, state, genesisHash, run, start: (change: Record<string, string | undefined>) => run("index.js", { ...env, ...change }),
    answer: (value: string) => { answer = value; } };
}

it("names a missing, malformed or contradictory variable and an unusable manifest", async () => {
  const w = await fixture();
  const cases: [Record<string, string | undefined>, RegExp][] = [
    [{ GHOSTLINK_RELAYER_KEYPAIR: undefined }, /relayer startup failed: GHOSTLINK_RELAYER_KEYPAIR is required: the payer\.json/],
    [{ RELAYER_JOURNAL_ID: "1234" }, /RELAYER_JOURNAL_ID must be 64 lowercase hex characters/],
    [{ PORT: "8788", OPERATIONS_PORT: "8788" }, /PORT and OPERATIONS_PORT must differ \(both are 8788\)/],
    [{ OPERATIONS_PORT: "70000" }, /OPERATIONS_PORT must be an integer from 1 to 65535/],
    [{ RELAYER_MAX_SNAPSHOT_FEE_LAMPORTS: "0.5" }, /RELAYER_MAX_SNAPSHOT_FEE_LAMPORTS must be a whole number of lamports/],
    [{ RELAYER_BUDGET_PATH: "legacy.json" }, /RELAYER_BUDGET_PATH is set: legacy spend state needs reconciliation/],
    [{ GHOSTLINK_DEPLOYMENT: "" }, /relayer startup failed: GHOSTLINK_DEPLOYMENT is set but empty/],
  ];
  for (const [change, expected] of cases) {
    const { code, output } = await w.start(change);
    expect(code, output).toBe(1); expect(output).toMatch(expected);
    expect(output).not.toMatch(/check approved configuration, legacy migration/); // Classified, not the generic line.
  }
  const again = await w.run("initialize.js", { RELAYER_GENESIS_HASH: w.genesisHash }, [w.state]);
  expect(again.code).toBe(1); expect(again.output).toMatch(/relayer initialization failed: .* already exists; initialization only creates a new directory/);
  const usage = await w.run("initialize.js", { RELAYER_GENESIS_HASH: w.genesisHash });
  expect(usage.output).toMatch(/relayer initialization failed: usage: node dist\/initialize\.js <new state directory>/);
}, 120_000);

it("names unreadable files, a chain mismatch and refused state", async () => {
  const w = await fixture();
  expect((await w.start({ RELAYER_JOURNAL_KEY_PATH: join(w.dir, "absent") })).output).toMatch(/RELAYER_JOURNAL_KEY_PATH: .*absent does not exist/);
  expect((await w.start({ RELAYER_JOURNAL_ID: "cd".repeat(32) })).output)
    .toMatch(/RELAYER_JOURNAL_PATH: .* was refused \(relayer journal identity mismatch\); check RELAYER_JOURNAL_KEY_PATH, RELAYER_JOURNAL_ID/);
  const otherPayer = join(w.dir, "other.json"); writeFileSync(otherPayer, JSON.stringify(Array.from(Keypair.generate().secretKey)));
  expect((await w.start({ GHOSTLINK_RELAYER_KEYPAIR: otherPayer })).output).toMatch(/RELAYER_JOURNAL_PATH: .* was refused \(/);
  w.answer(Keypair.generate().publicKey.toBase58());
  expect((await w.start({})).output).toMatch(/the RPC serves a different chain than RELAYER_GENESIS_HASH/);
  w.answer(w.genesisHash);
  const good = await w.start({});
  expect(good.output).toContain("ghostlink relayer on");
}, 120_000);

it("never prints key material or the parser's view of a damaged keypair", async () => {
  const w = await fixture();
  const secret = "184,22,S3CRET,91";
  const damaged = join(w.dir, "damaged.json"); writeFileSync(damaged, `[${secret}`);
  const parse = await w.start({ GHOSTLINK_RELAYER_KEYPAIR: damaged });
  expect(parse.output).toMatch(/GHOSTLINK_RELAYER_KEYPAIR: .*damaged\.json is not a valid Solana keypair file .*its contents are not shown/);
  expect(parse.output).not.toContain("S3CRET");
  // A well-formed array whose public half does not match: the secret half must not be echoed either.
  const real = Keypair.generate().secretKey, mismatched = Array.from(real); mismatched[40] ^= 1;
  const swapped = join(w.dir, "mismatched.json"); writeFileSync(swapped, JSON.stringify(mismatched));
  const wrong = await w.start({ GHOSTLINK_RELAYER_KEYPAIR: swapped });
  expect(wrong.output).toMatch(/is not a valid Solana keypair file/);
  expect(wrong.output).not.toContain(Array.from(real.subarray(0, 32)).join(","));
  const secretBytes = Buffer.from("K".repeat(31) + "!"), shortKey = join(w.dir, "short-key"); writeFileSync(shortKey, secretBytes.subarray(0, 31));
  const key = await w.start({ RELAYER_JOURNAL_KEY_PATH: shortKey });
  expect(key.output).toMatch(/RELAYER_JOURNAL_KEY_PATH: .* must hold exactly 32 raw key bytes/);
  expect(key.output).not.toContain("KKKKKKKK");
  mkdirSync(join(w.dir, "empty-dir"));
  expect((await w.start({ GHOSTLINK_RELAYER_KEYPAIR: join(w.dir, "empty-dir") })).output).toMatch(/is a directory, not a file/);
}, 120_000);
