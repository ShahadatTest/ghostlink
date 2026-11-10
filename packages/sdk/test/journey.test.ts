/**
 * The integration journey through the client: registration, census,
 * witnesses, owner actions and the chain reads they depend on. Fixtures are
 * the published development vectors and proofs; the network is mocked.
 */
import { readFileSync } from "node:fs";
import { sha256 } from "@noble/hashes/sha256";
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import { describe, expect, it, vi } from "vitest";
import {
  LOCALNET_DEPLOYMENT, bindingPda, bytesToHex, censusConfigPda, conservativePolicy, fieldToBytes32, hexToBytes, pk,
  pocketAuthorizationContext, proofToBytes, registryLeaf, relayerRequestDigest, sessionDeployment,
  type Policy,
} from "@ghostlink/common";
import {
  GhostLink, IndexerRequestError, POCKET_ACCOUNT_SIZE, WitnessPendingError, associatedTokenAddress, buildLoginInput,
  decodePocketAccount, jsonRpcChainReader, normalizeClaim, ownerActionRequest, pocketChangeBorsh, provenClaim,
  sessionPublicKey, softwareSession, holdingsClaim, claimMintFields,
  type ChainAccount, type ChainReader, type DerivedIdentity, type PocketChange, type Prover,
} from "../src/index.js";
import { fixturePolicy } from "./fixture-policy.js";

const vectors = JSON.parse(readFileSync(new URL("../../common/fixtures/vectors.json", import.meta.url), "utf8"));
const actions = JSON.parse(readFileSync(new URL("../../../circuits/keys/owner_actions.json", import.meta.url), "utf8"));
const loginFixture = JSON.parse(readFileSync(new URL("../../../circuits/keys/login_proof.json", import.meta.url), "utf8"));
const login = vectors.circuits.login, owner = vectors.circuits.owner;
const origin: string = vectors.identity.origin;
const wallet = hexToBytes(vectors.identity.walletPubkey);
const walletSeed = hexToBytes(vectors.identity.walletSeed);
const mint = hexToBytes(vectors.census.mint);
const home = hexToBytes(vectors.identity.homeAddress);
const pocketAddress = bs58.decode(vectors.pdas.pocket.address);
const appId = BigInt(vectors.identity.appId);
const identity: DerivedIdentity = {
  secret: hexToBytes(vectors.identity.sBytes), sField: BigInt(vectors.identity.sField),
  commitment: BigInt(vectors.identity.commitment), deterministic: true, method: "signMessage", withFactor: false,
};
const registryWitness = {
  walletPubkey: wallet, index: Number(owner.private.reg_index),
  siblings: owner.private.reg_siblings.map(BigInt) as bigint[], root: BigInt(owner.public.registry_root),
};
const LOCAL_GENESIS = bs58.encode(new Uint8Array(32).fill(7));
const POCKET_PROGRAM = pk(LOCALNET_DEPLOYMENT.pocketProgram);

/** A PocketV3 account with the fields owner software reads; everything else zero. */
function pocketAccount(state: { home?: Uint8Array; policy?: Policy; nonce?: bigint; epoch?: bigint; pending?: PocketChange;
  maxExpiry?: bigint; appIdBytes?: Uint8Array }): Uint8Array {
  const out = new Uint8Array(POCKET_ACCOUNT_SIZE);
  let off = 0;
  const put = (bytes: Uint8Array) => { out.set(bytes, off); off += bytes.length; };
  const u64 = (v: bigint) => { const b = new Uint8Array(8); for (let i = 0; i < 8; i++) b[i] = Number((v >> BigInt(8 * i)) & 0xffn); put(b); };
  put(sha256(new TextEncoder().encode("account:PocketV3")).subarray(0, 8));
  put(state.appIdBytes ?? fieldToBytes32(appId));
  put(fieldToBytes32(BigInt(vectors.identity.domainHash)));
  put(state.home ?? home);
  put(new Uint8Array(1 + 33)); u64(5000n); u64(state.epoch ?? 0n);
  put(pocketChangeBorsh({ policy: state.policy ?? fixturePolicy() }).subarray(1));
  if (state.pending) { put(new Uint8Array([1])); put(pocketChangeBorsh(state.pending)); u64(999n); } else put(new Uint8Array([0]));
  off += 8 + 25 * 8 + 256 + 1;
  u64(state.maxExpiry ?? 0n); u64(0n); u64(state.nonce ?? 0n);
  return out;
}

