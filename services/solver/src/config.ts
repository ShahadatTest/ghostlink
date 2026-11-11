import { StartupError } from "@ghostlink/service-kit/startup";
import { PublicKey } from "@solana/web3.js";
import { DEFAULT_TRANSACTION_LIMITS } from "./transactions.js";

function decimalVariable(env: NodeJS.ProcessEnv, name: string, fallback: number | bigint,
  minimum: number | bigint, maximum: number | bigint): bigint {
  const raw = env[name];
  if (raw === undefined) return BigInt(fallback);
  if (/^[0-9]+$/.test(raw.trim())) {
    const value = BigInt(raw);
    if (value >= minimum && value <= maximum) return value;
  }
  throw new StartupError(name + " must be a decimal integer from " + minimum + " to " + maximum);
}

function parsePriceAccounts(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value === "object" && value !== null && !Array.isArray(value) &&
      Object.entries(value).every(([mint, account]) =>
        typeof account === "string" && new PublicKey(mint).toBase58() === mint &&
        new PublicKey(account).toBase58() === account)) {
      return value as Record<string, string>;
    }
  } catch {
    // JSON and public-key parser errors can include the supplied values.
  }
  throw new StartupError("PRICE_ACCOUNTS must be a JSON object mapping mint addresses to price update accounts");
}

export function readSolverConfig(env: NodeJS.ProcessEnv, useJupiter: boolean) {
  const limits = DEFAULT_TRANSACTION_LIMITS;
  const maxComputeUnits = Number(decimalVariable(env, "SOLVER_MAX_COMPUTE_UNITS", limits.maxComputeUnits, 1, 1_400_000));
  const priorityMicroLamports = decimalVariable(env, "SOLVER_PRIORITY_MICRO_LAMPORTS", limits.priorityMicroLamports, 0, 0xffffffffffffffffn);
  const maxNetworkFeeLamports = decimalVariable(env, "SOLVER_MAX_NETWORK_FEE_LAMPORTS", limits.maxNetworkFeeLamports, 1, Number.MAX_SAFE_INTEGER);
  const minimumBalanceLamports = Number(decimalVariable(env, "SOLVER_MIN_BALANCE_LAMPORTS", 5_000_000, 1, Number.MAX_SAFE_INTEGER));
  if (priorityMicroLamports * BigInt(maxComputeUnits) > maxNetworkFeeLamports * 1_000_000n) {
    throw new StartupError("SOLVER_PRIORITY_MICRO_LAMPORTS at SOLVER_MAX_COMPUTE_UNITS must fit within SOLVER_MAX_NETWORK_FEE_LAMPORTS");
  }
  if (BigInt(minimumBalanceLamports) < maxNetworkFeeLamports) {
    throw new StartupError("SOLVER_MIN_BALANCE_LAMPORTS must cover SOLVER_MAX_NETWORK_FEE_LAMPORTS");
  }
  return {
    transactionLimits: { maxComputeUnits, priorityMicroLamports, maxNetworkFeeLamports },
    minimumBalanceLamports,
    maxQuoteSpreadBps: env.SOLVER_MAX_SPREAD_BPS === "" ? 100 :
      Number(decimalVariable(env, "SOLVER_MAX_SPREAD_BPS", 100, 0, 10_000)),
    jupiterSlippageBps: useJupiter ? Number(decimalVariable(env, "JUPITER_SLIPPAGE_BPS", 50, 0, 500)) : 50,
    priceAccounts: parsePriceAccounts(env.PRICE_ACCOUNTS),
  };
}
