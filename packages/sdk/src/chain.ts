/**
 * Chain reads, without an RPC client in the bundle.
 *
 * The SDK reads three things from the chain: the genesis hash (to check it
 * is the deployment's chain), the current slot, and single accounts (a
 * pocket's owner action nonce, revocation epoch, home and pending change;
 * the census fee). It never sends a transaction. Pass any object with the
 * three methods of `ChainReader`: a short adapter over your existing RPC
 * client, or `jsonRpcChainReader(url)`, which speaks Solana JSON-RPC over
 * `fetch` and adds no dependency.
 *
 * Treat the reader as trusted: owner proofs bind the nonce it reports. A
 * wrong nonce makes the program reject the proof, so a lying RPC can waste
 * an action, never redirect one.
 */
import { sha256 } from "@noble/hashes/sha256";
import bs58 from "bs58";
import type { Policy } from "@ghostlink/common";
import { unboundFetch } from "./transport.js";

/** A confirmed account as the SDK needs it. */
export interface ChainAccount {
  /** The owning program, 32 bytes. */
  owner: Uint8Array;
  data: Uint8Array;
  lamports: bigint;
}

/**
 * The SDK's only view of the chain. Every read must be at `confirmed`
 * commitment or stronger, and at or after `minContextSlot` when given.
 */
export interface ChainReader {
  getGenesisHash(): Promise<string>;
  /** The current confirmed slot. */
  getSlot(): Promise<bigint | number>;
  /** The confirmed account at `address` (32 bytes), or null when it does not exist. */
  getAccount(address: Uint8Array, minContextSlot?: bigint): Promise<ChainAccount | null>;
}

export interface JsonRpcChainReaderOptions {
  /** Default "confirmed". */
  commitment?: "confirmed" | "finalized";
  /** Any fetch, including the browser's unbound `window.fetch`. */
  fetchFn?: typeof fetch;
}

/**
 * A `ChainReader` over Solana JSON-RPC (`getGenesisHash`, `getSlot`,
 * `getAccountInfo`) using only `fetch`. Works in browsers and Node.
 */
