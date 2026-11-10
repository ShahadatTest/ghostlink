/**
 * Instructions for apps that build and send their own transactions.
 *
 * Plain data, no web3.js: convert with your client, for example
 * `new TransactionInstruction({ programId: new PublicKey(ix.programId),
 * keys: ix.keys.map(k => ({ ...k, pubkey: new PublicKey(k.pubkey) })),
 * data: Buffer.from(ix.data) })`. Account orders and Borsh layouts mirror
 * programs/* and the services' builders (services/shared), which the
 * program integration tests prove on chain.
 */
import { sha256 } from "@noble/hashes/sha256";
import {
  ED25519_PROGRAM_ID, SPL_TOKEN_PROGRAM_ID, SYSVAR_INSTRUCTIONS_ID, bindingPda, censusConfigPda, censusFeeVaultPda,
  censusTreePda, findProgramAddress, pk, policyBytes, registryTreePda,
  type DeploymentManifest, type Policy, type ProofBytes,
} from "@ghostlink/common";
import type { PocketChange } from "./chain.js";

export interface InstructionAccount {
  pubkey: Uint8Array;
  isSigner: boolean;
  isWritable: boolean;
}

/** One Solana instruction as plain bytes. */
export interface GhostLinkInstruction {
  programId: Uint8Array;
  keys: InstructionAccount[];
  data: Uint8Array;
}

export type ProgramDeployment = Pick<DeploymentManifest, "registryProgram" | "censusProgram" | "pocketProgram">;

