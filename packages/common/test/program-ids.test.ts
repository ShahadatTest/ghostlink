import { describe, expect, it } from "vitest";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import bs58 from "bs58";
// Plain-Node tooling shared with scripts/deployment.mjs and scripts/build-programs.sh.
// @ts-expect-error The script is JavaScript without declarations.
import { BUILTIN_SOURCES, PROGRAM_SOURCES, disagreements, readPlaces, rewriteProgramSources } from "../../../scripts/program-ids.mjs";
import { LOCALNET_DEPLOYMENT } from "../src/index.js";

type Role = "registryProgram" | "censusProgram" | "pocketProgram";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const builtin = { registryProgram: LOCALNET_DEPLOYMENT.registryProgram, censusProgram: LOCALNET_DEPLOYMENT.censusProgram,
  pocketProgram: LOCALNET_DEPLOYMENT.pocketProgram };

describe("program IDs in source", () => {
  it("agree everywhere with the built-in localnet deployment", () => {
    expect(disagreements(root, [...PROGRAM_SOURCES, ...BUILTIN_SOURCES], builtin)).toEqual([]);
    // Every declaration is found: 5 compiled into the programs, 15 naming the built-in deployment.
    expect(readPlaces(root, PROGRAM_SOURCES)).toHaveLength(5);
    expect(readPlaces(root, BUILTIN_SOURCES)).toHaveLength(15);
  });

  it("rewrites a private copy of the program sources, and the check notices disagreement", () => {
    const work = mkdtempSync(join(tmpdir(), "ghostlink-ids-"));
    try {
      for (const file of new Set<string>(PROGRAM_SOURCES.map((p: { file: string }) => p.file))) {
        cpSync(join(root, file), join(work, file), { recursive: true });
      }
      const ids = { registryProgram: bs58.encode(new Uint8Array(32).fill(1)), censusProgram: bs58.encode(new Uint8Array(32).fill(2)),
        pocketProgram: bs58.encode(new Uint8Array(32).fill(3)) };
      const pocketFile = join(work, "programs/pocket/src/lib.rs");
      writeFileSync(pocketFile, readFileSync(pocketFile, "utf8").replace(`pubkey!("${builtin.censusProgram}")`, `pubkey!("${ids.censusProgram}")`));
      expect(disagreements(work, PROGRAM_SOURCES, builtin)).toEqual([
        `programs/pocket/src/lib.rs: censusProgram is ${ids.censusProgram}, expected ${builtin.censusProgram}`]);
      expect(rewriteProgramSources(work, ids).sort()).toEqual(["programs/census/src/lib.rs", "programs/pocket/src/lib.rs",
        "programs/registry/src/lib.rs"]);
      expect(disagreements(work, PROGRAM_SOURCES, ids)).toEqual([]);
      const pocket = readFileSync(pocketFile, "utf8");
      for (const role of ["registryProgram", "censusProgram", "pocketProgram"] as Role[]) expect(pocket).not.toContain(builtin[role]);
      // Writing the same IDs again changes nothing; a missing declaration refuses before writing.
      expect(rewriteProgramSources(work, ids)).toEqual([]);
      writeFileSync(pocketFile, pocket.replace(/^declare_id!.*$/m, ""));
      expect(() => rewriteProgramSources(work, builtin)).toThrow(/expected 1 pocketProgram declaration\(s\), found 0/);
      expect(readFileSync(join(work, "programs/registry/src/lib.rs"), "utf8")).toContain(ids.registryProgram);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
