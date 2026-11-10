/**
 * Deployment manifests: the one description of which chain and which three
 * program IDs a GhostLink client, service or program build belongs to.
 *
 * The built-in program IDs (constants.ts) are also the addresses of the
 * preserved V1 deployment on devnet. V2 code must never talk to those
 * programs on a public network, so the rule everywhere is:
 *
 * - a local validator may use the built-in deployment with no manifest;
 * - devnet and mainnet need an explicit manifest naming the cluster's own
 *   genesis hash and three program IDs that are not the built-in ones;
 * - a manifest is checked against the RPC's actual genesis before use.
 *
 * A manifest holds no secrets: only public addresses and key digests.
 */
import { sha256 } from "@noble/hashes/sha256";
import bs58 from "bs58";
import type { SessionDeployment } from "./authorization.js";
import { CENSUS_PROGRAM_ID, POCKET_PROGRAM_ID, REGISTRY_PROGRAM_ID, type Cluster } from "./constants.js";
import type { BotDeployment } from "./consent.js";
import { bytesToHex } from "./field.js";

export interface DeploymentManifest {
  version: 1;
  cluster: Cluster;
  /**
   * The chain's genesis hash. Required on devnet and mainnet-beta, where it
   * must be that cluster's genesis. Optional on localnet: omitted, any
   * non-public local validator is accepted.
   */
  genesisHash?: string;
  registryProgram: string;
  censusProgram: string;
  pocketProgram: string;
  /**
   * SHA-256 (`verifyingKeyDigest`) of the login and owner Groth16 verifying
   * keys the programs are built with. Proofs from other proving keys fail.
   */
  verifyingKeys: { login: string; owner: string };
}

/** Thrown for every malformed or refused deployment, with a specific message. */
export class DeploymentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeploymentError";
  }
}

/** Genesis hashes of the public clusters a manifest may name. */
export const PUBLIC_GENESIS_HASHES: Readonly<Record<Exclude<Cluster, "localnet">, string>> = Object.freeze({
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
});

/**
 * The deployment the repository's programs, fixtures and local tests use:
 * the committed program IDs on a disposable local validator.
 */
export const LOCALNET_DEPLOYMENT: Readonly<DeploymentManifest> = Object.freeze({
  version: 1,
  cluster: "localnet",
  registryProgram: REGISTRY_PROGRAM_ID,
  censusProgram: CENSUS_PROGRAM_ID,
  pocketProgram: POCKET_PROGRAM_ID,
  verifyingKeys: Object.freeze({
    login: "bf3c18cb589f0d21a0eb25aa4fa07a544fc59c7fa0f6cdacc1cd1d31c50d3001",
    owner: "0765078951eff3f1b1c8ce70a3d9c676fa39c9b6e7a83227b0b9d4f749bbad11",
  }),
}) as Readonly<DeploymentManifest>;

const CLUSTERS: readonly Cluster[] = ["localnet", "devnet", "mainnet-beta"];
const BUILTIN = new Set([REGISTRY_PROGRAM_ID, CENSUS_PROGRAM_ID, POCKET_PROGRAM_ID]);
const PROGRAM_FIELDS = ["registryProgram", "censusProgram", "pocketProgram"] as const;
const REQUIRED = ["version", "cluster", ...PROGRAM_FIELDS, "verifyingKeys"];
const OPTIONAL = ["genesisHash"];

function isAddress(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 32 || value.length > 44) return false;
  try {
    const bytes = bs58.decode(value);
    return bytes.length === 32 && bs58.encode(bytes) === value;
  } catch {
    return false;
  }
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function publicClusterOf(genesisHash: string): Exclude<Cluster, "localnet"> | undefined {
  return (Object.keys(PUBLIC_GENESIS_HASHES) as Exclude<Cluster, "localnet">[])
    .find(cluster => PUBLIC_GENESIS_HASHES[cluster] === genesisHash);
}

/** True when any program ID is one of the built-in (V1-on-devnet) IDs. */
export function usesBuiltinProgramIds(d: Pick<DeploymentManifest, (typeof PROGRAM_FIELDS)[number]>): boolean {
  return PROGRAM_FIELDS.some(field => BUILTIN.has(d[field]));
}

/** The rule shared by manifests and bot consent deployments. */
function checkIdentity(d: { cluster: unknown; genesisHash?: unknown; registryProgram: unknown;
  censusProgram: unknown; pocketProgram: unknown }): void {
  if (!CLUSTERS.includes(d.cluster as Cluster)) {
    throw new DeploymentError("deployment cluster must be localnet, devnet or mainnet-beta");
  }
  for (const field of PROGRAM_FIELDS) {
    if (!isAddress(d[field])) throw new DeploymentError(`deployment ${field} must be a canonical base58 32-byte address`);
  }
  if (new Set(PROGRAM_FIELDS.map(field => d[field])).size !== 3) {
    throw new DeploymentError("deployment program IDs must be three different addresses");
  }
  if (d.genesisHash !== undefined && !isAddress(d.genesisHash)) {
    throw new DeploymentError("deployment genesisHash must be a canonical base58 32-byte hash");
  }
  const cluster = d.cluster as Cluster;
  if (cluster === "localnet") {
    const named = d.genesisHash === undefined ? undefined : publicClusterOf(d.genesisHash as string);
    if (named) throw new DeploymentError(`a localnet deployment cannot name the ${named} genesis hash`);
    return;
  }
  if (d.genesisHash === undefined) throw new DeploymentError(`a ${cluster} deployment must name the ${cluster} genesis hash`);
  if (d.genesisHash !== PUBLIC_GENESIS_HASHES[cluster]) {
    throw new DeploymentError(`genesisHash is not the ${cluster} genesis hash (${PUBLIC_GENESIS_HASHES[cluster]})`);
  }
  const builtin = PROGRAM_FIELDS.filter(field => BUILTIN.has(d[field] as string));
  if (builtin.length) {
    throw new DeploymentError(`${builtin.join(", ")} uses a built-in program ID, which is the preserved V1 deployment ` +
      `on public networks; a ${cluster} deployment needs its own program IDs (docs/DEPLOYMENTS.md)`);
  }
}

