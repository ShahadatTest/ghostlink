/**
 * The GhostLink facade. Thin wiring over the pure modules: identity,
 * session, login, pocket, owner. Network calls go through injectable
 * clients so apps, tests and self-hosters can swap endpoints, and chain
 * state is read through an injected `ChainReader` (chain.ts), never a
 * bundled RPC client.
 */
import { ed25519 } from "@noble/curves/ed25519";
import {
  Cluster,
  DeploymentError,
  FIELD_PRIME,
  LOCALNET_DEPLOYMENT,
  FieldElement,
  IncrementalTree,
  Policy,
  TREE_DEPTH,
  appId as deriveAppId,
  assertDeploymentGenesis,
  bindingPda,
  bytesToHex,
  censusConfigPda,
  censusLeaf,
  conservativePolicy,
  domainHash as deriveDomainHash,
  fieldToBytes32,
  hashToField,
  hexToBytes,
  homeHash,
  intentHash,
  joinBytes32,
  parseDeployment,
  pocketAuthorizationContext,
  pocketPda,
  policyHash,
  proofToBytes,
  registryLeaf,
  relayerRequestDigest,
  sessionDeployment,
  splitBytes32,
  toBase58,
  type BindingResponse,
  type CensusLatestResponse,
  type DeploymentManifest,
  type IntentRequest,
  type IntentSubmission,
  type LeavesResponse,
  type OpenSessionRequest,
  type PathResponse,
  type PolicyDto,
  type RelayerReceipt,
  type RootsResponse,
  type SnapshotRequest,
  type TxResponse,
} from "@ghostlink/common";
import { buildRegistration, type DerivedIdentity, type SignMessageFn } from "./identity.js";
import {
  buildLoginInput,
  proveLogin,
  provenClaim,
  verifyWitness,
  type Claim,
  type LoginProof,
  type LoginWitnessData,
  type MerkleWitness,
  type ProvenClaim,
  type Prover,
} from "./login.js";
import {
  copySessionPublicKey, sessionCommitmentFor, softwareSession, type SessionPublicKey, type SessionSigner,
} from "./session.js";
import {
  cancelDigest,
  changeDigest,
  derivePocket,
  fundingOptions,
  revokeDigest,
  signIntent,
  sweepDigest,
  type FundingOptions,
  type IntentParams,
  type PocketHandle,
  type SignedIntent,
} from "./pocket.js";
import {
  RelayerClient,
  prepareRelayerOperation,
  type PreparedRelayerOperation,
  type SettleOptions,
} from "./relayer.js";
import { decodePocketAccount, type ChainReader, type PocketChange, type PocketState } from "./chain.js";
import {
  associatedTokenAddress,
  cancelChangeInstruction,
  computeBudgetInstruction,
  ed25519VerifyInstruction,
  executeChangeInstruction,
  pocketChangeBorsh,
  proposeChangeInstruction,
  registerInstruction,
  revokeSessionInstruction,
  snapshotInstruction,
  sweepHomeInstruction,
  type GhostLinkInstruction,
} from "./instructions.js";
import { ownerActionRequest, type OwnerActionKind, type OwnerAuthorization, type SweepTokenPair } from "./owner.js";
import { unboundFetch } from "./transport.js";

export interface GhostLinkConfig {
  /** Must equal `deployment.cluster` when a deployment is given. */
  cluster: Cluster;
  /**
   * The deployment manifest (docs/DEPLOYMENTS.md) whose programs this
   * client derives pockets and authorizations for. Optional on localnet,
   * where the built-in `LOCALNET_DEPLOYMENT` is the default. Required on
   * devnet and mainnet-beta: the built-in program IDs are the preserved V1
   * deployment there, so a public manifest must name its own.
   */
  deployment?: DeploymentManifest;
  indexer: string;
  relayer?: string;
  solver?: string;
  actions?: string;
  prover?: Prover;
  /**
   * Reads chain state (slots, pocket accounts, the census fee): any object
   * with `getGenesisHash`, `getSlot` and `getAccount`, for example
   * `jsonRpcChainReader(rpcUrl)`. Required for owner actions and
   * self-submitted snapshots; with it, proofs also read the current slot
   * and the pocket's revocation epoch themselves. Its genesis is checked
   * against the deployment before the first read.
   */
  chain?: ChainReader;
  /**
   * Required outside the browser: the origin identities and proofs are
   * scoped to, exactly as the browser would report it, e.g.
   * "https://app.example.com". In a browser the SDK always uses
   * `window.location.origin` and ignores this.
   */
  origin?: string;
  /** Any fetch, including the browser's unbound `window.fetch`; it is always called without a receiver. */
  fetchFn?: typeof fetch;
}

export interface GhostLinkAuthorization {
  appId: FieldElement;
  appIdBase58: string;
  proof: LoginProof;
  /** Public key descriptor, with no signing function or private key. */
  signer: SessionPublicKey;
  expirySlot: bigint;
  /** The pocket revocation epoch the proof binds; any later revoke invalidates it. */
  authorizationEpoch: bigint;
}

export interface GhostLinkSession extends GhostLinkAuthorization {
  signer: SessionSigner;
}

export interface SessionAuthorizationParams {
  identity: DerivedIdentity;
  claim?: Claim;
  /** A public signal: an exact snapshot slot identifies the snapshot. Prefer `currentSlot`. */
  minSlot?: bigint;
  /** The chain's current slot; read from `chain` when omitted and a claim needs it. */
  currentSlot?: bigint;
  witness: LoginWitnessData;
  session: SessionPublicKey;
  /** Must exceed every previous session expiry for this pocket, and be at most currentSlot + policy.sessionMaxSlots. */
  expirySlot: bigint;
  home: Uint8Array;
  /** Exact owner-approved policy. Renewal must use the current confirmed policy. */
  policy: Policy;
  /**
   * The pocket's current confirmed revocation epoch. Omitted, it is read
   * from `chain` (zero while the pocket does not exist), or zero without a
   * chain reader, which only creates a pocket.
   */
  authorizationEpoch?: bigint;
}

/** Relayer submission options shared by every method that goes through the relayer. */
export interface RelayOptions extends SettleOptions {
  /**
   * Called with the prepared operation before anything is sent. Persist it
   * (encrypted) so that after a crash or timeout you can finish it with
   * `new RelayerClient(url).settle(operation)` instead of sending another.
   */
  save?: (operation: PreparedRelayerOperation) => void | Promise<void>;
  /** A 32-byte hex request ID to use instead of the method's default. */
  requestIdHex?: string;
}