function chainOf(accounts: Map<string, ChainAccount>, slot = 1_000n, genesis = LOCAL_GENESIS) {
  return {
    getGenesisHash: vi.fn(async () => genesis),
    getSlot: vi.fn(async () => slot),
    getAccount: vi.fn(async (address: Uint8Array) => accounts.get(bs58.encode(address)) ?? null),
  } satisfies ChainReader;
}
const pocketOwned = (data: Uint8Array): ChainAccount => ({ owner: POCKET_PROGRAM, data, lamports: 10_000_000n });

const confirmed = (requestIdHex: string) =>
  Response.json({ requestIdHex, state: "confirmed", signature: "1".repeat(64), slot: 50, confirmationStatus: "confirmed" });

function relayer(reply: (path: string, body: Record<string, unknown>) => Response = (_p, body) => confirmed(String(body.requestIdHex))) {
  return vi.fn(async (url: unknown, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    return reply(path, init?.body ? JSON.parse(String(init.body)) : {});
  });
}

describe("chain reads", () => {
  it("speaks Solana JSON-RPC over fetch with no RPC client", async () => {
    const data = new Uint8Array([1, 2, 3, 250]);
    const fetchFn = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const { method, params } = JSON.parse(String(init!.body));
      if (method === "getGenesisHash") return Response.json({ jsonrpc: "2.0", id: 1, result: LOCAL_GENESIS });
      if (method === "getSlot") return Response.json({ jsonrpc: "2.0", id: 1, result: 77 });
      expect(params[1]).toEqual({ encoding: "base64", commitment: "confirmed", minContextSlot: 70 });
      if (params[0] === bs58.encode(home)) return Response.json({ jsonrpc: "2.0", id: 1, result: { context: { slot: 77 }, value: null } });
      if (params[0] === bs58.encode(wallet)) return Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32016, message: "Minimum context slot has not been reached" } });
      return Response.json({ jsonrpc: "2.0", id: 1, result: { context: { slot: 77 }, value: {
        owner: LOCALNET_DEPLOYMENT.pocketProgram, lamports: 5, executable: false, data: [Buffer.from(data).toString("base64"), "base64"] } } });
    });
    const reader = jsonRpcChainReader("http://rpc.test", { fetchFn });
    expect(await reader.getGenesisHash()).toBe(LOCAL_GENESIS);
    expect(await reader.getSlot()).toBe(77n);
    expect(await reader.getAccount(pocketAddress, 70n)).toEqual({ owner: POCKET_PROGRAM, data, lamports: 5n });
    expect(await reader.getAccount(home, 70n)).toBeNull();
    await expect(reader.getAccount(wallet, 70n)).rejects.toThrow(/Minimum context slot/);
  });

  it("decodes the pocket fields owner actions bind, including the exact pending change bytes", () => {
    const newHome = new Uint8Array(32).fill(5);
    const state = decodePocketAccount(pocketAccount({ nonce: 7n, epoch: 3n, maxExpiry: 4321n, pending: { home: newHome } }));
    expect(state).toMatchObject({ ownerActionNonce: 7n, authorizationEpoch: 3n, maxSessionExpirySlot: 4321n, sessionExpirySlot: 5000n,
      home, policy: fixturePolicy(), pending: { change: { home: newHome }, executableAfterSlot: 999n } });
    expect(state.pending!.borsh).toEqual(pocketChangeBorsh({ home: newHome }));
    const policy = { ...conservativePolicy(), speculative: undefined };
    const withPolicy = decodePocketAccount(pocketAccount({ pending: { policy: fixturePolicy() }, policy, nonce: 2n }));
    expect(withPolicy.pending!.change).toEqual({ policy: fixturePolicy() });
    expect(withPolicy.ownerActionNonce).toBe(2n);
    expect(() => decodePocketAccount(new Uint8Array(100))).toThrow(/PocketV3/);
  });

  it("checks the chain is the deployment's before reading, and refuses accounts of other programs", async () => {
    const accounts = new Map([[vectors.pdas.pocket.address, pocketOwned(pocketAccount({}))]]);
    const devnet = chainOf(accounts, 1n, "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG");
    const wrong = await GhostLink.init({ cluster: "localnet", indexer: "https://indexer.test", origin, chain: devnet });
    await expect(wrong.pocketState(pocketAddress)).rejects.toThrow(/genesis|public/i);
    expect(devnet.getAccount).not.toHaveBeenCalled();
    const client = await GhostLink.init({ cluster: "localnet", indexer: "https://indexer.test", origin, chain: chainOf(accounts) });
    expect((await client.pocketState(pocketAddress))?.home).toEqual(home);
    expect(await client.pocketState(home)).toBeNull();
    accounts.set(bs58.encode(home), { owner: new Uint8Array(32).fill(9), data: new Uint8Array(POCKET_ACCOUNT_SIZE), lamports: 1n });
    await expect(client.pocketState(home)).rejects.toThrow(/not owned by the deployment's pocket program/);
    expect(await client.currentSlot()).toBe(1_000n);
    await expect((await GhostLink.init({ cluster: "localnet", indexer: "x", origin })).currentSlot()).rejects.toThrow(/no chain reader/);
  });
});

