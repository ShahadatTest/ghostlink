import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const script = join(root, "scripts", "proving-artifacts.mjs");
const pins = JSON.parse(readFileSync(join(root, "circuits", "keys", "proving-artifacts.json"), "utf8")) as {
  release: string; baseUrl: string; files: Record<string, { path: string; bytes: number; sha256: string }>;
};
const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });

describe("development proving artifact pins", () => {
  it("pin the four files of one release by size and SHA-256", () => {
    expect(Object.keys(pins.files).sort()).toEqual(["login.wasm", "login_dev.zkey", "owner.wasm", "owner_dev.zkey"]);
    expect(pins.baseUrl).toBe(`https://github.com/Ghostlink-Labs/ghostlink/releases/download/${pins.release}`);
    for (const file of Object.values(pins.files)) {
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(Number.isSafeInteger(file.bytes) && file.bytes > 0).toBe(true);
    }
    const listed = run("list");
    expect(listed.status).toBe(0);
    expect(listed.stdout.trim().split("\n")).toHaveLength(4);
  });

  it("refuses a file that does not match its pin and writes nothing", () => {
    const work = mkdtempSync(join(tmpdir(), "ghostlink-artifacts-"));
    try {
      const source = join(work, "source"), target = join(work, "target");
      mkdirSync(source);
      for (const name of Object.keys(pins.files)) writeFileSync(join(source, name), "not the real file");
      const fetched = run("fetch", "--dir", target, "--from", source);
      expect(fetched.status).toBe(1);
      expect(fetched.stderr).toContain("does not match its pin");
      expect(existsSync(target)).toBe(false);

      const verified = run("verify", "--dir", target);
      expect(verified.status).toBe(1);
      expect(verified.stdout).toContain("login.wasm: missing");
    } finally { rmSync(work, { recursive: true, force: true }); }
  });
});
