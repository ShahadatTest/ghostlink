/** Hosted indexer: finalized ordered history, scoped durable state, bounded work and drain. */
import "./preflight.js"; // First: reports a bad GHOSTLINK_DEPLOYMENT before service-kit loads it.
import { CENSUS, DEPLOYMENT, POCKET, REGISTRY } from "@ghostlink/service-kit";
import {
  StartupError, checkDeploymentGenesis, describeStartupFailure, integerVariable, listen, openRpc, openState, portVariable,
  probeRpc, readStorageKey, requireGenesis, requirePin, requireVariable,
} from "@ghostlink/service-kit/startup";
import { buildServer } from "./server.js";
import { IndexerStore } from "./store.js";
import { Poller } from "./poller.js";
import { IndexerDatabase } from "./database.js";

async function main() {
  const env = process.env;
  const genesisHash = requireGenesis(env, "INDEXER_GENESIS_HASH");
  const path = requireVariable(env, "INDEXER_STATE_PATH", "the state.sqlite file created by dist/initialize.js");
  const keyPath = requireVariable(env, "INDEXER_STATE_KEY_PATH", "the state-key file created by dist/initialize.js");
  const stateId = requirePin(env, "INDEXER_STATE_ID", "stateId");
  if (!env.RPC_URL && !env.RPC_ENDPOINTS_PATH) throw new StartupError("RPC_URL or RPC_ENDPOINTS_PATH is required: the RPC of the chain to index");
  checkDeploymentGenesis("INDEXER_GENESIS_HASH", DEPLOYMENT, genesisHash);
  if (env.PERSIST_PATH) throw new StartupError("PERSIST_PATH is set: legacy indexer JSON needs an independently checked migration; unset it and rebuild from chain history");
  if (env.INGEST_COMMITMENT && env.INGEST_COMMITMENT !== "finalized") throw new StartupError("INGEST_COMMITMENT must be finalized (or unset) for the hosted indexer");
  const port = portVariable(env, "PORT", 8787), interval = integerVariable(env, "POLL_MS", 5000, 50, 30_000);
  const rpc = openRpc(env, genesisHash);
  let database: IndexerDatabase | undefined;
  try {
    await probeRpc(rpc, "INDEXER_GENESIS_HASH");
    const key = readStorageKey("INDEXER_STATE_KEY_PATH", keyPath);
    try {
      database = openState("INDEXER_STATE_PATH", path, "check INDEXER_STATE_KEY_PATH, INDEXER_STATE_ID, INDEXER_GENESIS_HASH and GHOSTLINK_DEPLOYMENT against its deployment.json",
        () => IndexerDatabase.openExisting(path, key, JSON.stringify({ genesisHash, programs: [REGISTRY, CENSUS, POCKET].map(p => p.toBase58()), commitment: "finalized" }), stateId));
    } finally { key.fill(0); }
    const store = new IndexerStore(undefined, snapshot => database!.save(snapshot));
    const poller = new Poller(rpc.connection, store, undefined, undefined, "finalized", { database, reconcileRoots: true,
      maximumPages: Number(env.INDEXER_PAGES_PER_TICK ?? 4),
      maximumTransactions: Number(env.INDEXER_TRANSACTIONS_PER_TICK ?? 32),
      maximumTickMs: Number(env.INDEXER_TICK_BUDGET_MS ?? 10_000),
      paceMs: Number(env.INDEXER_PACE_MS ?? 120) });
    const poll = () => { void poller.tick().catch(() => console.error("indexer poll failed; retaining durable progress")); };
    const server = buildServer(store, { poller: poller.status, database, webhookSecret: env.WEBHOOK_SECRET, onIngestionHint: poll });
    await listen(server, port, "PORT");
    const timer = poller.start(interval), lease = setInterval(() => {
      try { database!.renew(); } catch { shutdown(true); }
    }, 15_000);
    let stopping = false;
    const shutdown = (failed = false) => {
      if (stopping) return;
      stopping = true; clearInterval(timer); clearInterval(lease); server.drain(); poller.drain(); server.close();
      const deadline = setTimeout(() => { server.closeAllConnections(); rpc.close(); database?.close(); process.exit(1); }, 30_000);
      deadline.unref();
      const wait = setInterval(() => {
        if (!poller.idle || server.active) return;
        clearInterval(wait); clearTimeout(deadline); server.closeAllConnections(); rpc.close(); database?.close();
        if (failed) process.exitCode = 1;
      }, 50);
    };
    process.once("SIGTERM", () => shutdown()); process.once("SIGINT", () => shutdown());
    poll(); console.log(`ghostlink indexer on :${port}`);
  } catch (error) { rpc.close(); database?.close(); throw error; }
}
void main().catch(error => {
  console.error(describeStartupFailure("indexer startup failed", error, "indexer startup failed; check approved configuration and state"));
  process.exitCode = 1;
});
