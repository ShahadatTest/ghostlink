/** Hosted payer: an approved chain, private key and durable encrypted journal are mandatory. */
import "./preflight.js"; // First: reports a bad GHOSTLINK_DEPLOYMENT before service-kit loads it.
import { DEPLOYMENT, POCKET, REGISTRY, CENSUS } from "@ghostlink/service-kit";
import {
  StartupError, checkDeploymentGenesis, describeStartupFailure, distinctPorts, integerVariable, lamportsVariable, listen, openRpc,
  openState, portVariable, probeRpc, readKeypair, readStorageKey, requireGenesis, requirePin, requireVariable,
} from "@ghostlink/service-kit/startup";
import { domainHash, fieldToBytes32 } from "@ghostlink/common";
import { buildServer } from "./server.js";
import { RelayerJournal } from "./journal.js";
import { operatorServer } from "./operations.js";
import type { Server } from "node:http";

async function main() {
  const env = process.env;
  const genesisHash = requireGenesis(env, "RELAYER_GENESIS_HASH");
  const keypairPath = requireVariable(env, "GHOSTLINK_RELAYER_KEYPAIR", "the payer.json created by dist/initialize.js");
  const journalPath = requireVariable(env, "RELAYER_JOURNAL_PATH", "the journal.sqlite created by dist/initialize.js");
  const journalKeyPath = requireVariable(env, "RELAYER_JOURNAL_KEY_PATH", "the storage-key created by dist/initialize.js");
  const journalId = requirePin(env, "RELAYER_JOURNAL_ID", "journalId");
  checkDeploymentGenesis("RELAYER_GENESIS_HASH", DEPLOYMENT, genesisHash);
  // No automatic migration can prove whether an old ambiguous send was accepted.
  if (env.RELAYER_BUDGET_PATH) throw new StartupError("RELAYER_BUDGET_PATH is set: legacy spend state needs reconciliation before switching to the journal (docs/RELAYER-OPERATIONS.md)");
  const port = portVariable(env, "PORT", 8788);
  const operationsPort = portVariable(env, "OPERATIONS_PORT", 18788);
  distinctPorts({ PORT: port, OPERATIONS_PORT: operationsPort });
  const dailyBudget = lamportsVariable(env, "RELAYER_DAILY_BUDGET_LAMPORTS", "2000000000");
  const maxSnapshotFeeLamports = lamportsVariable(env, "RELAYER_MAX_SNAPSHOT_FEE_LAMPORTS", "1000000");
  const payer = readKeypair("GHOSTLINK_RELAYER_KEYPAIR", keypairPath);
  const rpc = openRpc(env, genesisHash);
  let journal: RelayerJournal | undefined;
  let server: ReturnType<typeof buildServer> | undefined, operator: Server | undefined;
  try {
    await probeRpc(rpc, "RELAYER_GENESIS_HASH");
    const key = readStorageKey("RELAYER_JOURNAL_KEY_PATH", journalKeyPath);
    try {
      journal = openState("RELAYER_JOURNAL_PATH", journalPath,
        "check RELAYER_JOURNAL_KEY_PATH, RELAYER_JOURNAL_ID, GHOSTLINK_RELAYER_KEYPAIR, RELAYER_GENESIS_HASH and GHOSTLINK_DEPLOYMENT against its deployment.json",
        () => RelayerJournal.openExisting(journalPath, key, { genesisHash, payer: payer.publicKey.toBase58(),
          pocket: POCKET.toBase58(), registry: REGISTRY.toBase58(), census: CENSUS.toBase58() }, journalId, dailyBudget));
    } finally { key.fill(0); }
    const origins = env.RELAYER_ALLOWED_ORIGINS?.split(",").map(s => s.trim()).filter(Boolean);
    server = buildServer({ connection: rpc.connection, payer, journal,
      allowedDomainHashes: origins?.length ? new Set(origins.map(o => Buffer.from(fieldToBytes32(domainHash(o))).toString("hex"))) : undefined,
      trustProxy: env.TRUST_PROXY === "1",
      minimumBalanceLamports: Number(env.RELAYER_MIN_BALANCE_LAMPORTS ?? 50_000_000),
      maxSnapshotFeeLamports, maxInFlight: Number(env.RELAYER_MAX_IN_FLIGHT ?? 8) });
    operator = operatorServer(server.operations, rpc.status);
    await listen(operator, operationsPort, "OPERATIONS_PORT", "127.0.0.1");
    await listen(server, port, "PORT");
    let stopping = false;
    const shutdown = () => {
      if (stopping) return;
      stopping = true; server!.drain();
      let httpClosed = false;
      server!.close(() => { httpClosed = true; });
      const deadline = setTimeout(() => { server!.closeAllConnections(); operator!.closeAllConnections(); rpc.close(); journal?.close(); process.exit(1); }, 30_000);
      deadline.unref();
      const wait = setInterval(() => {
        if (!httpClosed || !server!.operations.idle) return;
        clearInterval(wait); clearTimeout(deadline); server!.operations.stop(); operator!.close(); rpc.close(); journal?.close();
      }, 50);
    };
    process.once("SIGTERM", shutdown); process.once("SIGINT", shutdown);
    console.log(`ghostlink relayer on :${port}, payer ${payer.publicKey.toBase58()}`);
  } catch (error) { server?.operations.stop(); server?.close(); operator?.close(); rpc.close(); journal?.close(); throw error; }
}
void main().catch(error => {
  console.error(describeStartupFailure("relayer startup failed", error, "relayer startup failed; check approved configuration, legacy migration and dependencies"));
  process.exitCode = 1;
});
