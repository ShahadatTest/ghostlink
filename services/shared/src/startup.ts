/**
 * Startup diagnostics for the hosted services (Node only).
 *
 * An operator must learn which variable, file or check is wrong; key
 * material, file contents and secrets must never reach the output. So the
 * entry points classify what fails:
 *
 * - configuration and state problems throw `StartupError`, whose message
 *   names only variables, paths, ports, public values and fixed reasons;
 * - deployment manifest problems keep their `DeploymentError` message, which
 *   carries only public manifest values;
 * - anything else is reported with the service's generic line and no detail.
 *
 * Helpers that read private files never quote what they read: a damaged
 * keypair or key file is reported by variable and path only.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import type { Server } from "node:http";
import { basename } from "node:path";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { DeploymentError, assertDeploymentGenesis, type DeploymentManifest } from "@ghostlink/common";
import { loadDeploymentConfig } from "./deployment-config.js";
import { createRpcPool, loadRpcEndpoints } from "./rpc.js";

type Env = Readonly<Record<string, string | undefined>>;

/** A startup problem whose message is safe to print: it never contains secrets or file contents. */
export class StartupError extends Error {
  constructor(message: string) { super(message); this.name = "StartupError"; }
}

/** The line to print for a failed startup: the classified reason, or `generic` for anything unclassified. */
export function describeStartupFailure(prefix: string, error: unknown, generic: string): string {
  if (error instanceof StartupError || error instanceof DeploymentError) return `${prefix}: ${error.message}`;
  return generic;
}

/**
 * Checks GHOSTLINK_DEPLOYMENT before `@ghostlink/service-kit` loads it at
 * import. Each entry point imports a module calling this before anything
 * else, so a bad manifest is reported as one line instead of an import-time
 * stack trace.
 */
export function preflightDeployment(service: string, env: Env = process.env): void {
  const phase = basename(process.argv[1] ?? "").startsWith("initialize") ? "initialization" : "startup";
  try { loadDeploymentConfig(env); } catch (error) {
    console.error(describeStartupFailure(`${service} ${phase} failed`, error, `${service} ${phase} failed; check GHOSTLINK_DEPLOYMENT`));
    process.exit(1);
  }
}

/** A non-empty variable, or a StartupError saying what it must name. */
export function requireVariable(env: Env, name: string, meaning: string): string {
  const value = env[name];
  if (!value) throw new StartupError(`${name} is required: ${meaning}`);
  return value;
}

function isHash(value: string): boolean {
  try { const bytes = bs58.decode(value); return bytes.length === 32 && bs58.encode(bytes) === value; } catch { return false; }
}

/** The operator-approved genesis hash in variable `name`. */
export function requireGenesis(env: Env, name: string): string {
  const value = requireVariable(env, name, "the genesis hash of the chain this service serves (solana genesis-hash)");
  if (!isHash(value)) throw new StartupError(`${name} must be a base58 32-byte genesis hash`);
  return value;
}

/** A pinned 64-hex state identity, recorded as `field` in the deployment.json that initialize.js wrote. */
export function requirePin(env: Env, name: string, field: string): string {
  const value = requireVariable(env, name, `the "${field}" value from the deployment.json written by initialize.js`);
  if (!/^[0-9a-f]{64}$/.test(value)) throw new StartupError(`${name} must be 64 lowercase hex characters (the "${field}" value from deployment.json)`);
  return value;
}

/** An integer variable within [minimum, maximum]; unset means `fallback`. */
export function integerVariable(env: Env, name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new StartupError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

/** A TCP port variable; unset means `fallback`. */
export function portVariable(env: Env, name: string, fallback: number): number {
  return integerVariable(env, name, fallback, 1, 65535);
}

/** Refuses two port variables with the same value. */
export function distinctPorts(ports: Record<string, number>): void {
  const seen = new Map<number, string>();
  for (const [name, port] of Object.entries(ports)) {
    const other = seen.get(port);
    if (other) throw new StartupError(`${other} and ${name} must differ (both are ${port})`);
    seen.set(port, name);
  }
}

/** A lamport amount variable (decimal, at most 19 digits); unset means `fallback`. */
export function lamportsVariable(env: Env, name: string, fallback: string): bigint {
  const raw = env[name] ?? fallback;
  if (!/^(0|[1-9][0-9]{0,18})$/.test(raw)) throw new StartupError(`${name} must be a whole number of lamports`);
  return BigInt(raw);
}

function unreadable(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "ENOENT" || code === "ENOTDIR") return "does not exist";
  if (code === "EACCES" || code === "EPERM") return "is not readable by this user";
  if (code === "EISDIR") return "is a directory, not a file";
  return "cannot be read";
}

/** Reads a private file named by variable `name`; failures name the variable and path, never the contents. */
export function readPrivateFile(name: string, path: string, maximumBytes = 65_536): Buffer {
  let stat: ReturnType<typeof statSync>;
  try { stat = statSync(path); } catch (error) { throw new StartupError(`${name}: ${path} ${unreadable(error)}`); }
  if (stat.isDirectory()) throw new StartupError(`${name}: ${path} is a directory, not a file`);
  if (!stat.isFile()) throw new StartupError(`${name}: ${path} is not a regular file`);
  if (stat.size > maximumBytes) throw new StartupError(`${name}: ${path} is larger than ${maximumBytes} bytes`);
  try { return readFileSync(path); } catch (error) { throw new StartupError(`${name}: ${path} ${unreadable(error)}`); }
}

