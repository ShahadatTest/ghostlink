/** The Actions service takes its deployment from GHOSTLINK_DEPLOYMENT, read once per process. */
import { afterEach, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PublicKey } from "@solana/web3.js";
import { LOCALNET_DEPLOYMENT, PUBLIC_GENESIS_HASHES, pocketPda } from "@ghostlink/common";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const id = (byte: number) => new PublicKey(new Uint8Array(32).fill(byte)).toBase58();

it("accepts a public genesis only with that cluster's own manifest, and derives pockets from it", () => {
  const dir = mkdtempSync(join(tmpdir(), "actions-deployment-")); dirs.push(dir);
  const path = join(dir, "devnet.json");
  writeFileSync(path, JSON.stringify({ version: 1, cluster: "devnet", genesisHash: PUBLIC_GENESIS_HASHES.devnet, registryProgram: id(1),
    censusProgram: id(2), pocketProgram: id(3), verifyingKeys: LOCALNET_DEPLOYMENT.verifyingKeys }));
  const operations = pathToFileURL(join(process.cwd(), "dist/operations.js")).href;
  const kit = pathToFileURL(join(process.cwd(), "node_modules/@ghostlink/service-kit/dist/index.js")).href;
  const script = `const { validateGenesis } = await import(${JSON.stringify(operations)}); const { pocketPda } = await import(${JSON.stringify(kit)});
    const results = {}; for (const g of process.argv.slice(1)) { try { validateGenesis(g); results[g] = "ok"; } catch (e) { results[g] = e.message; } }
    console.log(JSON.stringify({ results, pocket: pocketPda(Buffer.alloc(32, 1)).toBase58() }));`;
  const run = (env: Record<string, string | undefined>) => {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, PUBLIC_GENESIS_HASHES.devnet, PUBLIC_GENESIS_HASHES["mainnet-beta"], id(9)],
      { env: { ...process.env, ...env }, encoding: "utf8", windowsHide: true, timeout: 20_000 });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout) as { results: Record<string, string>; pocket: string };
  };
  const custom = run({ GHOSTLINK_DEPLOYMENT: path });
  expect(custom.results[PUBLIC_GENESIS_HASHES.devnet]).toBe("ok");
  expect(custom.results[PUBLIC_GENESIS_HASHES["mainnet-beta"]]).toMatch(/does not match the deployment genesis/);
  expect(custom.results[id(9)]).toMatch(/does not match the deployment genesis/);
  expect(custom.pocket).toBe(new PublicKey(pocketPda(BigInt("0x" + "01".repeat(32)), new PublicKey(id(3)).toBytes()).address).toBase58());
  const env = { ...process.env }; delete env.GHOSTLINK_DEPLOYMENT;
  const builtin = run({ ...env, GHOSTLINK_DEPLOYMENT: undefined });
  expect(builtin.results[PUBLIC_GENESIS_HASHES.devnet]).toMatch(/localnet deployment refuses the devnet genesis/);
  expect(builtin.results[id(9)]).toBe("ok");
  expect(builtin.pocket).toBe(new PublicKey(pocketPda(BigInt("0x" + "01".repeat(32))).address).toBase58());
});