/**
 * Validates a deployment manifest (for example parsed JSON) and returns a
 * frozen copy. Unknown fields are refused so a misspelled field cannot be
 * silently ignored. Throws `DeploymentError`.
 */
export function parseDeployment(raw: unknown): Readonly<DeploymentManifest> {
  if (!plainObject(raw)) throw new DeploymentError("deployment manifest must be a JSON object");
  const unknown = Object.keys(raw).filter(k => !REQUIRED.includes(k) && !OPTIONAL.includes(k));
  if (unknown.length) throw new DeploymentError(`deployment manifest has unknown field ${JSON.stringify(unknown[0])}`);
  const missing = REQUIRED.filter(k => !Object.hasOwn(raw, k));
  if (missing.length) throw new DeploymentError(`deployment manifest is missing ${missing.join(", ")}`);
  if (raw.version !== 1) throw new DeploymentError("deployment manifest version must be 1");
  checkIdentity(raw as Parameters<typeof checkIdentity>[0]);
  const keys = raw.verifyingKeys;
  if (!plainObject(keys) || Object.keys(keys).length !== 2 ||
    !["login", "owner"].every(k => typeof keys[k] === "string" && /^[0-9a-f]{64}$/.test(keys[k] as string))) {
    throw new DeploymentError("deployment verifyingKeys must be { login, owner } lowercase SHA-256 hex digests");
  }
  return Object.freeze({
    version: 1,
    cluster: raw.cluster as Cluster,
    ...(raw.genesisHash === undefined ? {} : { genesisHash: raw.genesisHash as string }),
    registryProgram: raw.registryProgram as string,
    censusProgram: raw.censusProgram as string,
    pocketProgram: raw.pocketProgram as string,
    verifyingKeys: Object.freeze({ login: keys.login as string, owner: keys.owner as string }),
  });
}

/**
 * Refuses a deployment for the chain an RPC actually serves. Call it with
 * `connection.getGenesisHash()` before sending or signing anything.
 */
export function assertDeploymentGenesis(deployment: DeploymentManifest, genesisHash: string): void {
  const d = parseDeployment(deployment);
  if (!isAddress(genesisHash)) throw new DeploymentError("RPC genesis hash must be a canonical base58 32-byte hash");
  if (d.genesisHash !== undefined && d.genesisHash !== genesisHash) {
    throw new DeploymentError(`RPC genesis ${genesisHash} does not match the deployment genesis ${d.genesisHash}`);
  }
  const chain = publicClusterOf(genesisHash);
  if (chain && d.cluster !== chain) {
    throw new DeploymentError(`a ${d.cluster} deployment refuses the ${chain} genesis; configure a ${chain} deployment manifest (docs/DEPLOYMENTS.md)`);
  }
}

/**
 * Checks the deployment identity a bot consent or application registry
 * carries: the manifest rule, plus a genesis hash that is always required.
 */
export function checkBotDeployment(raw: unknown): BotDeployment {
  if (!plainObject(raw)) throw new DeploymentError("bot deployment must be an object");
  const fields = ["cluster", "genesisHash", ...PROGRAM_FIELDS];
  if (Object.keys(raw).length !== fields.length || !fields.every(k => Object.hasOwn(raw, k))) {
    throw new DeploymentError("bot deployment must have exactly cluster, genesisHash and the three program IDs");
  }
  if (!isAddress(raw.genesisHash)) throw new DeploymentError("bot deployment genesisHash must be a canonical base58 32-byte hash");
  checkIdentity(raw as Parameters<typeof checkIdentity>[0]);
  return { cluster: raw.cluster as Cluster, genesisHash: raw.genesisHash, pocketProgram: raw.pocketProgram as string,
    registryProgram: raw.registryProgram as string, censusProgram: raw.censusProgram as string };
}

/** The consent-wire projection of a manifest, pinned to the chain the RPC serves. */
export function botDeployment(deployment: DeploymentManifest, genesisHash: string): BotDeployment {
  assertDeploymentGenesis(deployment, genesisHash);
  return checkBotDeployment({ cluster: deployment.cluster, genesisHash, pocketProgram: deployment.pocketProgram,
    registryProgram: deployment.registryProgram, censusProgram: deployment.censusProgram });
}

/** Program IDs as bytes, for `pocketAuthorizationContext` and `@ghostlink/verify`. */
export function sessionDeployment(deployment: Pick<DeploymentManifest, (typeof PROGRAM_FIELDS)[number]>): SessionDeployment {
  return {
    pocketProgram: bs58.decode(deployment.pocketProgram),
    registryProgram: bs58.decode(deployment.registryProgram),
    censusProgram: bs58.decode(deployment.censusProgram),
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new DeploymentError("verifying key is not JSON");
  return encoded;
}

/**
 * SHA-256 of a snarkjs verifying key (the parsed `*_vk.json`) as canonical
 * JSON with sorted keys, so formatting does not change the digest.
 */
export function verifyingKeyDigest(vk: unknown): string {
  if (!plainObject(vk)) throw new DeploymentError("verifying key must be a JSON object");
  return bytesToHex(sha256(new TextEncoder().encode(canonicalJson(vk))));
}