describe("registration and census", () => {
  const signMessage = async (message: Uint8Array) => ed25519.sign(message, walletSeed);

  it("registers through the relayer with only the commitment and the wallet's signature", async () => {
    expect(ed25519.getPublicKey(walletSeed)).toEqual(wallet);
    const fetchFn = relayer();
    const save = vi.fn();
    const client = await GhostLink.init({ cluster: "localnet", indexer: "https://indexer.test", relayer: "https://relayer.test", origin, fetchFn });
    const receipt = await client.register({ identity, wallet, signMessage }, { save });
    expect(receipt.state).toBe("confirmed");
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(String(url)).toBe("https://relayer.test/register");
    const body = JSON.parse(String(init!.body));
    expect(body.walletPubkey).toBe(bs58.encode(wallet));
    expect(body.commitmentHex).toBe(bytesToHex(fieldToBytes32(identity.commitment)));
    // The published registration vector: the local registry build expects the devnet tag.
    expect(body.messageHex).toBe(vectors.registration.messageHex);
    expect(JSON.stringify(body)).not.toContain(vectors.identity.sBytes);
    // Deterministic: a retry after a lost reply is the same operation.
    const { requestIdHex, ...request } = body;
    expect(requestIdHex).toBe(relayerRequestDigest("/register", request));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ route: "/register", requestIdHex }));
    // A wallet that signs something else is refused before anything is sent.
    await expect(client.register({ identity, wallet, signMessage: async (m) => ed25519.sign(m, new Uint8Array(32).fill(1)) }))
      .rejects.toThrow(/does not verify/);
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("builds the same registration as instructions, and refuses a wallet already registered", async () => {
    const accounts = new Map<string, ChainAccount>();
    const client = await GhostLink.init({ cluster: "localnet", indexer: "https://indexer.test", origin, chain: chainOf(accounts) });
    const payer = new Uint8Array(32).fill(3);
    const [verify, register] = await client.registerInstructions({ identity, wallet, signMessage, payer });
    expect(bs58.encode(verify!.programId)).toBe("Ed25519SigVerify111111111111111111111111111");
    expect(verify!.data.subarray(16, 48)).toEqual(wallet);
    const message = verify!.data.subarray(16 + 32 + 64);
    expect(ed25519.verify(verify!.data.subarray(48, 112), message, wallet)).toBe(true);
    expect(bs58.encode(register!.programId)).toBe(LOCALNET_DEPLOYMENT.registryProgram);
    expect(register!.keys.map(k => bs58.encode(k.pubkey))).toEqual([bs58.encode(payer), bs58.encode(wallet),
      bs58.encode(bindingPda(wallet, pk(LOCALNET_DEPLOYMENT.registryProgram)).address), expect.any(String),
      "Sysvar1nstructions1111111111111111111111111", "11111111111111111111111111111111"]);
    expect(register!.data.subarray(8)).toEqual(fieldToBytes32(identity.commitment));
    const binding = new Uint8Array(56); binding.set(fieldToBytes32(identity.commitment), 16);
    accounts.set(bs58.encode(bindingPda(wallet, pk(LOCALNET_DEPLOYMENT.registryProgram)).address),
      { owner: pk(LOCALNET_DEPLOYMENT.registryProgram), data: binding, lamports: 1n });
    await expect(client.registerInstructions({ identity, wallet, signMessage, payer })).rejects.toThrow(/already registered with this identity/);
  });

  it("snapshots a mint's associated token account, or an explicit holding, and reads the census fee for instructions", async () => {
    const fetchFn = relayer();
    const config = new Uint8Array(17); config.set(sha256(new TextEncoder().encode("account:Config")).subarray(0, 8)); config[8] = 0xa0; config[9] = 0x86; config[10] = 0x01;
    const accounts = new Map([[bs58.encode(censusConfigPda(pk(LOCALNET_DEPLOYMENT.censusProgram)).address),
      { owner: pk(LOCALNET_DEPLOYMENT.censusProgram), data: config, lamports: 1n }]]);
    const client = await GhostLink.init({ cluster: "localnet", indexer: "https://indexer.test", relayer: "https://relayer.test", origin, fetchFn,
      chain: chainOf(accounts) });
    await client.snapshot({ wallet, mint });
    await client.snapshot({ wallet, holding: wallet });
    const bodies = fetchFn.mock.calls.map(([, init]) => JSON.parse(String(init!.body)));
    expect(bodies[0]).toMatchObject({ wallet: bs58.encode(wallet), holding: bs58.encode(associatedTokenAddress(wallet, mint)) });
    expect(bodies[1]).toMatchObject({ holding: bs58.encode(wallet) });
    // Each snapshot is a new operation: two snapshots never share a request ID.
    expect(bodies[0].requestIdHex).not.toBe(bodies[1].requestIdHex);
    const [ix] = await client.snapshotInstructions({ wallet, mint, payer: wallet });
    expect(ix!.data.subarray(8)).toEqual(new Uint8Array([0xa0, 0x86, 0x01, 0, 0, 0, 0, 0])); // 100 000 lamports read from the config
    await expect(client.snapshot({ wallet } as never)).rejects.toThrow(/mint/);
  });
});

