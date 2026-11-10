/**
 * Server-only configuration, read from environment variables on every
 * request (the pages are dynamic), so one build serves any deployment.
 * example.env lists every variable.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LOCALNET_DEPLOYMENT, parseDeployment, type DeploymentManifest } from "@ghostlink/common";
import type { ArtifactConfig, PublicConfig } from "./public-config";

/** The circuit files this app can serve itself in local development, by public name. */
export const SERVED_CIRCUITS: Readonly<Record<string, string>> = {
  "login.wasm": "login_js/login.wasm",
  "login.zkey": "login_dev.zkey",
  "owner.wasm": "owner_js/owner.wasm",
  "owner.zkey": "owner_dev.zkey",
};

const env = (name: string): string | undefined => {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
};

function loadDeployment(): { deployment: DeploymentManifest; problem?: string } {
  const path = env("GHOSTLINK_DEPLOYMENT");
  if (!path) return { deployment: LOCALNET_DEPLOYMENT };
  try {
    return { deployment: parseDeployment(JSON.parse(readFileSync(path, "utf8"))) };
  } catch (error) {
    return { deployment: LOCALNET_DEPLOYMENT, problem: `GHOSTLINK_DEPLOYMENT (${path}) is not a valid deployment manifest: ${(error as Error).message}` };
  }
}

/**
 * The directory of locally built circuits served at /circuits/*, or null.
 * Local validator only: a public deployment hosts pinned artifacts elsewhere.
 */
export function circuitsDir(deployment: DeploymentManifest = loadDeployment().deployment): string | null {
  if (deployment.cluster !== "localnet") return null;
  // Read at run time from wherever the developer built the circuits; never bundled or traced.
  const dir = resolve(/*turbopackIgnore: true*/ env("GHOSTLINK_CIRCUITS_DIR") ?? resolve(/*turbopackIgnore: true*/ process.cwd(), "..", "..", "circuits", "build"));
  return existsSync(resolve(/*turbopackIgnore: true*/ dir, SERVED_CIRCUITS["login.wasm"]!)) ? dir : null;
}

const hashes = new Map<string, string>();
function sha256File(path: string): string {
  let hash = hashes.get(path);
  if (!hash) {
    hash = createHash("sha256").update(readFileSync(path)).digest("hex");
    hashes.set(path, hash);
  }
  return hash;
}

function artifacts(circuit: "login" | "owner", served: string | null): { config: ArtifactConfig | null; fromFiles: boolean } {
  const prefix = circuit.toUpperCase();
  const wasmUrl = env(`${prefix}_WASM_URL`), zkeyUrl = env(`${prefix}_ZKEY_URL`);
  const wasmSha256 = env(`${prefix}_WASM_SHA256`), zkeySha256 = env(`${prefix}_ZKEY_SHA256`);
  if (wasmUrl && zkeyUrl) return { config: { wasmUrl, zkeyUrl, wasmSha256, zkeySha256 }, fromFiles: false };
  if (!served) return { config: null, fromFiles: false };
  const wasm = resolve(/*turbopackIgnore: true*/ served, SERVED_CIRCUITS[`${circuit}.wasm`]!), zkey = resolve(/*turbopackIgnore: true*/ served, SERVED_CIRCUITS[`${circuit}.zkey`]!);
  if (!existsSync(wasm) || !existsSync(zkey)) return { config: null, fromFiles: false };
  // Local development only. Pins taken from the files this server serves catch a file that
  // changes between page load and proof, nothing more; production pins come from the environment.
  return {
    config: { wasmUrl: `/circuits/${circuit}.wasm`, zkeyUrl: `/circuits/${circuit}.zkey`,
      wasmSha256: wasmSha256 ?? sha256File(wasm), zkeySha256: zkeySha256 ?? sha256File(zkey) },
    fromFiles: !(wasmSha256 && zkeySha256),
  };
}

const SLOTS = /^[1-9][0-9]{0,5}$/;

export function loadConfig(): PublicConfig {
  const problems: string[] = [];
  const { deployment, problem } = loadDeployment();
  if (problem) problems.push(problem);
  const local = deployment.cluster === "localnet";
  const served = circuitsDir(deployment);
  const login = artifacts("login", served), owner = artifacts("owner", served);
  if (!login.config) {
    problems.push("No login circuit artifacts: set LOGIN_WASM_URL and LOGIN_ZKEY_URL with their SHA-256 pins, " +
      "or, on a local validator, build them with scripts/build-circuits.sh (or copy circuits/build).");
  } else if (!local && !(login.config.wasmSha256 && login.config.zkeySha256)) {
    problems.push("LOGIN_WASM_SHA256 and LOGIN_ZKEY_SHA256 are required outside a local validator.");
  }
  if (owner.config && !local && !(owner.config.wasmSha256 && owner.config.zkeySha256)) {
    problems.push("OWNER_WASM_SHA256 and OWNER_ZKEY_SHA256 are required outside a local validator.");
  }
  const devWallet = env("IDENTITY_DEV_WALLET") === "1";
  if (devWallet && !local) problems.push("IDENTITY_DEV_WALLET works on a local validator only; it is off.");
  const maxSessionSlots = env("HANDOFF_MAX_SESSION_SLOTS") ?? "9000";
  const slotsValid = SLOTS.test(maxSessionSlots) && BigInt(maxSessionSlots) <= 216_000n;
  if (!slotsValid) problems.push("HANDOFF_MAX_SESSION_SLOTS must be a whole number from 1 to 216000; using 9000.");
  const service = (name: string, fallback: string) => {
    const value = env(name) ?? (local ? fallback : "");
    if (!value) problems.push(`${name} is required outside a local validator.`);
    return value;
  };
  return {
    appName: env("IDENTITY_APP_NAME") ?? "Identity",
    identityDomain: env("IDENTITY_DOMAIN") ?? null,
    deployment,
    indexer: service("GHOSTLINK_INDEXER_URL", "http://127.0.0.1:8787"),
    relayer: service("GHOSTLINK_RELAYER_URL", "http://127.0.0.1:8788"),
    rpc: service("GHOSTLINK_RPC_URL", "http://127.0.0.1:8899"),
    login: login.config,
    owner: owner.config,
    pinsFromServedFiles: login.fromFiles || owner.fromFiles,
    maxSessionSlots: slotsValid ? maxSessionSlots : "9000",
    devWallet: devWallet && local,
    problems,
  };
}
