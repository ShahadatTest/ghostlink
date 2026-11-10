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

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.reverse()) await fn(); cleanup.length = 0; });

async function freePort() {
  const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const address = probe.address(); if (!address || typeof address === "string") throw new Error("port unavailable");
  await new Promise<void>(resolve => probe.close(() => resolve())); return address.port;
}

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "actions-diagnostics-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
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
    value !== undefined && !/^(ACTIONS_|RPC_|GHOSTLINK_|PORT$|OPERATIONS_PORT$|TRUST_PROXY$|CLUSTER$|BASE_URL$)/.test(name)) as [string, string][]);
  async function run(script: string, change: Record<string, string | undefined>, args: string[] = []) {
    const env: Record<string, string | undefined> = { ...base, ...change };
    for (const [name, value] of Object.entries(env)) if (value === undefined) delete env[name];
    const child = spawn(process.execPath, [join(process.cwd(), "dist", script), ...args], { env: env as Record<string, string>, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", bytes => { output += bytes; if (output.includes("ghostlink actions on")) child.kill(); });
    child.stderr.on("data", bytes => { output += bytes; });
    const timer = setTimeout(() => child.kill(), 20_000);
    const [code] = await once(child, "exit") as [number | null];
    clearTimeout(timer);
    return { code, output };
  }
  const env = { ACTIONS_GENESIS_HASH: genesisHash, RPC_URL: `http://127.0.0.1:${address.port}`,
    PORT: String(await freePort()), OPERATIONS_PORT: String(await freePort()) };
  return { dir, genesisHash, start: (change: Record<string, string | undefined>) => run("index.js", { ...env, ...change }),
    answer: (value: string) => { answer = value; } };
}

it("names a missing, malformed or contradictory variable and an unusable manifest", async () => {
  const w = await fixture();
  const cases: [Record<string, string | undefined>, RegExp][] = [
    [{ ACTIONS_GENESIS_HASH: undefined }, /Actions startup failed: ACTIONS_GENESIS_HASH is required/],
    [{ ACTIONS_GENESIS_HASH: "0OIl" }, /ACTIONS_GENESIS_HASH must be a base58 32-byte genesis hash/],
    [{ PORT: "8790", OPERATIONS_PORT: "8790" }, /PORT and OPERATIONS_PORT must differ \(both are 8790\)/],
    [{ CLUSTER: "devnet" }, /CLUSTER is "devnet" but the deployment manifest is localnet; unset CLUSTER/],
    [{ BASE_URL: "actions.example" }, /BASE_URL must be an absolute URL/],
    [{ GHOSTLINK_DEPLOYMENT: join(w.dir, "absent.json") }, /Actions startup failed: GHOSTLINK_DEPLOYMENT: cannot read/],
    [{ ACTIONS_GENESIS_HASH: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" }, /ACTIONS_GENESIS_HASH does not suit the deployment .*refuses the devnet genesis/],
  ];
  for (const [change, expected] of cases) {
    const { code, output } = await w.start(change);
    expect(code, output).toBe(1); expect(output).toMatch(expected);
    expect(output).not.toMatch(/check approved configuration and dependencies/); // Classified, not the generic line.
  }
}, 120_000);

it("names a chain mismatch, an unreachable RPC and an occupied port", async () => {
  const w = await fixture();
  w.answer(Keypair.generate().publicKey.toBase58());
  expect((await w.start({})).output).toMatch(/the RPC serves a different chain than ACTIONS_GENESIS_HASH/);
  w.answer(w.genesisHash);
  const closed = await freePort();
  expect((await w.start({ RPC_URL: `http://127.0.0.1:${closed}` })).output).toMatch(/no RPC endpoint answered \(transport\); check RPC_URL/);
  const busy = createServer(); busy.listen(0); await once(busy, "listening");
  cleanup.push(() => new Promise<void>(resolve => busy.close(() => resolve())));
  const address = busy.address(); if (!address || typeof address === "string") throw new Error("port unavailable");
  expect((await w.start({ PORT: String(address.port) })).output).toMatch(new RegExp(`PORT: port ${address.port} is already in use`));
  expect((await w.start({})).output).toContain("ghostlink actions on");
}, 120_000);

it("never prints RPC credentials", async () => {
  const w = await fixture();
  const endpoints = join(w.dir, "endpoints.json");
  writeFileSync(endpoints, JSON.stringify([{ url: "https://rpc.example/", headers: { "bad header": "S3CRET-TOKEN" } }]));
  const header = await w.start({ RPC_ENDPOINTS_PATH: endpoints });
  expect(header.output).toMatch(/RPC_ENDPOINTS_PATH: Invalid RPC authentication headers/);
  expect(header.output).not.toContain("S3CRET");
  const userinfo = await w.start({ RPC_URL: "https://user:S3CRET-TOKEN@rpc.example/" });
  expect(userinfo.output).toMatch(/RPC_URL: RPC endpoints require HTTPS or loopback HTTP, without userinfo or fragments/);
  expect(userinfo.output).not.toContain("S3CRET");
}, 120_000);
