/** Explicit fresh-solver provisioning. Never adopts an existing payer or overwrites state. */
import "./preflight.js"; // First: reports a bad GHOSTLINK_DEPLOYMENT before service-kit loads it.
import { existsSync, mkdirSync, writeFileSync, openSync, fsyncSync, closeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, dirname, resolve } from "node:path";
import { Keypair } from "@solana/web3.js";
import { DEPLOYMENT, POCKET } from "@ghostlink/service-kit";
import { StartupError, checkDeploymentGenesis, describeStartupFailure, requireGenesis } from "@ghostlink/service-kit/startup";
import { SubmissionJournal } from "./journal.js";

function main() {
  const [directory, ...extra] = process.argv.slice(2);
  if (!directory || extra.length) throw new StartupError("usage: node dist/initialize.js <new state directory>");
  const genesisHash = requireGenesis(process.env, "SOLVER_GENESIS_HASH");
  // Public chains need a deployment manifest with their own programs (GHOSTLINK_DEPLOYMENT).
  checkDeploymentGenesis("SOLVER_GENESIS_HASH", DEPLOYMENT, genesisHash);
  if (existsSync(directory)) throw new StartupError(`${directory} already exists; initialization only creates a new directory and never adopts or overwrites state`);
  mkdirSync(directory, { mode: 0o700 });
  const payer = Keypair.generate(), key = randomBytes(32);
  const scope = { genesisHash, pocketProgram: POCKET.toBase58(), solver: payer.publicKey.toBase58() };
  let journal: SubmissionJournal | undefined;
  try {
    writeFileSync(join(directory, "payer.json"), JSON.stringify(Array.from(payer.secretKey)) + "\n", { flag: "wx", mode: 0o600, flush: true });
    writeFileSync(join(directory, "storage-key"), key, { flag: "wx", mode: 0o600, flush: true });
    journal = new SubmissionJournal(join(directory, "journal.sqlite"), key, scope);
    const journalId = journal.instanceId;
    if (!journalId) throw new Error("journal identity lost during initialization");
    journal.close(); journal = undefined;
    writeFileSync(join(directory, "scope.json"), JSON.stringify(scope, null, 2) + "\n", { flag: "wx", mode: 0o600, flush: true });
    // Written last: an absent deployment.json means provisioning did not finish.
    writeFileSync(join(directory, "deployment.json"), JSON.stringify({ scope, journalId,
      files: { payer: "payer.json", storageKey: "storage-key", journal: "journal.sqlite", scope: "scope.json" } }, null, 2) + "\n", { flag: "wx", mode: 0o600, flush: true });
    if (process.platform !== "win32") for (const path of [directory, dirname(resolve(directory))]) {
      const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
    }
    console.log("Fresh solver payer and journal initialized. Pin deployment.json in operator configuration before funding the payer.");
  } finally { journal?.close(); key.fill(0); }
}
try { main(); } catch (error) {
  console.error(describeStartupFailure("solver initialization failed", error,
    "Solver initialization failed; use a new directory and an approved development genesis. Inspect partial output before retrying."));
  process.exitCode = 1;
}