export interface OpenSessionOptions extends Omit<RelayOptions, "requestIdHex"> {
  /**
   * The holdings claim you expect the proof to make, or null for none.
   * Omitted, the claim is read from the proof itself.
   */
  claim?: ProvenClaim | null | LegacyClaimFields;
  /** Expected roots; omitted, they are read from the proof. */
  roots?: { registry: FieldElement; census: FieldElement };
  /** Expected domain hash; omitted, it is read from the proof. */
  domainHash?: FieldElement;
}

/** The 0.1 `openSession` claim argument, still accepted. */
export interface LegacyClaimFields { mint: Uint8Array; threshold: bigint; minSlot: bigint; claim: boolean }

/** A wallet's census holding: the token account of `mint`, or an explicit `holding` (the wallet itself for native SOL). */
export type SnapshotParams = { wallet: Uint8Array; mint: Uint8Array; holding?: undefined }
  | { wallet: Uint8Array; holding: Uint8Array; mint?: undefined };

export interface RegistrationParams {
  identity: DerivedIdentity;
  /** The registering wallet's public key; it signs the registration message. */
  wallet: Uint8Array;
  /** Resolves to the wallet's 64-byte Ed25519 signature over exactly the given bytes. */
  signMessage: SignMessageFn;
}

export interface WitnessParams {
  identity: Pick<DerivedIdentity, "commitment">;
  /** The registered wallet. */
  wallet: Uint8Array;
  /** Include the census witness for a holdings claim on this mint. */
  mint?: Uint8Array;
  /**
   * Wait for a fresh registration or snapshot to become provable instead
   * of throwing `WitnessPendingError` (or a 404 `IndexerRequestError` while
   * the indexer has not ingested it). A leaf becomes provable when its
   * 150-slot root bucket ends (about a minute) plus the indexer's
   * finality. Polls every `pollMs` (default 2000) until `timeoutMs`, then
   * throws the last error.
   */
  wait?: { timeoutMs: number; pollMs?: number; signal?: AbortSignal };
}

export interface OwnerActionParams {
  identity: DerivedIdentity;
  /** The registry witness (`witness()` without a mint is enough). */
  witness: Pick<LoginWitnessData, "registry">;
  action: OwnerActionKind;
  /** Propose only: the new home or the complete new policy. */
  change?: PocketChange;
}

/**
 * The indexer holds this registration or snapshot, but its root-history
 * bucket (150 slots, about a minute) has not ended, so no root covering it
 * is final on chain yet. Retry once the chain is past `completesAfterSlot`
 * (or pass `wait` to `witness`); the indexer also waits for its own finality.
 */
export class WitnessPendingError extends Error {
  constructor(readonly path: string, readonly completesAfterSlot: bigint) {
    super(`${path}: not yet in a completed root bucket; retry after slot ${completesAfterSlot}`);
    this.name = "WitnessPendingError";
  }
}

/** The indexer answered with an error. 404 on a binding or census lookup: not registered or not snapshotted (yet). */
export class IndexerRequestError extends Error {
  constructor(readonly path: string, readonly status: number, readonly serverMessage: string) {
    super(`${path}: HTTP ${status}${serverMessage ? ` ${serverMessage}` : ""}`);
    this.name = "IndexerRequestError";
  }
}

/**
 * The deployment a client for `cluster` uses: the built-in one on localnet
 * when none is given, otherwise the validated manifest. Throws
 * `DeploymentError`. A configured `ChainReader` is checked against its
 * genesis before the first read.
 */
export function resolveDeployment(cluster: Cluster, deployment?: unknown): Readonly<DeploymentManifest> {
  if (deployment === undefined) {
    if (cluster === "localnet") return LOCALNET_DEPLOYMENT;
    throw new DeploymentError(`${String(cluster)} requires an explicit deployment manifest: the built-in program IDs ` +
      "are the preserved V1 deployment on public networks (docs/DEPLOYMENTS.md)");
  }
  const parsed = parseDeployment(deployment);
  if (parsed.cluster !== cluster) throw new DeploymentError(`the deployment manifest is for ${parsed.cluster}, not ${String(cluster)}`);
  return parsed;
}

/** Proof verification on chain; the compute-budget instruction every owner action and session opening carries. */
const PROOF_COMPUTE_UNITS = 400_000;

export class GhostLink {
  readonly config: GhostLinkConfig;
  /** The validated deployment every address and authorization is derived for. */
  readonly deployment: Readonly<DeploymentManifest>;
  private readonly fetchFn: typeof fetch;
  #genesis?: Promise<ChainReader>;
  #slot = 0n;

  private constructor(config: GhostLinkConfig, deployment: Readonly<DeploymentManifest>) {
    this.config = config;
    this.deployment = deployment;
    this.fetchFn = unboundFetch(config.fetchFn);
  }

  static async init(config: GhostLinkConfig): Promise<GhostLink> {
    return new GhostLink(config, resolveDeployment(config.cluster, config.deployment));
  }

  /** Origin used by this facade; callers holding the secret still control it. */
  origin(): string {
    if (typeof window !== "undefined" && window.location?.origin) {
      return window.location.origin;
    }
    if (!this.config.origin) {
      throw new Error("no origin outside the browser: pass GhostLink.init({ origin: \"https://your.app\", ... })");
    }
    return this.config.origin;
  }

  // ---- chain --------------------------------------------------------------