/** A raw 32-byte storage encryption key file. */
export function readStorageKey(name: string, path: string): Buffer {
  const key = readPrivateFile(name, path, 4096);
  if (key.length !== 32) {
    key.fill(0);
    throw new StartupError(`${name}: ${path} must hold exactly 32 raw key bytes (the key file initialize.js wrote); its contents are not shown`);
  }
  return key;
}

/**
 * A Solana keypair file (a JSON array of 64 numbers). Parser errors can
 * quote secret bytes, so none is ever shown: the failure names the variable
 * and path only.
 */
export function readKeypair(name: string, path: string): Keypair {
  const text = readPrivateFile(name, path, 4096);
  try {
    const parsed: unknown = JSON.parse(text.toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 64 || !parsed.every(b => Number.isInteger(b) && b >= 0 && b <= 255)) throw new Error();
    return Keypair.fromSecretKey(Uint8Array.from(parsed as number[]));
  } catch {
    throw new StartupError(`${name}: ${path} is not a valid Solana keypair file (64 numbers whose public half matches the secret half); its contents are not shown`);
  } finally { text.fill(0); }
}

/** Checks a configured genesis (variable `name`) against the deployment manifest. */
export function checkDeploymentGenesis(name: string, deployment: Readonly<DeploymentManifest>, genesisHash: string): void {
  try { assertDeploymentGenesis(deployment, genesisHash); } catch (error) {
    if (error instanceof DeploymentError) throw new StartupError(`${name} does not suit the deployment (GHOSTLINK_DEPLOYMENT): ${error.message}`);
    throw error;
  }
}

// Plain Errors from GhostLink's storage and RPC code, and SQLite's own errors, carry fixed
// reasons such as "relayer journal identity mismatch". Anything else is withheld: a JSON
// SyntaxError, for one, can quote the text it failed to parse.
const FIXED_REASON = /^[A-Za-z0-9 ,;:()'./_-]{1,200}$/;
function fixedReason(error: unknown): string | undefined {
  if (error instanceof StartupError) return error.message;
  if (error instanceof Error && Object.getPrototypeOf(error) === Error.prototype && FIXED_REASON.test(error.message)) return error.message;
  return undefined;
}

/**
 * Opens existing durable state at `path` (variable `name`). A missing file
 * points at initialize.js; a refusal (wrong key, wrong pinned identity,
 * another deployment's or chain's state, a restored backup, damage) gives
 * the storage layer's fixed reason and `check`, a hint naming what to compare.
 */
export function openState<T>(name: string, path: string, check: string, open: () => T): T {
  if (!existsSync(path)) throw new StartupError(`${name}: ${path} does not exist; create state with this service's initialize.js and point ${name} at it`);
  try { return open(); } catch (error) {
    throw new StartupError(`${name}: ${path} was refused (${fixedReason(error) ?? "details withheld"}); ${check}`);
  }
}

/** The RPC pool from RPC_ENDPOINTS_PATH, else RPC_URL (default http://127.0.0.1:8899). */
export function openRpc(env: Env, genesisHash: string): ReturnType<typeof createRpcPool> {
  const source = env.RPC_ENDPOINTS_PATH ? "RPC_ENDPOINTS_PATH" : "RPC_URL";
  try { return createRpcPool({ genesisHash, endpoints: loadRpcEndpoints(env.RPC_ENDPOINTS_PATH, env.RPC_URL) }); } catch (error) {
    // Endpoint URLs and headers can hold provider credentials: only the fixed reason is shown.
    throw new StartupError(`${source}: ${fixedReason(error) ?? "invalid RPC configuration"}`);
  }
}

/** Confirms that some configured endpoint answers with the approved genesis (variable `genesisVariable`). */
export async function probeRpc(rpc: ReturnType<typeof createRpcPool>, genesisVariable: string): Promise<void> {
  try { await rpc.connection.getGenesisHash(); } catch {
    const reasons = new Set(rpc.status().endpoints.map(endpoint => endpoint.reason).filter(Boolean));
    if (reasons.has("genesis")) {
      throw new StartupError(`the RPC serves a different chain than ${genesisVariable}; point RPC_URL or RPC_ENDPOINTS_PATH at that chain, or correct ${genesisVariable}`);
    }
    throw new StartupError(`no RPC endpoint answered (${[...reasons].join(", ") || "unavailable"}); check RPC_URL or RPC_ENDPOINTS_PATH and that the node is running`);
  }
}

/** Listens on `port`, turning an occupied or forbidden port into a StartupError naming variable `name`. */
export function listen(server: Server, port: number, name: string, host?: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      reject(error.code === "EADDRINUSE" ? new StartupError(`${name}: port ${port} is already in use`) :
        error.code === "EACCES" ? new StartupError(`${name}: not permitted to listen on port ${port}`) : error);
    });
    if (host) server.listen(port, host, resolve); else server.listen(port, resolve);
  });
}