describe("witnesses", () => {
  const binding = { leafIndex: Number(login.private.reg_index), commitment: bytesToHex(fieldToBytes32(identity.commitment)), slot: "10" };
  const census = { leafIndex: Number(login.private.cen_index), wallet: bs58.encode(wallet), mint: bs58.encode(mint),
    amount: vectors.census.amount, slot: vectors.census.slot };
  function indexer(pendingCalls = 0) {
    let calls = 0;
    return vi.fn(async (url: unknown) => {
      const path = new URL(String(url)).pathname + new URL(String(url)).search;
      if (path.startsWith("/registry/binding/")) {
        if (calls++ < pendingCalls) return Response.json({ error: "not yet", completesAfterSlot: "300" }, { status: 404 });
        return Response.json(binding);
      }
      if (path.startsWith("/census/latest")) return Response.json(census);
      if (path === `/path/registry/${binding.leafIndex}`) return Response.json({ tree: "registry", index: binding.leafIndex, siblings: login.private.reg_siblings, root: login.public.registry_root });
      if (path === `/path/census/${census.leafIndex}`) return Response.json({ tree: "census", index: census.leafIndex, siblings: login.private.cen_siblings, root: login.public.census_root });
      return Response.json({ error: "no such route" }, { status: 404 });
    });
  }

  it("gathers verified registry and census paths a proof accepts", async () => {
    const client = await GhostLink.init({ cluster: "localnet", indexer: "https://indexer.test", origin, fetchFn: indexer() });
    const witness = await client.witness({ identity, wallet, mint });
    expect(witness.registry.root).toBe(BigInt(login.public.registry_root));
    expect(witness.census).toMatchObject({ amount: BigInt(vectors.census.amount), slot: BigInt(vectors.census.slot), root: BigInt(login.public.census_root) });
    const { input } = buildLoginInput({ identity, origin, witness, claim: { mint, threshold: BigInt(login.public.threshold), maxAgeSlots: 9000n },
      minSlot: BigInt(login.public.min_slot), session: sessionPublicKey(0, softwareSession(hexToBytes(vectors.identity.sessionSeed)).key32),
      expirySlot: BigInt(vectors.identity.expirySlot), home, policy: fixturePolicy() });
    expect(input).toEqual({ ...login.public, ...login.private });
    expect((await client.witness({ identity, wallet })).census).toBeUndefined();
  });

  it("refuses a wallet registered with another identity", async () => {
    const client = await GhostLink.init({ cluster: "localnet", indexer: "https://indexer.test", origin, fetchFn: indexer() });
    await expect(client.witness({ identity: { commitment: identity.commitment + 1n }, wallet })).rejects.toThrow(/different identity/);
  });

  it("throws WitnessPendingError at once without wait, and waits up to its deadline with it", async () => {
    const pending = await GhostLink.init({ cluster: "localnet", indexer: "https://indexer.test", origin, fetchFn: indexer(2) });
    await expect(pending.witness({ identity, wallet })).rejects.toBeInstanceOf(WitnessPendingError);
    const fetchFn = indexer(2);
    const waiting = await GhostLink.init({ cluster: "localnet", indexer: "https://indexer.test", origin, fetchFn });
    await expect(waiting.witness({ identity, wallet, wait: { timeoutMs: 5_000, pollMs: 1 } })).resolves.toMatchObject({ registry: { index: binding.leafIndex } });
    const stuck = await GhostLink.init({ cluster: "localnet", indexer: "https://indexer.test", origin, fetchFn: indexer(1_000) });
    const started = Date.now();
    const error = await stuck.witness({ identity, wallet, wait: { timeoutMs: 50, pollMs: 10 } }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WitnessPendingError);
    expect((error as WitnessPendingError).completesAfterSlot).toBe(300n);
    expect(Date.now() - started).toBeLessThan(2_000);
    const missing = await GhostLink.init({ cluster: "localnet", indexer: "https://indexer.test", origin,
      fetchFn: async () => Response.json({ error: "not registered" }, { status: 404 }) });
    await expect(missing.witness({ identity, wallet })).rejects.toMatchObject({ name: "IndexerRequestError", status: 404, serverMessage: "not registered" });
    await expect(missing.witness({ identity, wallet, wait: { timeoutMs: 20, pollMs: 5 } })).rejects.toBeInstanceOf(IndexerRequestError);
  });
});