const SYSTEM_PROGRAM = new Uint8Array(32);
const COMPUTE_BUDGET_PROGRAM = pk("ComputeBudget111111111111111111111111111111");
const ATA_PROGRAM = pk("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const TOKEN_PROGRAM = pk(SPL_TOKEN_PROGRAM_ID);
const SYSVAR_INSTRUCTIONS = pk(SYSVAR_INSTRUCTIONS_ID);

/** The classic SPL associated token account of (owner, mint). */
export function associatedTokenAddress(owner: Uint8Array, mint: Uint8Array): Uint8Array {
  if (owner.length !== 32 || mint.length !== 32) throw new Error("owner and mint must be 32 bytes");
  return findProgramAddress([owner, TOKEN_PROGRAM, mint], ATA_PROGRAM).address;
}

class Writer {
  #parts: number[] = [];
  u8(v: number): this {
    if (!Number.isInteger(v) || v < 0 || v > 0xff) throw new RangeError("u8 out of range");
    this.#parts.push(v); return this;
  }
  int(v: bigint | number, bytes: number): this {
    let x = BigInt(v);
    if (x < 0n || x >= 1n << BigInt(8 * bytes)) throw new RangeError(`u${8 * bytes} out of range`);
    for (let i = 0; i < bytes; i++) { this.#parts.push(Number(x & 0xffn)); x >>= 8n; }
    return this;
  }
  fixed(bytes: Uint8Array, length: number): this {
    if (!(bytes instanceof Uint8Array) || bytes.length !== length) throw new Error(`expected ${length} bytes`);
    this.#parts.push(...bytes); return this;
  }
  vec<T>(items: readonly T[], write: (item: T) => void): this {
    this.int(items.length, 4); items.forEach(write); return this;
  }
  out(): Uint8Array { return Uint8Array.from(this.#parts); }
}

function anchorData(name: string, body: Uint8Array = new Uint8Array()): Uint8Array {
  const out = new Uint8Array(8 + body.length);
  out.set(sha256(new TextEncoder().encode(`global:${name}`)).subarray(0, 8));
  out.set(body, 8);
  return out;
}

const account = (pubkey: Uint8Array, isSigner: boolean, isWritable: boolean): InstructionAccount =>
  ({ pubkey: pubkey.slice(), isSigner, isWritable });

function writePolicy(w: Writer, p: Policy): void {
  policyBytes(p); // the canonical validation the program and relayer apply
  w.int(p.dailyCapUsdE6, 8).int(p.maxSlippageBps, 2).int(p.bigActionThresholdUsdE6, 8).int(p.noOracleCapUsdE6, 8)
    .int(p.sessionMaxSlots, 8)
    .vec(p.allowedOutMints, (m) => w.fixed(m, 32))
    .vec(p.oracleFeeds, (f) => w.fixed(f.mint, 32).fixed(f.feedId, 32).u8(f.decimals));
  if (!p.speculative) { w.u8(0); return; }
  const s = p.speculative;
  w.u8(1).int(s.dailyBuyCapUsdE6, 8).int(s.maxCostExposureUsdE6, 8).u8(s.maxPositions).vec(s.baseMints, (m) => w.fixed(m, 32));
}

/** The Borsh encoding of a pocket `Change` (0 = Home, 1 = Policy), which change and cancel digests hash. */
export function pocketChangeBorsh(change: PocketChange): Uint8Array {
  const w = new Writer();
  if ("home" in change) w.u8(0).fixed(change.home, 32);
  else { w.u8(1); writePolicy(w, change.policy); }
  return w.out();
}

export function computeBudgetInstruction(units: number): GhostLinkInstruction {
  return { programId: COMPUTE_BUDGET_PROGRAM.slice(), keys: [], data: new Writer().u8(2).int(units, 4).out() };
}

/** Ed25519 precompile: one signature, every offset inside this instruction (the only shape the registry accepts). */
export function ed25519VerifyInstruction(publicKey: Uint8Array, signature: Uint8Array, message: Uint8Array): GhostLinkInstruction {
  if (publicKey.length !== 32 || signature.length !== 64) throw new Error("expected a 32-byte key and a 64-byte signature");
  const header = 16, sigOff = header + 32, msgOff = sigOff + 64;
  const w = new Writer().u8(1).u8(0);
  for (const v of [sigOff, 0xffff, header, 0xffff, msgOff, message.length, 0xffff]) w.int(v, 2);
  const data = new Uint8Array(msgOff + message.length);
  data.set(w.out());
  data.set(publicKey, header);
  data.set(signature, sigOff);
  data.set(message, msgOff);
  return { programId: pk(ED25519_PROGRAM_ID), keys: [], data };
}

export function registerInstruction(d: ProgramDeployment, payer: Uint8Array, wallet: Uint8Array, commitment32: Uint8Array): GhostLinkInstruction {
  const registry = pk(d.registryProgram);
  return {
    programId: registry,
    keys: [account(payer, true, true), account(wallet, false, false), account(bindingPda(wallet, registry).address, false, true),
      account(registryTreePda(registry).address, false, true), account(SYSVAR_INSTRUCTIONS, false, false),
      account(SYSTEM_PROGRAM, false, false)],
    data: anchorData("register", new Writer().fixed(commitment32, 32).out()),
  };
}

export function snapshotInstruction(d: ProgramDeployment, payer: Uint8Array, wallet: Uint8Array, holding: Uint8Array,
  maxFeeLamports: bigint): GhostLinkInstruction {
  const census = pk(d.censusProgram);
  return {
    programId: census,
    keys: [account(payer, true, true), account(wallet, false, false), account(holding, false, false),
      account(censusTreePda(census).address, false, true), account(censusConfigPda(census).address, false, false),
      account(censusFeeVaultPda(census).address, false, true), account(SYSVAR_INSTRUCTIONS, false, false),
      account(SYSTEM_PROGRAM, false, false)],
    data: anchorData("snapshot", new Writer().int(maxFeeLamports, 8).out()),
  };
}

export interface OwnerProofArgs {
  proof: ProofBytes;
  registryRoot: Uint8Array;
}

function writeOwnerProof(w: Writer, p: OwnerProofArgs): Writer {
  return w.fixed(p.proof.a, 64).fixed(p.proof.b, 128).fixed(p.proof.c, 64).fixed(p.registryRoot, 32);
}

function ownerKeys(d: ProgramDeployment, payer: Uint8Array, pocket: Uint8Array): InstructionAccount[] {
  return [account(payer, true, true), account(pocket, false, true), account(registryTreePda(pk(d.registryProgram)).address, false, false)];
}

/** sweep_home with an owner proof; token pairs are (pocket-owned source, home-owned destination). */
export function sweepHomeInstruction(d: ProgramDeployment, payer: Uint8Array, pocket: Uint8Array, home: Uint8Array,
  proof: OwnerProofArgs, tokenPairs: readonly { source: Uint8Array; destination: Uint8Array }[]): GhostLinkInstruction {
  return {
    programId: pk(d.pocketProgram),
    keys: [account(payer, true, true), account(pocket, false, true), account(home, false, true),
      account(registryTreePda(pk(d.registryProgram)).address, false, false), account(TOKEN_PROGRAM, false, false),
      account(SYSVAR_INSTRUCTIONS, false, false),
      ...tokenPairs.flatMap((p) => [account(p.source, false, true), account(p.destination, false, true)])],
    data: anchorData("sweep_home", writeOwnerProof(new Writer().u8(1), proof).out()),
  };
}

export function revokeSessionInstruction(d: ProgramDeployment, payer: Uint8Array, pocket: Uint8Array, proof: OwnerProofArgs): GhostLinkInstruction {
  return {
    programId: pk(d.pocketProgram),
    keys: [account(payer, true, true), account(pocket, false, true),
      account(registryTreePda(pk(d.registryProgram)).address, false, false), account(SYSVAR_INSTRUCTIONS, false, false)],
    data: anchorData("revoke_session", writeOwnerProof(new Writer().u8(1), proof).out()),
  };
}

export function proposeChangeInstruction(d: ProgramDeployment, payer: Uint8Array, pocket: Uint8Array, changeBorsh: Uint8Array,
  proof: OwnerProofArgs): GhostLinkInstruction {
  const body = writeOwnerProof(new Writer(), proof).out();
  const data = new Uint8Array(changeBorsh.length + body.length);
  data.set(changeBorsh); data.set(body, changeBorsh.length);
  return { programId: pk(d.pocketProgram), keys: ownerKeys(d, payer, pocket), data: anchorData("propose_change", data) };
}

export function cancelChangeInstruction(d: ProgramDeployment, payer: Uint8Array, pocket: Uint8Array, proof: OwnerProofArgs): GhostLinkInstruction {
  return { programId: pk(d.pocketProgram), keys: ownerKeys(d, payer, pocket),
    data: anchorData("cancel_change", writeOwnerProof(new Writer(), proof).out()) };
}

/** Permissionless: applies a staged change once its timelock has passed. */
export function executeChangeInstruction(d: ProgramDeployment, payer: Uint8Array, pocket: Uint8Array): GhostLinkInstruction {
  return { programId: pk(d.pocketProgram), keys: [account(payer, true, false), account(pocket, false, true)],
    data: anchorData("execute_change") };
}
