/**
 * Entry point. Environment:
 *   PORT (default 8789)
 *   OPERATIONS_PORT (default 18789, loopback only; must differ from PORT)
 *   SOLVER_MIN_BALANCE_LAMPORTS (default 5000000, at least maximum network fee)
 *   RPC_URL (default http://127.0.0.1:8899)
 *   RPC_ENDPOINTS_PATH — private JSON array of {url, headers?}; overrides RPC_URL
 *   GHOSTLINK_SOLVER_KEYPAIR — path to the solver keypair JSON
 *   SOLVER_JOURNAL_PATH — persistent SQLite path outside the repository
 *   SOLVER_JOURNAL_KEY_PATH — file with 32 raw random encryption-key bytes
 *   SOLVER_JOURNAL_ID — independently pinned 64-hex journal instance identity
 *   SOLVER_GENESIS_HASH — independently approved local-validator genesis
 *   PRICE_ACCOUNTS — JSON map of mint base58 -> Pyth price update account
 *   SOLVER_MAX_SPREAD_BPS — how far above the input's value a fill may go (default 100)
 *   SOLVER_ALLOW_UNPRICED=1 — fill output mints without a price (NFT-style)
 *   SOLVER_CREATE_POCKET_ATA=1 — pay rent for missing pocket output accounts
 *   SOLVER_MAX_COMPUTE_UNITS — cap full-fill compute (default 1400000)
 *   SOLVER_PRIORITY_MICRO_LAMPORTS — operator-fixed CU price (default 0)
 *   SOLVER_MAX_NETWORK_FEE_LAMPORTS — network fee ceiling, excludes rent (default 20000)
 *   SOLVER_ROUTER — inventory (default) or experimental jupiter-raydium-cp
 *   JUPITER_API_KEY_PATH — private text file, required for Jupiter
 *   JUPITER_POOLS_PATH — JSON array of explicitly approved classic-SPL pools
 *   JUPITER_SLIPPAGE_BPS — fixed quote tolerance, 0..500 (default 50)
 *   TRUST_PROXY=1 — honour X-Forwarded-For (only behind your own proxy)
 */
import "./preflight.js"; // First: reports a bad GHOSTLINK_DEPLOYMENT before service-kit loads it.
import {
  StartupError, checkDeploymentGenesis, describeStartupFailure, distinctPorts, listen, openRpc, openState, portVariable, probeRpc,
  readKeypair, readPrivateFile, readStorageKey, requireGenesis, requirePin, requireVariable,
} from "@ghostlink/service-kit/startup";
import { buildServer, MockPlanner } from "./server.js";
import { SubmissionJournal } from "./journal.js";
import { DEPLOYMENT, POCKET } from "@ghostlink/service-kit";
import { DEFAULT_TRANSACTION_LIMITS } from "./transactions.js";
import { JupiterPlanner } from "./jupiter.js";
import { operatorServer } from "./operations.js";

