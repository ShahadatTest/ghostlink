import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { LOCALNET_DEPLOYMENT, PUBLIC_GENESIS_HASHES, toBase58 } from "@ghostlink/common";
import { DEPLOYMENT, POCKET, loadDeploymentConfig } from "../src/index.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const address = (byte: number) => toBase58(new Uint8Array(32).fill(byte));
const devnet = { version: 1, cluster: "devnet", genesisHash: PUBLIC_GENESIS_HASHES.devnet, registryProgram: address(1),
  censusProgram: address(2), pocketProgram: address(3), verifyingKeys: LOCALNET_DEPLOYMENT.verifyingKeys };
function file(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ghostlink-deployment-")); dirs.push(dir);
  const path = join(dir, "deployment.json"); writeFileSync(path, contents); return path;
}

describe("deployment configuration", () => {
  it("defaults to the built-in localnet deployment", () => {
    expect(loadDeploymentConfig({})).toBe(LOCALNET_DEPLOYMENT);
    // The test process sets no GHOSTLINK_DEPLOYMENT.
    expect(DEPLOYMENT).toBe(LOCALNET_DEPLOYMENT);
    expect(POCKET.toBase58()).toBe(LOCALNET_DEPLOYMENT.pocketProgram);
  });

  it("reads one manifest file and refuses bad configuration with the reason", () => {
    expect(loadDeploymentConfig({ GHOSTLINK_DEPLOYMENT: file(JSON.stringify(devnet)) })).toEqual(devnet);
    expect(() => loadDeploymentConfig({ GHOSTLINK_DEPLOYMENT: "" })).toThrow(/set but empty/);
    expect(() => loadDeploymentConfig({ GHOSTLINK_DEPLOYMENT: join(tmpdir(), "missing-ghostlink-manifest.json") })).toThrow(/cannot read/);
    expect(() => loadDeploymentConfig({ GHOSTLINK_DEPLOYMENT: file("{") })).toThrow(/is not JSON/);
    expect(() => loadDeploymentConfig({ GHOSTLINK_DEPLOYMENT: file(" ".repeat(20_000)) })).toThrow(/too large/);
    expect(() => loadDeploymentConfig({ GHOSTLINK_DEPLOYMENT: file(JSON.stringify({ ...devnet, pocketProgram: LOCALNET_DEPLOYMENT.pocketProgram })) }))
      .toThrow(/GHOSTLINK_DEPLOYMENT: .*pocketProgram uses a built-in program ID/);
  });

  it("builds instructions, PDAs and event filters for the configured programs in a fresh process", () => {
    const dist = pathToFileURL(join(process.cwd(), "dist/index.js")).href;
    const script = `const k = await import(${JSON.stringify(dist)}); const e = k.EVENT_EMITTER;
      console.log(JSON.stringify([k.REGISTRY.toBase58(), k.CENSUS.toBase58(), k.POCKET.toBase58(), e.Registered, e.SnapshotTaken, e.Filled,
        k.initializeIx("census", k.POCKET).programId.toBase58(), k.registryTreePda().toBase58()]));`;
    const run = (env: Record<string, string>) => spawnSync(process.execPath, ["--input-type=module", "-e", script],
      { env: { ...process.env, ...env }, encoding: "utf8", windowsHide: true, timeout: 20_000 });
    const custom = run({ GHOSTLINK_DEPLOYMENT: file(JSON.stringify(devnet)) });
    expect(custom.status, custom.stderr).toBe(0);
    const [registry, census, pocket, registered, snapshot, filled, initProgram, tree] = JSON.parse(custom.stdout);
    expect([registry, census, pocket, registered, snapshot, filled, initProgram]).toEqual([address(1), address(2), address(3),
      address(1), address(2), address(3), address(2)]);
    const builtin = run({ GHOSTLINK_DEPLOYMENT: "" });
    expect(builtin.status).not.toBe(0);
    expect(builtin.stderr).toMatch(/GHOSTLINK_DEPLOYMENT is set but empty/);
    const env = { ...process.env }; delete env.GHOSTLINK_DEPLOYMENT;
    const unset = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env, encoding: "utf8", windowsHide: true, timeout: 20_000 });
    expect(unset.status, unset.stderr).toBe(0);
    expect(JSON.parse(unset.stdout)[7]).not.toBe(tree);
  });
});
