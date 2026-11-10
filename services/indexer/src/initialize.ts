/** Explicit fresh archival rebuild provisioning; no network access or service startup. */
import "./preflight.js"; // First: reports a bad GHOSTLINK_DEPLOYMENT before service-kit loads it.
import { existsSync, mkdirSync, writeFileSync, openSync, fsyncSync, closeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, dirname, resolve } from "node:path";
import { CENSUS, DEPLOYMENT, POCKET, REGISTRY } from "@ghostlink/service-kit";
import { StartupError, checkDeploymentGenesis, describeStartupFailure, requireGenesis } from "@ghostlink/service-kit/startup";
import { IndexerDatabase } from "./database.js";

function main() {
  const [directory, ...extra] = process.argv.slice(2);
  if (!directory || extra.length) throw new StartupError("usage: node dist/initialize.js <new state directory>");
  const genesisHash = requireGenesis(process.env, "INDEXER_GENESIS_HASH");
  // Public chains need a deployment manifest with their own programs (GHOSTLINK_DEPLOYMENT).
  checkDeploymentGenesis("INDEXER_GENESIS_HASH", DEPLOYMENT, genesisHash);
  if (existsSync(directory)) throw new StartupError(`${directory} already exists; initialization only creates a new directory and never adopts or overwrites state`);
  mkdirSync(directory, { mode: 0o700 });
  const key = randomBytes(32), scope = { genesisHash, programs: [REGISTRY, CENSUS, POCKET].map(p => p.toBase58()), commitment: "finalized" };
  const write = (name: string, data: string | Uint8Array) => writeFileSync(join(directory, name), data, { flag: "wx", mode: 0o600, flush: true });
  let database: IndexerDatabase | undefined;
  try {
    write("state-key", key);
    database = new IndexerDatabase(join(directory, "state.sqlite"), key, JSON.stringify(scope));
    const stateId = database.instanceId; if (!stateId) throw new Error("state identity missing");
    database.close(); database = undefined;
    write("scope.json", JSON.stringify(scope, null, 2) + "\n");
    // Completion manifest is last. A partial directory must never be adopted automatically.
    write("deployment.json", JSON.stringify({ stateId, scope, files: { state: "state.sqlite", stateKey: "state-key", scope: "scope.json" } }, null, 2) + "\n");
    if (process.platform !== "win32") for (const path of [directory, dirname(resolve(directory))]) {
      const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
    }
    console.log("Fresh indexer state initialized. Pin deployment.json independently; reconcile archival history before switching clients.");
  } finally { database?.close(); key.fill(0); }
}
try { main(); } catch (error) {
  console.error(describeStartupFailure("indexer initialization failed", error,
    "Indexer initialization failed; use a new directory and approved development chain. Inspect partial output before retrying."));
  process.exitCode = 1;
}
