/**
 * Where program IDs live in source, so they can be checked and rewritten.
 *
 * PROGRAM_SOURCES are compiled into the programs: a deployment build
 * (scripts/build-programs.sh --deployment) rewrites them in a private copy
 * of the Rust workspace, never in this checkout. BUILTIN_SOURCES name the
 * built-in localnet deployment for tools and tests and always keep the
 * committed IDs. packages/common/test/program-ids.test.ts checks that every
 * place agrees with LOCALNET_DEPLOYMENT.
 *
 * No dependencies: plain Node, so it runs before anything is built.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ID = "([1-9A-HJ-NP-Za-km-z]{32,44})";

/** @typedef {"registryProgram" | "censusProgram" | "pocketProgram"} Role */
/** @typedef {{ file: string, role: Role, pattern: RegExp, count: number }} Place */

/** @type {Place[]} */
export const PROGRAM_SOURCES = [
  { file: "programs/registry/src/lib.rs", role: "registryProgram", pattern: new RegExp(`^declare_id!\\("${ID}"\\);$`, "gm"), count: 1 },
  { file: "programs/census/src/lib.rs", role: "censusProgram", pattern: new RegExp(`^declare_id!\\("${ID}"\\);$`, "gm"), count: 1 },
  { file: "programs/pocket/src/lib.rs", role: "pocketProgram", pattern: new RegExp(`^declare_id!\\("${ID}"\\);$`, "gm"), count: 1 },
  { file: "programs/pocket/src/lib.rs", role: "registryProgram",
    pattern: new RegExp(`^pub const REGISTRY_PROGRAM_ID: Pubkey = pubkey!\\("${ID}"\\);$`, "gm"), count: 1 },
  { file: "programs/pocket/src/lib.rs", role: "censusProgram",
    pattern: new RegExp(`^pub const CENSUS_PROGRAM_ID: Pubkey = pubkey!\\("${ID}"\\);$`, "gm"), count: 1 },
];

/** @type {Place[]} */
export const BUILTIN_SOURCES = [
  { file: "packages/common/src/constants.ts", role: "registryProgram", pattern: new RegExp(`^export const REGISTRY_PROGRAM_ID = "${ID}";$`, "gm"), count: 1 },
  { file: "packages/common/src/constants.ts", role: "censusProgram", pattern: new RegExp(`^export const CENSUS_PROGRAM_ID = "${ID}";$`, "gm"), count: 1 },
  { file: "packages/common/src/constants.ts", role: "pocketProgram", pattern: new RegExp(`^export const POCKET_PROGRAM_ID = "${ID}";$`, "gm"), count: 1 },
  // Both the localnet and the (V1) devnet sections.
  { file: "Anchor.toml", role: "registryProgram", pattern: new RegExp(`^ghostlink_registry = "${ID}"$`, "gm"), count: 2 },
  { file: "Anchor.toml", role: "censusProgram", pattern: new RegExp(`^ghostlink_census = "${ID}"$`, "gm"), count: 2 },
  { file: "Anchor.toml", role: "pocketProgram", pattern: new RegExp(`^ghostlink_pocket = "${ID}"$`, "gm"), count: 2 },
  { file: "programs/itests/tests/common/mod.rs", role: "registryProgram", pattern: new RegExp(`^pub const REGISTRY_ID: &str = "${ID}";$`, "gm"), count: 1 },
  { file: "programs/itests/tests/common/mod.rs", role: "censusProgram", pattern: new RegExp(`^pub const CENSUS_ID: &str = "${ID}";$`, "gm"), count: 1 },
  { file: "programs/itests/tests/common/mod.rs", role: "pocketProgram", pattern: new RegExp(`^pub const POCKET_ID: &str = "${ID}";$`, "gm"), count: 1 },
  { file: "scripts/jupiter-localnet-e2e.sh", role: "registryProgram", pattern: new RegExp(`--bpf-program ${ID} "\\$DEPLOY_DIR/ghostlink_registry\\.so"`, "gm"), count: 1 },
  { file: "scripts/jupiter-localnet-e2e.sh", role: "censusProgram", pattern: new RegExp(`--bpf-program ${ID} "\\$DEPLOY_DIR/ghostlink_census\\.so"`, "gm"), count: 1 },
  { file: "scripts/jupiter-localnet-e2e.sh", role: "pocketProgram", pattern: new RegExp(`--bpf-program ${ID} "\\$DEPLOY_DIR/ghostlink_pocket\\.so"`, "gm"), count: 1 },
];

/**
 * Reads every place under `root`. Throws when a pattern does not match the
 * expected number of times, so a moved or reformatted ID fails loudly.
 * @param {string} root
 * @param {Place[]} places
 * @returns {{ file: string, role: Role, value: string }[]}
 */
export function readPlaces(root, places) {
  return places.flatMap(place => {
    const matches = [...readFileSync(join(root, place.file), "utf8").matchAll(place.pattern)];
    if (matches.length !== place.count) {
      throw new Error(`${place.file}: expected ${place.count} ${place.role} declaration(s), found ${matches.length}`);
    }
    return matches.map(m => ({ file: place.file, role: place.role, value: /** @type {string} */ (m[1]) }));
  });
}

/**
 * Lists every place whose value differs from `ids` (empty when all agree).
 * @param {string} root
 * @param {Place[]} places
 * @param {Record<Role, string>} ids
 */
export function disagreements(root, places, ids) {
  return readPlaces(root, places).filter(p => p.value !== ids[p.role])
    .map(p => `${p.file}: ${p.role} is ${p.value}, expected ${ids[p.role]}`);
}

/**
 * Writes `ids` into PROGRAM_SOURCES under `root` (a private copy of the Rust
 * workspace) and returns the files changed. Throws, before writing anything,
 * if a place is missing or ambiguous.
 * @param {string} root
 * @param {Record<Role, string>} ids
 */
export function rewriteProgramSources(root, ids) {
  readPlaces(root, PROGRAM_SOURCES);
  const files = [...new Set(PROGRAM_SOURCES.map(p => p.file))];
  const changed = [];
  for (const file of files) {
    const path = join(root, file), before = readFileSync(path, "utf8");
    let after = before;
    for (const place of PROGRAM_SOURCES.filter(p => p.file === file)) {
      after = after.replace(place.pattern, (line, old) => line.replace(old, ids[place.role]));
    }
    if (after !== before) { writeFileSync(path, after); changed.push(file); }
  }
  const left = disagreements(root, PROGRAM_SOURCES, ids);
  if (left.length) throw new Error(`program ID rewrite incomplete:\n${left.join("\n")}`);
  return changed;
}