export function jsonRpcChainReader(endpoint: string, options: JsonRpcChainReaderOptions = {}): ChainReader {
  const fetchFn = unboundFetch(options.fetchFn);
  const commitment = options.commitment ?? "confirmed";
  let id = 0;
  const call = async <T>(method: string, params: unknown[]): Promise<T> => {
    const response = await fetchFn(endpoint, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    if (!response.ok) throw new Error(`RPC ${method}: HTTP ${response.status}`);
    const body = await response.json() as { result?: T; error?: { message?: unknown } };
    if (body.error) throw new Error(`RPC ${method}: ${typeof body.error.message === "string" ? body.error.message : "error"}`);
    if (!("result" in body)) throw new Error(`RPC ${method}: no result`);
    return body.result as T;
  };
  return {
    getGenesisHash: () => call<string>("getGenesisHash", []),
    getSlot: async () => BigInt(await call<number>("getSlot", [{ commitment }])),
    async getAccount(address, minContextSlot) {
      const config: Record<string, unknown> = { encoding: "base64", commitment };
      if (minContextSlot !== undefined) config.minContextSlot = Number(minContextSlot);
      const result = await call<{ value: null | { owner: string; data: [string, string]; lamports: number } }>(
        "getAccountInfo", [bs58.encode(address), config]);
      const value = result?.value;
      if (!value) return null;
      if (!Array.isArray(value.data) || value.data[1] !== "base64" || typeof value.data[0] !== "string") {
        throw new Error("RPC getAccountInfo: unexpected account encoding");
      }
      return { owner: bs58.decode(value.owner), data: base64Bytes(value.data[0]), lamports: BigInt(value.lamports) };
    },
  };
}

function base64Bytes(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** A home or policy change, staged behind the pocket's 24-hour timelock. */
export type PocketChange = { home: Uint8Array } | { policy: Policy };

/** The PocketV3 fields owner software needs. */
export interface PocketState {
  appId: Uint8Array;
  domainHash: Uint8Array;
  /** The recovery home: sweeps go only here. */
  home: Uint8Array;
  sessionKind: number;
  sessionKey: Uint8Array;
  /** Zero after a revoke. */
  sessionExpirySlot: bigint;
  /** Raised by every revoke; session authorizations bind it. */
  authorizationEpoch: bigint;
  policy: Policy;
  /** `borsh` is the change's exact on-chain encoding, which a cancel proof binds. */
  pending?: { change: PocketChange; borsh: Uint8Array; executableAfterSlot: bigint };
  /** Every new session must expire after this slot (the replay guard). */
  maxSessionExpirySlot: bigint;
  /** Consumed by every owner action and executed change; owner proofs bind it. */
  ownerActionNonce: bigint;
}

/** Discriminator plus PocketV3::INIT_SPACE (programs/pocket). Any other size is a layout this SDK does not know. */
export const POCKET_ACCOUNT_SIZE = 3693;
const POCKET_DISCRIMINATOR = sha256(new TextEncoder().encode("account:PocketV3")).subarray(0, 8);
/** Spending window (latest bucket + 25 buckets), nonce bitmap, bump. */
const BEFORE_MAX_EXPIRY = 8 + 25 * 8 + 256 + 1;

/**
 * Decodes a PocketV3 account. Check that the account is owned by the
 * deployment's pocket program first (`GhostLink.pocketState` does).
 */
export function decodePocketAccount(data: Uint8Array): PocketState {
  if (!(data instanceof Uint8Array) || data.length !== POCKET_ACCOUNT_SIZE ||
    !POCKET_DISCRIMINATOR.every((b, i) => data[i] === b)) {
    throw new Error(`not a PocketV3 account of ${POCKET_ACCOUNT_SIZE} bytes`);
  }
  let off = 8;
  const take = (size: number) => {
    if (off + size > data.length) throw new Error("truncated PocketV3 account");
    const bytes = data.slice(off, off + size);
    off += size;
    return bytes;
  };
  const int = (size: number) => {
    const bytes = take(size);
    let v = 0n;
    for (let i = size - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]!);
    return v;
  };
  const u8 = () => Number(int(1));
  const vec = <T>(read: () => T): T[] => {
    const n = Number(int(4));
    if (n > 8) throw new Error("invalid PocketV3 vector length");
    return Array.from({ length: n }, read);
  };
  const policy = (): Policy => {
    const p: Policy = {
      dailyCapUsdE6: int(8), maxSlippageBps: Number(int(2)), bigActionThresholdUsdE6: int(8), noOracleCapUsdE6: int(8),
      sessionMaxSlots: int(8), allowedOutMints: vec(() => take(32)),
      oracleFeeds: vec(() => ({ mint: take(32), feedId: take(32), decimals: u8() })),
    };
    const flag = u8();
    if (flag === 1) {
      p.speculative = { dailyBuyCapUsdE6: int(8), maxCostExposureUsdE6: int(8), maxPositions: u8(), baseMints: vec(() => take(32)) };
    } else if (flag !== 0) throw new Error("invalid PocketV3 speculative flag");
    return p;
  };
  const appId = take(32), domainHash = take(32), home = take(32);
  const sessionKind = u8(), sessionKey = take(33), sessionExpirySlot = int(8), authorizationEpoch = int(8);
  const current = policy();
  let pending: PocketState["pending"];
  const hasPending = u8();
  if (hasPending === 1) {
    const start = off;
    const tag = u8();
    if (tag !== 0 && tag !== 1) throw new Error("invalid PocketV3 change variant");
    const change: PocketChange = tag === 0 ? { home: take(32) } : { policy: policy() };
    const borsh = data.slice(start, off);
    pending = { change, borsh, executableAfterSlot: int(8) };
  } else if (hasPending !== 0) throw new Error("invalid PocketV3 pending flag");
  take(BEFORE_MAX_EXPIRY);
  const maxSessionExpirySlot = int(8);
  int(8); // nonce base
  const ownerActionNonce = int(8);
  return { appId, domainHash, home, sessionKind, sessionKey, sessionExpirySlot, authorizationEpoch, policy: current, pending,
    maxSessionExpirySlot, ownerActionNonce };
}