  async #chain(): Promise<ChainReader> {
    const chain = this.config.chain;
    if (!chain) throw new Error("no chain reader configured: pass GhostLink.init({ chain: jsonRpcChainReader(rpcUrl), ... })");
    this.#genesis ??= chain.getGenesisHash().then((hash) => { assertDeploymentGenesis(this.deployment, hash); return chain; });
    try { return await this.#genesis; }
    catch (error) { this.#genesis = undefined; throw error; }
  }

  /** The chain's current confirmed slot. Never goes backwards across calls on one client. */
  async currentSlot(): Promise<bigint> {
    const slot = BigInt(await (await this.#chain()).getSlot());
    if (slot < 0n || slot >= 1n << 64n) throw new Error("chain reader returned an invalid slot");
    if (slot > this.#slot) this.#slot = slot;
    return this.#slot;
  }

  /**
   * The confirmed pocket account, or null before it is opened. Refuses an
   * account owned by any program but this deployment's pocket program.
   */
  async pocketState(pocket: Uint8Array | Pick<PocketHandle, "address">): Promise<PocketState | null> {
    const address = pocket instanceof Uint8Array ? pocket : pocket.address;
    const chain = await this.#chain();
    const account = await chain.getAccount(address, this.#slot > 0n ? this.#slot : undefined);
    if (!account) return null;
    const owner = toBase58(account.owner);
    // Lamports sent to the address before the pocket is opened leave a system-owned account.
    if (owner === "11111111111111111111111111111111" && account.data.length === 0) return null;
    if (owner !== this.deployment.pocketProgram) throw new Error(`account ${toBase58(address)} is not owned by the deployment's pocket program`);
    return decodePocketAccount(account.data);
  }

  // ---- registration and census --------------------------------------------

  /**
   * Registers the identity's commitment for the wallet through the
   * relayer, which pays. The wallet signs the registration message once;
   * the secret never leaves the device. One registration per wallet, ever.
   * Returns the confirmed receipt (see `RelayOptions` for timeouts and
   * persistence; by default the request ID is the request digest, so
   * calling again after a lost reply reconciles the same operation).
   */
  async register(params: RegistrationParams, options: RelayOptions = {}): Promise<RelayerReceipt> {
    const request = await this.#registration(params);
    return this.#relay("/register", request, options, relayerRequestDigest("/register", request));
  }

  /**
   * The same registration as instructions for an app that pays and sends
   * its own transaction: the Ed25519 signature check, then `register`.
   * Keep them together, in this order; `payer` signs and pays the rent.
   */
  async registerInstructions(params: RegistrationParams & { payer: Uint8Array }): Promise<GhostLinkInstruction[]> {
    const request = await this.#registration(params);
    return [
      ed25519VerifyInstruction(params.wallet, hexToBytes(request.signatureHex), hexToBytes(request.messageHex)),
      registerInstruction(this.deployment, params.payer, params.wallet, hexToBytes(request.commitmentHex)),
    ];
  }

  async #registration(params: RegistrationParams) {
    const { identity, wallet, signMessage } = params;
    if (!(wallet instanceof Uint8Array) || wallet.length !== 32) throw new Error("wallet must be a 32-byte public key");
    if (this.config.chain) {
      const binding = await (await this.#chain()).getAccount(bindingPda(wallet, base58(this.deployment.registryProgram)).address,
        this.#slot > 0n ? this.#slot : undefined);
      if (binding && binding.data.length >= 48) {
        const same = bytesToHex(binding.data.subarray(16, 48)) === bytesToHex(fieldToBytes32(identity.commitment));
        throw new Error(same ? "this wallet is already registered with this identity" :
          "this wallet is already registered with a different identity; a registration can never be replaced");
      }
    }
    const { message, signature } = await buildRegistration(identity, wallet, base58(this.deployment.registryProgram),
      this.deployment.cluster, signMessage);
    if (!(signature instanceof Uint8Array) || signature.length !== 64 ||
      !ed25519.verify(signature, message, wallet, { zip215: false })) {
      throw new Error("the wallet's signature does not verify over the registration message");
    }
    return { walletPubkey: toBase58(wallet), messageHex: bytesToHex(message), signatureHex: bytesToHex(signature),
      commitmentHex: bytesToHex(fieldToBytes32(identity.commitment)) };
  }

  /**
   * Snapshots a holding into the census through the relayer, which pays
   * the network fee and the census fee. Proofs can claim it once its root
   * bucket ends (see `witness`). One snapshot per holding per minute. A
   * fresh random request ID is used unless you pass one.
   */
  async snapshot(params: SnapshotParams, options: RelayOptions = {}): Promise<RelayerReceipt> {
    const request: SnapshotRequest = { wallet: toBase58(params.wallet), holding: toBase58(holdingOf(params)) };
    return this.#relay("/snapshot", request, options);
  }

  /**
   * The snapshot as an instruction for an app that sends its own
   * transaction. `payer` pays the census fee, at most `maxFeeLamports`
   * (read from the census config through `chain` when omitted). The
   * transaction may contain only compute-budget and snapshot instructions.
   */
  async snapshotInstructions(params: SnapshotParams & { payer: Uint8Array; maxFeeLamports?: bigint }): Promise<GhostLinkInstruction[]> {
    const holding = holdingOf(params);
    let fee = params.maxFeeLamports;
    if (fee === undefined) {
      const config = await (await this.#chain()).getAccount(censusConfigPda(base58(this.deployment.censusProgram)).address,
        this.#slot > 0n ? this.#slot : undefined);
      if (!config || toBase58(config.owner) !== this.deployment.censusProgram || config.data.length !== 17) {
        throw new Error("census fee configuration unavailable");
      }
      fee = 0n;
      for (let i = 15; i >= 8; i--) fee = (fee << 8n) | BigInt(config.data[i]!);
    }
    return [snapshotInstruction(this.deployment, params.payer, params.wallet, holding, fee)];
  }

  // ---- indexer ----------------------------------------------------------

  private async getJson<T>(base: string, path: string): Promise<T> {
    const res = await this.fetchFn(`${base}${path}`);
    if (!res.ok) {
      const body = await res.json().catch(() => null) as { completesAfterSlot?: unknown; error?: unknown } | null;
      if (res.status === 404) {
        const slot = body?.completesAfterSlot;
        if (typeof slot === "string" && /^(0|[1-9][0-9]{0,19})$/.test(slot)) throw new WitnessPendingError(path, BigInt(slot));
      }
      throw new IndexerRequestError(path, res.status, typeof body?.error === "string" ? body.error.slice(0, 200) : "");
    }
    return (await res.json()) as T;
  }

  private async postJson<T>(base: string, path: string, body: unknown): Promise<T> {
    const res = await this.fetchFn(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }

  async roots(tree: "registry" | "census"): Promise<RootsResponse> {
    return this.getJson(this.config.indexer, `/roots/${tree}`);
  }

  /**
   * Fetches a Merkle path and checks that it is well-formed and hashes to
   * the served root. Integrity against the chain is settled on-chain: the
   * pocket only accepts roots from the programs' 128-entry root rings, so
   * a lying indexer can waste a proof but never forge one. The indexer
   * serves paths against the newest completed root bucket only; a leaf
   * whose bucket has not ended throws `WitnessPendingError`.
   */
  async verifiedPath(tree: "registry" | "census", leafIndex: number, leaf: FieldElement): Promise<MerkleWitness> {
    if (!Number.isSafeInteger(leafIndex) || leafIndex < 0 || leafIndex >= 2 ** TREE_DEPTH) {
      throw new Error("leaf index out of range");
    }
    const p = await this.getJson<PathResponse>(this.config.indexer, `/path/${tree}/${leafIndex}`);
    if (p.index !== leafIndex) throw new Error(`indexer answered for leaf ${p.index}, asked ${leafIndex}`);
    if (!Array.isArray(p.siblings) || p.siblings.length !== TREE_DEPTH) {
      throw new Error(`indexer served a ${tree} path of the wrong depth`);
    }
    const witness = {
      index: p.index,
      siblings: p.siblings.map(fieldFromDecimal),
      root: fieldFromDecimal(p.root),
    };
    if (!verifyWitness(leaf, witness)) {
      throw new Error(`indexer served a bad ${tree} path`);
    }
    return witness;
  }

  /**
   * Builds a witness WITHOUT telling the indexer which leaf you want:
   * downloads the whole tree (pages of leaves), rebuilds it locally and
   * reads the path off it. The request reveals nothing about the wallet
   * — the privacy-preserving choice while the tree is small enough
   * (default cap 50,000 leaves; a 26-hash append per leaf in JS). The
   * indexer lists only leaves of completed root buckets, so the rebuilt
   * root is one the programs keep; a leaf from the last minute is not
   * listed yet.
   */
  async localWitness(tree: "registry" | "census", leaf: FieldElement, maxLeaves = 50_000): Promise<MerkleWitness> {
    if (!Number.isSafeInteger(maxLeaves) || maxLeaves < 0 || maxLeaves > 2 ** TREE_DEPTH) {
      throw new Error("local-witness cap is out of range");
    }
    const local = new IncrementalTree();
    let index = -1;
    let from = 0;
    let snapshotSize: number | undefined;
    for (;;) {
      const page = await this.getJson<LeavesResponse>(this.config.indexer, `/leaves/${tree}?from=${from}&limit=5000`);
      if (!page || !Number.isSafeInteger(page.nextIndex) || page.nextIndex < from ||
        !Array.isArray(page.leaves) || page.from !== from || page.leaves.length > 5000 ||
        page.leaves.length > page.nextIndex - from) {
        throw new Error("indexer served a bad leaves page");
      }
      if (page.nextIndex > maxLeaves) {
        throw new Error(`${tree} tree has ${page.nextIndex} leaves, above the local-witness cap of ${maxLeaves}`);
      }
      snapshotSize ??= page.nextIndex;
      if (page.nextIndex < snapshotSize || (page.leaves.length === 0 && from < snapshotSize)) {
        throw new Error("indexer served an incomplete leaves snapshot");
      }
      // Finish the prefix announced on page one, even if new leaves are
      // appended while downloading. Never chase a growing tree forever.
      const values = page.leaves.slice(0, snapshotSize - from);
      for (const raw of values) {
        const value = fieldFromDecimal(raw);
        const i = local.append(value);
        if (value === leaf && index < 0) index = i;
      }
      from += values.length;
      if (from === snapshotSize) break;
    }
    if (index < 0) throw new Error(`leaf is not in the ${tree} tree`);
    const path = local.path(index);
    return { index, siblings: path.siblings, root: local.root };
  }

  async latestCensus(wallet: Uint8Array, mint: Uint8Array): Promise<CensusLatestResponse> {
    return this.getJson(
      this.config.indexer,
      `/census/latest?wallet=${toBase58(wallet)}&mint=${toBase58(mint)}`,
    );
  }

  /**
   * Gathers and checks the witness a proof needs: the wallet's registry
   * path (the registered commitment must be this identity's) and, with a
   * `mint`, the path of its latest census snapshot of that mint. Every
   * path is verified against its leaf and root here; the chain checks the
   * roots. The lookups tell the indexer the wallet and mint (use
   * `localWitness` for a registry path that does not).
   */
  async witness(params: WitnessParams): Promise<LoginWitnessData> {
    const wait = params.wait;
    if (wait !== undefined && (!Number.isFinite(wait.timeoutMs) || wait.timeoutMs < 0 ||
      (wait.pollMs !== undefined && (!Number.isFinite(wait.pollMs) || wait.pollMs < 0)))) {
      throw new Error("witness wait needs a non-negative timeoutMs");
    }
    const deadline = Date.now() + (wait?.timeoutMs ?? 0);
    for (;;) {
      try {
        return await this.#witnessOnce(params);
      } catch (error) {
        const retryable = error instanceof WitnessPendingError || (error instanceof IndexerRequestError && error.status === 404);
        const remaining = deadline - Date.now();
        if (!wait || !retryable || remaining <= 0 || wait.signal?.aborted) throw error;
        await sleep(Math.min(wait.pollMs ?? 2_000, remaining), wait.signal);
      }
    }
  }

  async #witnessOnce({ identity, wallet, mint }: WitnessParams): Promise<LoginWitnessData> {
    if (!(wallet instanceof Uint8Array) || wallet.length !== 32) throw new Error("wallet must be a 32-byte public key");
    const binding = await this.getJson<BindingResponse>(this.config.indexer, `/registry/binding/${toBase58(wallet)}`);
    if (typeof binding?.commitment !== "string" || binding.commitment.toLowerCase() !== bytesToHex(fieldToBytes32(identity.commitment))) {
      throw new Error("this wallet is registered with a different identity (another domain, cluster or second factor derived it)");
    }
    const registry = await this.verifiedPath("registry", binding.leafIndex, registryLeaf(wallet, identity.commitment));
    const witness: LoginWitnessData = { registry: { walletPubkey: wallet.slice(), ...registry } };
    if (mint !== undefined) {
      const census = await this.latestCensus(wallet, mint);
      if (census?.wallet !== toBase58(wallet) || census.mint !== toBase58(mint)) throw new Error("indexer answered for another wallet or mint");
      const amount = u64FromDecimal(census.amount), slot = u64FromDecimal(census.slot);
      const path = await this.verifiedPath("census", census.leafIndex, censusLeaf(wallet, mint, amount, slot));
      witness.census = { ...path, amount, slot };
    }
    return witness;
  }

  // ---- login -------------------------------------------------------------

  /**
   * Produces a login proof for this origin from a witness (`witness`).
   *
   * Every public signal is visible to whoever receives the proof. `home`
   * is published as an unsalted hash and registered wallets are public,
   * so a login-only proof (no `policy`) must not bind the wallet: omit
   * `home` and 32 zero bytes are bound. `minSlot` is published as is: an
   * exact snapshot slot identifies the snapshot, so prefer `currentSlot`
   * (read from `chain` when omitted) and let the claim's `maxAgeSlots`
   * derive it.
   */
  async prove(params: {
    identity: DerivedIdentity;
    claim?: Claim;
    /** Explicit min_slot, or give `currentSlot` and the claim's maxAgeSlots applies (preferred). */
    minSlot?: bigint;
    currentSlot?: bigint;
    witness: LoginWitnessData;
    session?: SessionSigner;
    /**
     * Must be later than every session this pocket had before (the pocket
     * enforces it as a replay guard): use currentSlot + policy.sessionMaxSlots.
     */
    expirySlot: bigint;
    /** Pocket recovery address, required with `policy`. Omit for login-only; never the wallet. */
    home?: Uint8Array;
    /** Omit for off-chain login; supply explicitly to authorize a pocket. */
    policy?: Policy;
    /** The pocket's confirmed revocation epoch; read from `chain` when omitted, else zero (only creates a pocket). */
    authorizationEpoch?: bigint;
  }): Promise<GhostLinkSession> {
    if (!this.config.prover) throw new Error("no prover configured");
    if (params.policy !== undefined && params.home === undefined) {
      throw new Error("A pocket authorization requires an explicit home");
    }
    // Anyone holding the proof can hash each registered wallet and compare it
    // with the home signal, so a login-only proof binds zeros, never the wallet.
    const home = params.home ?? new Uint8Array(32);
    const wallet = params.witness?.registry?.walletPubkey;
    if (params.policy === undefined && wallet instanceof Uint8Array && wallet.length === home.length &&
      wallet.every((byte, i) => byte === home[i])) {
      throw new Error("A login-only proof must not bind the wallet as home; omit home");
    }
    const signer = params.session ?? softwareSession();
    const authorization = await this.prepareAuthorization({ ...params, home, session: signer });
    return { ...authorization, signer };
  }

  /**
   * Run on the user's trusted device to authorize a bot's PUBLIC session key.
   * The bot keeps its session secret; the user's identity and proof inputs
   * never go to the bot. This prepares a proof, not an on-chain activation:
   * openSession must confirm before the bot trades. Show the user the bot,
   * home, policy and expiry, and authenticate the key handoff first.
   */
  async authorizeSession(params: SessionAuthorizationParams): Promise<GhostLinkAuthorization> {
    // A remote P-256 key does not establish that a hardware authenticator
    // created it. Never classify a bot-supplied key as passkey-held authority.
    if (params.session?.kind !== 0) throw new Error("Delegated bots require an Ed25519 session public key");
    if (!params.policy) throw new Error("Bot authorization requires an explicit approved policy");
    if (!(params.home instanceof Uint8Array)) throw new Error("Bot authorization requires an explicit home");
    return this.prepareAuthorization(params);
  }

  private async prepareAuthorization(params: Omit<SessionAuthorizationParams, "policy"> & { policy?: Policy }): Promise<GhostLinkAuthorization> {
    if (!this.config.prover) throw new Error("no prover configured");
    const signer = copySessionPublicKey(params.session);
    const origin = this.origin();
    let { currentSlot, authorizationEpoch } = params;
    if (params.claim !== undefined && params.minSlot === undefined && currentSlot === undefined && this.config.chain) {
      currentSlot = await this.currentSlot();
    }
    if (params.policy !== undefined && authorizationEpoch === undefined && this.config.chain) {
      // Renewal binds the stored home, policy and epoch: refuse here what the program would refuse after paying.
      const id = deriveAppId(params.identity.sField, deriveDomainHash(origin));
      const state = await this.pocketState(pocketPda(id, base58(this.deployment.pocketProgram)).address);
      authorizationEpoch = state?.authorizationEpoch ?? 0n;
      if (state) {
        if (bytesToHex(state.home) !== bytesToHex(params.home)) throw new Error("the pocket's recovery home differs; renewal must bind the stored home");
        if (bytesToHex(policyHash(state.policy)) !== bytesToHex(policyHash(params.policy))) {
          throw new Error("the pocket's confirmed policy differs; renewal must use the stored policy");
        }
        if (params.expirySlot <= state.maxSessionExpirySlot) throw new Error("expirySlot must be later than every earlier session of this pocket");
      }
    }
    const { input, appId } = buildLoginInput({
      identity: params.identity,
      origin,
      claim: params.claim,
      minSlot: params.minSlot,
      currentSlot,
      session: signer,
      expirySlot: params.expirySlot,
      home: params.home,
      witness: params.witness,
      policy: params.policy,
      authorizationEpoch,
      deployment: sessionDeployment(this.deployment),
    });
    const proof = await proveLogin(this.config.prover, input, appId);
    return {
      appId,
      appIdBase58: toBase58(fieldBytes(appId)),
      proof,
      signer,
      expirySlot: params.expirySlot,
      authorizationEpoch: authorizationEpoch ?? 0n,
    };
  }

  // ---- pocket -------------------------------------------------------------

  pocketFor(session: GhostLinkAuthorization, home: Uint8Array, policy?: Policy): PocketHandle {
    const pocket = derivePocket(session.appId, home, policy ?? conservativePolicy(), this.deployment);
    this.checkPocketAuthorization(session, pocket);
    return pocket;
  }

  private checkPocketAuthorization(session: GhostLinkAuthorization, pocket: PocketHandle): void {
    const signals = session.proof.publicSignals;
    const context = pocketAuthorizationContext(pocket.policy, session.signer.kind, sessionDeployment(this.deployment),
      session.authorizationEpoch ?? 0n);
    if (signals.length !== 12 || fieldFromDecimal(signals[11]) !== context
      || fieldFromDecimal(signals[9]) !== homeHash(pocket.home)
      || fieldFromDecimal(signals[3]) !== session.appId || pocket.appId !== session.appId) {
      throw new Error("Pocket policy, home, deployment or revocation epoch does not match the approved V2 authorization");
    }
  }

  funding(pocket: PocketHandle): FundingOptions {
    if (!this.config.actions) throw new Error("no actions endpoint configured");
    return fundingOptions(pocket, this.config.actions, this.deployment);
  }

  /**
   * Fetches the Blink's metadata and refuses it unless the endpoint names
   * the very pocket address derived here. This detects metadata mismatches
   * only: the Actions server still supplies the eventual transaction, whose
   * destination and instructions must be checked before a wallet signs it.
   * Use prepareFundingTransaction with independently approved values to check
   * the eventual deposit; this method does not validate transaction bytes.
   */
  async verifyFunding(options: FundingOptions): Promise<FundingOptions> {
    const meta = await this.getJson<{ pocket?: string }>(options.blinkUrl, "");
    if (meta.pocket !== options.address) {
      throw new Error(`funding endpoint names pocket ${meta.pocket ?? "(none)"}, expected ${options.address}`);
    }
    return options;
  }

  /**
   * Opens (or rotates) the pocket session through the relayer and waits
   * for confirmation (`timeoutMs`, default 60 s). The program rebuilds the
   * proof's public inputs from this request, so every value sent is read
   * from the proof; `options.claim`, `roots` and `domainHash`, when given,
   * must equal the proved values or the call is refused before sending.
   *
   * The request ID is derived from the authorization, so calling again
   * after a lost reply reconciles the same operation. Throws
   * `RelayerOperationPendingError` when the deadline passes first (keep
   * `error.operation` and reconcile it), `RelayerOperationFailedError` when
   * the relayer reports a final on-chain failure (resubmitting the same
   * authorization returns it again), and `RelayerRequestError` for a refusal.
   */
  async openSession(session: GhostLinkAuthorization, pocket: PocketHandle, options?: OpenSessionOptions): Promise<TxResponse>;
  /** @deprecated The 0.1 positional form: pass `{ claim, roots, domainHash }` instead. */
  async openSession(session: GhostLinkAuthorization, pocket: PocketHandle, claimFields: LegacyClaimFields,
    roots?: { registry: FieldElement; census: FieldElement }, domainHash?: FieldElement): Promise<TxResponse>;
  async openSession(session: GhostLinkAuthorization, pocket: PocketHandle, third: OpenSessionOptions | LegacyClaimFields = {},
    legacyRoots?: { registry: FieldElement; census: FieldElement }, legacyDomainHash?: FieldElement): Promise<TxResponse> {
    const options: OpenSessionOptions = "mint" in third && third.mint instanceof Uint8Array
      ? { claim: third as LegacyClaimFields, roots: legacyRoots, domainHash: legacyDomainHash } : third as OpenSessionOptions;
    if (!this.config.relayer) throw new Error("no relayer configured");
    this.checkPocketAuthorization(session, pocket);
    const signals = session.proof.publicSignals.map((s) => fieldFromDecimal(s));
    const bound = { registry: signals[0]!, census: signals[1]!, domainHash: signals[2]! };
    const proved = provenClaim(session.proof.publicSignals);
    const signer = copySessionPublicKey(session.signer);
    if (options.claim !== undefined) {
      const expected = expectedClaim(options.claim);
      // A mismatch would only make the program reject the proof after the relayer paid for it.
      if ((expected === null) !== (proved === null) || (expected && proved && (bytesToHex(expected.mint) !== bytesToHex(proved.mint) ||
        expected.threshold !== proved.threshold || expected.minSlot !== proved.minSlot))) {
        throw new Error("Claim fields, session, roots or domain hash do not match the proof's public signals");
      }
    }
    if (sessionCommitmentFor(signer, session.expirySlot) !== signals[8] ||
      (options.roots !== undefined && (options.roots.registry !== bound.registry || options.roots.census !== bound.census)) ||
      (options.domainHash !== undefined && options.domainHash !== bound.domainHash)) {
      throw new Error("Claim fields, session, roots or domain hash do not match the proof's public signals");
    }
    const mint = joinBytes32(signals[4]!, signals[5]!);
    const req: OpenSessionRequest = {
      proofAHex: bytesToHex(session.proof.proof.a),
      proofBHex: bytesToHex(session.proof.proof.b),
      proofCHex: bytesToHex(session.proof.proof.c),
      registryRootHex: bytesToHex(fieldBytes(bound.registry)),
      censusRootHex: bytesToHex(fieldBytes(bound.census)),
      domainHashHex: bytesToHex(fieldBytes(bound.domainHash)),
      appIdHex: bytesToHex(fieldBytes(session.appId)),
      mint: toBase58(mint),
      threshold: signals[6]!.toString(),
      minSlot: signals[7]!.toString(),
      claimHoldings: proved !== null,
      sessionKind: signer.kind,
      sessionKeyHex: bytesToHex(signer.key33),
      sessionExpirySlot: session.expirySlot.toString(),
      home: toBase58(pocket.home),
      policy: policyToDto(pocket.policy),
    };
    // Same authorization/body keeps one identity even when this method is called again after a lost reply.
    const receipt = await this.#relay("/open-session", req, options, relayerRequestDigest("/open-session", req));
    return { signature: receipt.signature! };
  }

  async #relay<R extends "/register" | "/snapshot" | "/open-session" | "/owner-action">(route: R,
    request: Parameters<typeof prepareRelayerOperation<R>>[1], options: RelayOptions, defaultId?: string): Promise<RelayerReceipt> {
    if (!this.config.relayer) throw new Error("no relayer configured");
    const operation = prepareRelayerOperation(route, request, options.requestIdHex ?? defaultId);
    await options.save?.(structuredClone(operation));
    return new RelayerClient(this.config.relayer, this.fetchFn).settle(operation, options);
  }

  // ---- owner actions --------------------------------------------------------

  /**
   * Proves one owner action on this identity's pocket for this origin:
   * `sweep` (every balance home), `revoke` (end the session and invalidate
   * every earlier session authorization), `propose` (stage a home or policy
   * change behind the 24-hour timelock) or `cancel` (drop the staged
   * change). Reads the pocket's current owner action nonce, home and
   * pending change from `chain`, proves on this device, and checks the
   * nonce did not move meanwhile. Submit the result with
   * `submitOwnerAction` or `ownerActionInstructions`, once.
   */
  async proveOwnerAction(params: OwnerActionParams): Promise<OwnerAuthorization> {
    const prover = this.config.prover;
    if (!prover) throw new Error("no prover configured");
    const { identity, action } = params;
    const registry = params.witness?.registry;
    if (!registry || !(registry.walletPubkey instanceof Uint8Array) || !verifyWitness(registryLeaf(registry.walletPubkey, identity.commitment), registry)) {
      throw new Error("invalid registry witness for this identity");
    }
    const dHash = deriveDomainHash(this.origin()), appId = deriveAppId(identity.sField, dHash);
    const pocket = pocketPda(appId, base58(this.deployment.pocketProgram)).address;
    await this.currentSlot();
    const state = await this.pocketState(pocket);
    if (!state) throw new Error(`no pocket for this identity at ${this.origin()} yet`);
    if (bytesToHex(state.appId) !== bytesToHex(fieldBytes(appId)) || bytesToHex(state.domainHash) !== bytesToHex(fieldBytes(dHash))) {
      throw new Error("the pocket account does not belong to this identity and origin");
    }
    const nonce = state.ownerActionNonce;
    let digest: Uint8Array, change: PocketChange | undefined, changeBorsh: Uint8Array | undefined;
    switch (action) {
      case "sweep": digest = sweepDigest(pocket, nonce); break;
      case "revoke": digest = revokeDigest(pocket, nonce); break;
      case "propose":
        if (!params.change) throw new Error("propose needs a change: { home } or { policy }");
        if (state.pending) throw new Error("a change is already pending; cancel it first");
        change = params.change;
        changeBorsh = pocketChangeBorsh(change);
        digest = changeDigest(pocket, changeBorsh, nonce);
        break;
      case "cancel":
        if (!state.pending) throw new Error("no change is pending");
        change = state.pending.change;
        changeBorsh = state.pending.borsh;
        digest = cancelDigest(pocket, changeBorsh, nonce);
        break;
      default: throw new Error("unknown owner action");
    }
    if (action !== "propose" && params.change !== undefined) throw new Error("only propose takes a change");
    const pkHalves = splitBytes32(registry.walletPubkey);
    const expected = [registry.root, dHash, appId, hashToField(digest)].map(String);
    const input = {
      registry_root: expected[0]!, domain_hash: expected[1]!, app_id: expected[2]!, action_hash: expected[3]!,
      s: identity.sField.toString(), pk_hi: pkHalves.hi.toString(), pk_lo: pkHalves.lo.toString(),
      reg_index: String(registry.index), reg_siblings: registry.siblings.map(String),
    };
    const result = await prover.prove("owner", input);
    if (!Array.isArray(result.publicSignals) || result.publicSignals.length !== 4 || result.publicSignals.some((v, i) => v !== expected[i])) {
      throw new Error("prover returned a different owner action");
    }
    const after = await this.pocketState(pocket);
    if (after?.ownerActionNonce !== nonce) throw new Error("the pocket's owner action nonce moved while proving; prove again from fresh state");
    return {
      action, pocket, appId, ownerActionNonce: nonce, registryRoot: registry.root, proof: proofToBytes(result.proof as never),
      ...(action === "sweep" ? { home: state.home } : {}),
      ...(change ? { change, changeBorsh } : {}),
    };
  }

  /**
   * Submits a proved owner action through the relayer and waits for
   * confirmation. For a sweep pass the pocket's token accounts as
   * `tokenPairs` (destinations optional: the relayer picks clean home-owned
   * accounts). The reference relayer submits home changes only: send a
   * policy change with `ownerActionInstructions`. The default request ID is
   * the request digest, so a retry after a lost reply reconciles the same
   * operation instead of spending another proof.
   */
  async submitOwnerAction(authorization: OwnerAuthorization, options: RelayOptions & { tokenPairs?: readonly SweepTokenPair[] } = {}): Promise<RelayerReceipt> {
    if (authorization.action === "propose" && authorization.change && !("home" in authorization.change)) {
      throw new Error("the reference relayer submits only home changes; send a policy change with ownerActionInstructions");
    }
    const request = ownerActionRequest(authorization, { tokenPairs: options.tokenPairs });
    return this.#relay("/owner-action", request, options, relayerRequestDigest("/owner-action", request));
  }

  /**
   * A proved owner action as instructions for an app that sends its own
   * transaction: a compute-budget instruction (proof verification needs
   * it), then the action. A sweep needs explicit destinations: initialized
   * home-owned token accounts of the same mint with no delegate or foreign
   * close authority (for example the home's associated token accounts).
   */
  ownerActionInstructions(authorization: OwnerAuthorization, params: {
    payer: Uint8Array;
    tokenPairs?: readonly { source: Uint8Array; destination: Uint8Array }[];
  }): GhostLinkInstruction[] {
    const a = authorization, d = this.deployment;
    const proof = { proof: a.proof, registryRoot: fieldBytes(a.registryRoot) };
    let ix: GhostLinkInstruction;
    switch (a.action) {
      case "sweep":
        if (!a.home) throw new Error("a sweep authorization carries the pocket's home");
        ix = sweepHomeInstruction(d, params.payer, a.pocket, a.home, proof, params.tokenPairs ?? []);
        break;
      case "revoke": ix = revokeSessionInstruction(d, params.payer, a.pocket, proof); break;
      case "propose":
        if (!a.changeBorsh) throw new Error("a propose authorization carries its change");
        ix = proposeChangeInstruction(d, params.payer, a.pocket, a.changeBorsh, proof);
        break;
      case "cancel": ix = cancelChangeInstruction(d, params.payer, a.pocket, proof); break;
      default: throw new Error("unknown owner action");
    }
    if (a.action !== "sweep" && params.tokenPairs?.length) throw new Error("token pairs belong to a sweep");
    return [computeBudgetInstruction(PROOF_COMPUTE_UNITS), ix];
  }

  /**
   * Applies a staged change once `pocketState(...).pending.executableAfterSlot`
   * has passed. Anyone may send it and no proof is needed: the owner
   * authorized the change when proposing it. The watcher service sends it
   * automatically when it runs.
   */
  executeChangeInstructions(pocket: Uint8Array, payer: Uint8Array): GhostLinkInstruction[] {
    return [executeChangeInstruction(this.deployment, payer, pocket)];
  }

  // ---- intents --------------------------------------------------------------

  async submitIntent(
    pocket: PocketHandle,
    session: SessionSigner,
    params: IntentParams,
  ): Promise<{ signed: SignedIntent; tx: IntentSubmission }> {
    if (!this.config.solver) throw new Error("no solver configured");
    const publicKey = copySessionPublicKey(session);
    const signed = await signIntent(pocket, session, params);
    return { signed, tx: await this.submitSignedIntent(signed, publicKey) };
  }

  /** Retry an already-signed intent without changing its nonce or prompting the signer again. */
  async submitSignedIntent(signed: SignedIntent, session: SessionPublicKey): Promise<IntentSubmission> {
    if (!this.config.solver) throw new Error("no solver configured");
    const key = copySessionPublicKey(session);
    const expectedHash = bytesToHex(intentHash(signed.intent));
    if (expectedHash !== bytesToHex(signed.hash)) throw new Error("signed intent was mutated");
    const req: IntentRequest = {
      pocket: toBase58(signed.intent.pocket),
      nonce: signed.intent.nonce.toString(),
      inMint: toBase58(signed.intent.inMint),
      inMax: signed.intent.inMax.toString(),
      outMint: toBase58(signed.intent.outMint),
      outMin: signed.intent.outMin.toString(),
      deadlineSlot: signed.intent.deadlineSlot.toString(),
      policyHashHex: bytesToHex(signed.intent.policyHash),
      sessionKind: key.kind,
      signatureHex: bytesToHex(signed.signature.signature),
      sessionKeyHex: bytesToHex(key.kind === 0 ? key.key32 : key.key33),
      webauthn: signed.signature.webauthn
        ? {
            authenticatorDataHex: bytesToHex(signed.signature.webauthn.authenticatorData),
            clientDataJsonUtf8: new TextDecoder().decode(signed.signature.webauthn.clientDataJson),
          }
        : undefined,
    };
    const tx = await this.postJson<IntentSubmission>(this.config.solver, "/intent", req);
    return this.checkedIntentStatus(tx, expectedHash);
  }

  /** Poll the exact intent; a submission receipt is not confirmation. */
  async intentStatus(intentHashHex: string): Promise<IntentSubmission> {
    if (!this.config.solver) throw new Error("no solver configured");
    if (!/^[0-9a-f]{64}$/.test(intentHashHex)) throw new Error("invalid intent hash");
    const response = await this.fetchFn(`${this.config.solver}/intents/${intentHashHex}`);
    if (!response.ok) throw new Error(`solver status: HTTP ${response.status}`);
    return this.checkedIntentStatus(await response.json(), intentHashHex);
  }

  private checkedIntentStatus(value: unknown, expectedHash: string): IntentSubmission {
    const v = value as IntentSubmission;
    if (!v || v.intentHashHex !== expectedHash || !["preparing", "pending", "confirmed", "finalized", "failed", "expired", "unknown"].includes(v.state)) {
      throw new Error("invalid solver submission receipt");
    }
    if (!["preparing", "unknown"].includes(v.state) && (typeof v.signature !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(v.signature))) throw new Error("missing transaction identity");
    if (["confirmed", "finalized", "failed"].includes(v.state) && (!Number.isSafeInteger(v.slot) || v.slot! < 0 ||
      !["confirmed", "finalized"].includes(v.confirmationStatus ?? ""))) throw new Error("missing confirmation evidence");
    if ((v.state === "confirmed" || v.state === "finalized") && v.confirmationStatus !== v.state) throw new Error("inconsistent confirmation evidence");
    return v;
  }
}

export function policyToDto(p: Policy): PolicyDto {
  return {
    dailyCapUsdE6: p.dailyCapUsdE6.toString(),
    maxSlippageBps: p.maxSlippageBps,
    bigActionThresholdUsdE6: p.bigActionThresholdUsdE6.toString(),
    noOracleCapUsdE6: p.noOracleCapUsdE6.toString(),
    sessionMaxSlots: p.sessionMaxSlots.toString(),
    allowedOutMints: p.allowedOutMints.map(toBase58),
    speculative: p.speculative && { dailyBuyCapUsdE6: p.speculative.dailyBuyCapUsdE6.toString(),
      maxCostExposureUsdE6: p.speculative.maxCostExposureUsdE6.toString(),
      maxPositions: p.speculative.maxPositions, baseMints: p.speculative.baseMints.map(toBase58) },
    oracleFeeds: p.oracleFeeds.map((f) => ({
      mint: toBase58(f.mint),
      feedIdHex: bytesToHex(f.feedId),
      decimals: f.decimals,
    })),
  };
}

export function policyFromDto(d: PolicyDto): Policy {
  const bs58decode = (s: string) => hexToBytes(bytesToHex(base58(s)));
  return {
    dailyCapUsdE6: BigInt(d.dailyCapUsdE6),
    maxSlippageBps: d.maxSlippageBps,
    bigActionThresholdUsdE6: BigInt(d.bigActionThresholdUsdE6),
    noOracleCapUsdE6: BigInt(d.noOracleCapUsdE6),
    sessionMaxSlots: BigInt(d.sessionMaxSlots),
    allowedOutMints: d.allowedOutMints.map(bs58decode),
    speculative: d.speculative && { dailyBuyCapUsdE6: BigInt(d.speculative.dailyBuyCapUsdE6),
      maxCostExposureUsdE6: BigInt(d.speculative.maxCostExposureUsdE6),
      maxPositions: d.speculative.maxPositions, baseMints: d.speculative.baseMints.map(bs58decode) },
    oracleFeeds: d.oracleFeeds.map((f) => ({
      mint: bs58decode(f.mint),
      feedId: hexToBytes(f.feedIdHex),
      decimals: f.decimals,
    })),
  };
}

const fieldBytes = fieldToBytes32;

function expectedClaim(claim: ProvenClaim | null | LegacyClaimFields): ProvenClaim | null {
  if (claim === null) return null;
  if ("claim" in claim) return claim.claim ? { mint: claim.mint, threshold: claim.threshold, minSlot: claim.minSlot } : null;
  return claim;
}

function holdingOf(params: SnapshotParams): Uint8Array {
  if (!(params.wallet instanceof Uint8Array) || params.wallet.length !== 32) throw new Error("wallet must be a 32-byte public key");
  if (params.holding !== undefined) {
    if (params.mint !== undefined) throw new Error("pass mint or holding, not both");
    if (!(params.holding instanceof Uint8Array) || params.holding.length !== 32) throw new Error("holding must be a 32-byte address");
    return params.holding;
  }
  if (!(params.mint instanceof Uint8Array)) throw new Error("a snapshot needs a mint (its associated token account) or an explicit holding");
  return associatedTokenAddress(params.wallet, params.mint);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); }
    signal?.addEventListener("abort", done, { once: true });
  });
}

const DECIMAL = /^(0|[1-9][0-9]*)$/;

/** A served field element: canonical decimal and reduced, or an error. */
function fieldFromDecimal(s: unknown): FieldElement {
  if (typeof s !== "string" || s.length > 77 || !DECIMAL.test(s)) throw new Error("indexer served a non-decimal field element");
  const v = BigInt(s);
  if (v >= FIELD_PRIME) throw new Error("indexer served an unreduced field element");
  return v;
}

function u64FromDecimal(s: unknown): bigint {
  if (typeof s !== "string" || s.length > 20 || !DECIMAL.test(s) || BigInt(s) >= 1n << 64n) throw new Error("indexer served an invalid u64");
  return BigInt(s);
}

import { pk as base58 } from "@ghostlink/common";
export { IncrementalTree };