describe("owner actions", () => {
  const proved = (name: string) => actions[name] as { ownerActionNonce: string; proof: object; publicSignals: string[] };
  async function ownerClient(state: Parameters<typeof pocketAccount>[0], options: { fetchFn?: typeof fetch; afterProof?: () => void } = {}) {
    const accounts = new Map([[vectors.pdas.pocket.address, pocketOwned(pocketAccount(state))]]);
    const inputs: Record<string, unknown>[] = [];
    const prover: Prover = { prove: vi.fn(async (circuit, input) => {
      expect(circuit).toBe("owner");
      inputs.push(input);
      const hit = Object.values(actions).find((a: any) => a?.publicSignals?.[3] === input.action_hash) as { proof: object; publicSignals: string[] } | undefined;
      if (!hit) throw new Error(`no fixture proof for action hash ${String(input.action_hash)}`);
      options.afterProof?.();
      return structuredClone(hit);
    }) };
    const client = await GhostLink.init({ cluster: "localnet", indexer: "https://indexer.test", relayer: "https://relayer.test", origin, prover,
      chain: chainOf(accounts), fetchFn: options.fetchFn });
    return { client, inputs, accounts };
  }

  it("proves a sweep against the chain's nonce and home, exactly as the program checks it", async () => {
    const { client, inputs } = await ownerClient({ nonce: 0n });
    const authorization = await client.proveOwnerAction({ identity, witness: { registry: registryWitness }, action: "sweep" });
    const fixture = proved("sweep");
    expect(inputs[0]).toEqual({ ...owner.private, registry_root: fixture.publicSignals[0], domain_hash: fixture.publicSignals[1],
      app_id: fixture.publicSignals[2], action_hash: fixture.publicSignals[3] });
    expect(authorization).toMatchObject({ action: "sweep", pocket: pocketAddress, appId, ownerActionNonce: 0n, home,
      registryRoot: registryWitness.root, proof: proofToBytes(fixture.proof as never) });
    const request = ownerActionRequest(authorization, { tokenPairs: [{ source: new Uint8Array(32).fill(8), mint }] });
    expect(request).toEqual({ pocket: vectors.pdas.pocket.address, action: "sweep", home: bs58.encode(home),
      tokenPairs: [{ source: bs58.encode(new Uint8Array(32).fill(8)), mint: bs58.encode(mint) }],
      proofAHex: bytesToHex(authorization.proof.a), proofBHex: bytesToHex(authorization.proof.b), proofCHex: bytesToHex(authorization.proof.c),
      registryRootHex: bytesToHex(fieldToBytes32(registryWitness.root)) });
    const [budget, sweep] = client.ownerActionInstructions(authorization, { payer: home, tokenPairs: [{ source: wallet, destination: mint }] });
    expect(bs58.encode(budget!.programId)).toBe("ComputeBudget111111111111111111111111111111");
    expect(bs58.encode(sweep!.programId)).toBe(LOCALNET_DEPLOYMENT.pocketProgram);
    expect(sweep!.data.subarray(8)).toEqual(Uint8Array.from([1, ...authorization.proof.a, ...authorization.proof.b, ...authorization.proof.c,
      ...fieldToBytes32(registryWitness.root)]));
    expect(sweep!.keys.slice(-2).map(k => k.pubkey)).toEqual([wallet, mint]);
  });

  it("submits through the relayer with a deterministic request ID, and keeps policy changes off the relayer", async () => {
    const fetchFn = relayer();
    const { client } = await ownerClient({ nonce: 0n }, { fetchFn });
    const revoke = await client.proveOwnerAction({ identity, witness: { registry: registryWitness }, action: "revoke" });
    expect(await client.submitOwnerAction(revoke)).toMatchObject({ state: "confirmed" });
    const body = JSON.parse(String(fetchFn.mock.calls[0]![1]!.body));
    const { requestIdHex, ...request } = body;
    expect(request).toEqual(ownerActionRequest(revoke));
    expect(requestIdHex).toBe(relayerRequestDigest("/owner-action", request));
    const policyChange = { ...revoke, action: "propose" as const, change: { policy: fixturePolicy() }, changeBorsh: pocketChangeBorsh({ policy: fixturePolicy() }) };
    await expect(client.submitOwnerAction(policyChange)).rejects.toThrow(/only home changes/);
    expect(client.ownerActionInstructions(policyChange, { payer: home })[1]!.data.subarray(8, 8 + policyChange.changeBorsh.length))
      .toEqual(policyChange.changeBorsh);
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("binds the exact change for propose and the chain's pending change for cancel", async () => {
    const newHome = hexToBytes(actions.newHome);
    const proposing = await ownerClient({ nonce: 1n });
    const propose = await proposing.client.proveOwnerAction({ identity, witness: { registry: registryWitness }, action: "propose", change: { home: newHome } });
    expect(proposing.inputs[0]!.action_hash).toBe(proved("proposeHome").publicSignals[3]);
    expect(ownerActionRequest(propose).changeHex).toBe(bytesToHex(pocketChangeBorsh({ home: newHome })));
    const cancelling = await ownerClient({ nonce: 2n, pending: { home: newHome } });
    const cancel = await cancelling.client.proveOwnerAction({ identity, witness: { registry: registryWitness }, action: "cancel" });
    expect(cancelling.inputs[0]!.action_hash).toBe(proved("cancel").publicSignals[3]);
    expect(cancel.change).toEqual({ home: newHome });
    await expect(cancelling.client.proveOwnerAction({ identity, witness: { registry: registryWitness }, action: "propose", change: { home } }))
      .rejects.toThrow(/already pending/);
    await expect(proposing.client.proveOwnerAction({ identity, witness: { registry: registryWitness }, action: "cancel" })).rejects.toThrow(/no change is pending/);
  });

  it("refuses stale or substituted owner proofs and missing pockets", async () => {
    const moved = await ownerClient({ nonce: 0n }, { afterProof: () => {
      moved.accounts.set(vectors.pdas.pocket.address, pocketOwned(pocketAccount({ nonce: 1n })));
    } });
    await expect(moved.client.proveOwnerAction({ identity, witness: { registry: registryWitness }, action: "sweep" })).rejects.toThrow(/nonce moved/);
    const { client, accounts } = await ownerClient({ nonce: 0n, appIdBytes: new Uint8Array(32).fill(1) });
    await expect(client.proveOwnerAction({ identity, witness: { registry: registryWitness }, action: "sweep" })).rejects.toThrow(/does not belong/);
    accounts.clear();
    await expect(client.proveOwnerAction({ identity, witness: { registry: registryWitness }, action: "sweep" })).rejects.toThrow(/no pocket/);
    await expect(client.proveOwnerAction({ identity: { ...identity, commitment: 1n }, witness: { registry: registryWitness }, action: "sweep" }))
      .rejects.toThrow(/registry witness/);
    const substituting = await ownerClient({ nonce: 1n });
    // The nonce-1 sweep fixture exists, so the prover answers with the nonce-0 one: a different action.
    (substituting.client.config.prover!.prove as ReturnType<typeof vi.fn>).mockResolvedValueOnce(structuredClone(proved("sweep")));
    await expect(substituting.client.proveOwnerAction({ identity, witness: { registry: registryWitness }, action: "sweep" }))
      .rejects.toThrow(/different owner action/);
  });

  it("reads the revocation epoch and refuses a renewal the program would reject", async () => {
    const policy = fixturePolicy();
    const params = {
      identity, session: sessionPublicKey(0, softwareSession(hexToBytes(vectors.identity.sessionSeed)).key32),
      claim: { mint, threshold: BigInt(login.public.threshold), maxAgeSlots: 9000n }, minSlot: BigInt(login.public.min_slot),
      expirySlot: BigInt(vectors.identity.expirySlot), home, policy,
      witness: { registry: { walletPubkey: wallet, index: Number(login.private.reg_index), siblings: login.private.reg_siblings.map(BigInt), root: BigInt(login.public.registry_root) },
        census: { index: Number(login.private.cen_index), siblings: login.private.cen_siblings.map(BigInt), root: BigInt(login.public.census_root),
          amount: BigInt(vectors.census.amount), slot: BigInt(vectors.census.slot) } },
    };
    const contexts: string[] = [];
    const prover: Prover = { prove: async (_c, input) => { contexts.push(String(input.authorization_context)); return structuredClone(loginFixture); } };
    const accounts = new Map([[vectors.pdas.pocket.address, pocketOwned(pocketAccount({ epoch: 2n, policy }))]]);
    const client = await GhostLink.init({ cluster: "localnet", indexer: "https://indexer.test", origin, prover, chain: chainOf(accounts) });
    expect((await client.authorizeSession(params)).authorizationEpoch).toBe(2n);
    expect(contexts[0]).toBe(pocketAuthorizationContext(policy, 0, sessionDeployment(LOCALNET_DEPLOYMENT), 2n).toString());
    await expect(client.authorizeSession({ ...params, home: wallet })).rejects.toThrow(/recovery home differs/);
    await expect(client.authorizeSession({ ...params, policy: conservativePolicy() })).rejects.toThrow(/confirmed policy differs/);
    accounts.set(vectors.pdas.pocket.address, pocketOwned(pocketAccount({ policy, maxExpiry: params.expirySlot })));
    await expect(client.authorizeSession(params)).rejects.toThrow(/later than every earlier session/);
    accounts.clear();
    expect((await client.authorizeSession(params)).authorizationEpoch).toBe(0n);
  });
});

describe("one holdings claim shape", () => {
  it("converts between the canonical claim, the legacy SDK claim and the verifier's mint fields", () => {
    expect(claimMintFields(mint)).toEqual({ mintHi: login.public.mint_hi, mintLo: login.public.mint_lo });
    expect(claimMintFields(bs58.encode(mint))).toEqual(claimMintFields(mint));
    expect(holdingsClaim(bs58.encode(mint), 5n)).toEqual({ mint, threshold: 5n });
    expect(() => holdingsClaim(mint, -1n)).toThrow(/u64/);
    expect(normalizeClaim({ kind: "holdsAtLeast", mint, amount: 9n, maxAgeSlots: 1n })).toEqual({ kind: "holdsAtLeast", mint, threshold: 9n, maxAgeSlots: 1n });
    expect(provenClaim(loginFixture.publicSignals)).toEqual({ mint, threshold: BigInt(login.public.threshold), minSlot: BigInt(login.public.min_slot) });
    const noClaim = [...loginFixture.publicSignals]; noClaim[10] = "0";
    expect(provenClaim(noClaim)).toBeNull();
    expect(registryLeaf(wallet, identity.commitment).toString()).toBe(vectors.identity.registryLeaf);
  });
});