async function main(): Promise<void> {
  const env = process.env;
  const genesisHash = requireGenesis(env, "SOLVER_GENESIS_HASH");
  const keypairPath = requireVariable(env, "GHOSTLINK_SOLVER_KEYPAIR", "the payer.json created by dist/initialize.js (outside the repository)");
  const journalPath = requireVariable(env, "SOLVER_JOURNAL_PATH", "the journal.sqlite created by dist/initialize.js");
  const journalKeyPath = requireVariable(env, "SOLVER_JOURNAL_KEY_PATH", "the storage-key created by dist/initialize.js");
  const journalId = requirePin(env, "SOLVER_JOURNAL_ID", "journalId");
  checkDeploymentGenesis("SOLVER_GENESIS_HASH", DEPLOYMENT, genesisHash);
  const port = portVariable(env, "PORT", 8789);
  const operationsPort = portVariable(env, "OPERATIONS_PORT", 18789);
  distinctPorts({ PORT: port, OPERATIONS_PORT: operationsPort });
  const router = env.SOLVER_ROUTER ?? "inventory";
  if (router !== "inventory" && router !== "jupiter-raydium-cp") throw new StartupError("SOLVER_ROUTER must be inventory or jupiter-raydium-cp");
  let priceAccounts: Record<string, string> = {};
  if (env.PRICE_ACCOUNTS) {
    try { priceAccounts = JSON.parse(env.PRICE_ACCOUNTS) as Record<string, string>; } catch {
      throw new StartupError("PRICE_ACCOUNTS must be a JSON object mapping mint addresses to price update accounts");
    }
  }
  const keypair = readKeypair("GHOSTLINK_SOLVER_KEYPAIR", keypairPath);
  const rpc = openRpc(env, genesisHash);
  const connection = rpc.connection;
  await probeRpc(rpc, "SOLVER_GENESIS_HASH");
  function privateText(name: string, maximum: number): string {
    const path = requireVariable(env, name, `a private configuration file for SOLVER_ROUTER=${router}`);
    return readPrivateFile(name, path, maximum).toString("utf8").trim();
  }
  let pools: unknown;
  if (router !== "inventory") {
    try { pools = JSON.parse(privateText("JUPITER_POOLS_PATH", 32_768)); } catch (error) {
      if (error instanceof StartupError) throw error;
      throw new StartupError("JUPITER_POOLS_PATH must hold a JSON array of approved pools");
    }
  }
  const planner = router === "inventory" ? new MockPlanner() : new JupiterPlanner(connection, {
    apiKey: privateText("JUPITER_API_KEY_PATH", 512),
    pools: pools as ConstructorParameters<typeof JupiterPlanner>[1]["pools"],
    slippageBps: Number(env.JUPITER_SLIPPAGE_BPS ?? 50),
  });
  const journalKey = readStorageKey("SOLVER_JOURNAL_KEY_PATH", journalKeyPath);
  let journal: SubmissionJournal;
  try {
    journal = openState("SOLVER_JOURNAL_PATH", journalPath,
      "check SOLVER_JOURNAL_KEY_PATH, SOLVER_JOURNAL_ID, GHOSTLINK_SOLVER_KEYPAIR, SOLVER_GENESIS_HASH and GHOSTLINK_DEPLOYMENT against its deployment.json",
      () => SubmissionJournal.openExisting(journalPath, journalKey, { genesisHash, pocketProgram: POCKET.toBase58(), solver: keypair.publicKey.toBase58() }, journalId));
  } finally { journalKey.fill(0); }

  const server = buildServer({
    connection,
    keypair,
    planner,
    journal,
    transactionLimits: {
      maxComputeUnits: Number(process.env.SOLVER_MAX_COMPUTE_UNITS ?? DEFAULT_TRANSACTION_LIMITS.maxComputeUnits),
      priorityMicroLamports: BigInt(process.env.SOLVER_PRIORITY_MICRO_LAMPORTS ?? DEFAULT_TRANSACTION_LIMITS.priorityMicroLamports),
      maxNetworkFeeLamports: BigInt(process.env.SOLVER_MAX_NETWORK_FEE_LAMPORTS ?? DEFAULT_TRANSACTION_LIMITS.maxNetworkFeeLamports),
    },
    priceAccounts,
    maxQuoteSpreadBps: process.env.SOLVER_MAX_SPREAD_BPS ? Number(process.env.SOLVER_MAX_SPREAD_BPS) : undefined,
    allowUnpriced: process.env.SOLVER_ALLOW_UNPRICED === "1",
    createPocketAta: process.env.SOLVER_CREATE_POCKET_ATA === "1",
    trustProxy: process.env.TRUST_PROXY === "1",
    minimumBalanceLamports: Number(process.env.SOLVER_MIN_BALANCE_LAMPORTS ?? 5_000_000),
  });
  const operator = operatorServer(server.operations, rpc.status);
  let stopping = false;
  function shutdown() {
    if (stopping) return;
    stopping = true; server.operations.drain();
    // A forced stop leaves exact packets in the journal for reconciliation.
    const deadline = setTimeout(() => {
      clearInterval(drainCheck);
      server.closeAllConnections(); operator.closeAllConnections(); rpc.close(); journal.close(); process.exit(1);
    }, 30_000);
    deadline.unref();
    let httpClosed = false;
    server.close(() => { httpClosed = true; });
    // Disconnected clients can leave preparation/submission work running after
    // Node's server-close callback. Keep its journal open until that work settles.
    const drainCheck = setInterval(() => {
      if (!httpClosed || server.operations.snapshot().active !== 0) return;
      clearInterval(drainCheck); clearTimeout(deadline);
      server.operations.stop(); rpc.close(); journal.close(); operator.close();
    }, 50);
    drainCheck.unref();
  }
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  await listen(operator, operationsPort, "OPERATIONS_PORT", "127.0.0.1");
  await listen(server, port, "PORT");
  console.log(`ghostlink solver on :${port}, identity ${keypair.publicKey.toBase58()}`);
}

// Classified configuration and state problems are named (see @ghostlink/service-kit/startup);
// anything else is reported generically, since a raw parse error of a damaged keypair file can
// quote secret-key bytes. Exit at once, as an uncaught startup error would, so no handle keeps it alive.
void main().catch(error => {
  console.error(describeStartupFailure("solver startup failed", error, "solver startup failed; check approved configuration, keys, journal and dependencies"));
  process.exit(1);
});
