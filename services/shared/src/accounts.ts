import { sha256 } from "@noble/hashes/sha256";
import { PublicKey, type AccountInfo } from "@solana/web3.js";
import type { Policy } from "@ghostlink/common";
import { BorshWriter } from "./borsh.js";
import { CENSUS, POCKET, writePolicy } from "./instructions.js";

const POCKET_DISC = sha256(new TextEncoder().encode("account:PocketV3")).subarray(0, 8);
const CENSUS_CONFIG_DISC = sha256(new TextEncoder().encode("account:Config")).subarray(0, 8);
/** Discriminator, fee_lamports u64, bump u8. */
export const CENSUS_CONFIG_SIZE = 17;

/** The current census snapshot fee, in lamports, from the census config account. */
export function readCensusFee(info: AccountInfo<Uint8Array> | null, expectedProgram = CENSUS): bigint {
  if (!info || info.executable || !info.owner.equals(expectedProgram) || info.data.length !== CENSUS_CONFIG_SIZE ||
    !CENSUS_CONFIG_DISC.every((b, i) => info.data[i] === b)) {
    throw new Error("not the census config account");
  }
  let fee = 0n;
  for (let i = 15; i >= 8; i--) fee = fee * 256n + BigInt(info.data[i]!);
  return fee;
}
/** Discriminator plus current Pocket::INIT_SPACE, including the speculative ledger and spending windows. */
export const POCKET_ACCOUNT_SIZE = 3693;
/** Fixed entries in the speculative ledger (programs/pocket/src/speculative.rs MAX_POSITIONS). */
const POCKET_POSITIONS = 8;
/** programs/pocket/src/window.rs: hourly buckets, the current hour plus the 24 before it. */
export const ROLLING_WINDOW_BUCKETS = 25;
export const ROLLING_WINDOW_BUCKET_SLOTS = 9_000n;

/** A rolling daily spending window: bucket `b`'s total sits at `amounts[b % 25]`. */
export interface RollingWindowState {
  latestBucket: bigint;
  amounts: bigint[];
}

/** Everything a window counts at `nowSlot`, exactly as RollingWindow::total computes it. */
export function rollingWindowTotal(window: RollingWindowState, nowSlot: bigint): bigint {
  const buckets = BigInt(ROLLING_WINDOW_BUCKETS);
  if (window.amounts.length !== ROLLING_WINDOW_BUCKETS) throw new Error("invalid rolling window");
  const amounts = [...window.amounts];
  const bucket = nowSlot / ROLLING_WINDOW_BUCKET_SLOTS;
  if (bucket > window.latestBucket) {
    if (bucket - window.latestBucket >= buckets) amounts.fill(0n);
    else for (let b = window.latestBucket + 1n; b <= bucket; b++) amounts[Number(b % buckets)] = 0n;
  }
  return amounts.reduce((sum, amount) => sum + amount, 0n);
}

export interface SpeculativePosition {
  mint: PublicKey;
  baseMint: PublicKey;
  tokenAccount: PublicKey;
  quantity: bigint;
  costUsdE6: bigint;
}

/** Every PocketV3 field, as readPocketAccount returns it. */
export interface PocketAccountState {
  appId: Uint8Array;
  domainHash: Uint8Array;
  home: PublicKey;
  sessionKind: number;
  sessionKey: Uint8Array;
  sessionExpirySlot: bigint;
  /** Raised by every revoke; session authorizations bind it (pocketAuthorizationEpoch reads it directly). */
  authorizationEpoch: bigint;
  policy: Policy;
  pending?: { change: { home: PublicKey } | { policy: Policy }; executableAfterSlot: bigint };
  /** Priced spending (USD e6) against the daily cap. */
  spending: RollingWindowState;
  nonceBitmap: Uint8Array;
  bump: number;
  maxSessionExpirySlot: bigint;
  nonceBase: bigint;
  ownerActionNonce: bigint;
  /** Speculative acquisition spending (USD e6) against the daily buy cap. */
  speculativeBuys: RollingWindowState;
  /** Open positions only; empty ledger entries are omitted. */
  speculativePositions: SpeculativePosition[];
}

/** Same circular 2048-bit window as programs/pocket/src/state.rs. */
export function isPocketNonceUsed(account: { nonceBase: bigint; nonceBitmap: Uint8Array }, nonce: bigint): boolean {
  if (nonce < 0n || nonce > (1n << 64n) - 1n || account.nonceBitmap.length !== 256) throw new Error("invalid nonce window");
  if (nonce < account.nonceBase) return true;
  if (nonce - account.nonceBase >= 2048n) return false;
  const bit = Number(nonce % 2048n);
  return ((account.nonceBitmap[Math.floor(bit / 8)]! >> (bit % 8)) & 1) === 1;
}

/** A lamport transfer can create a system-owned PDA before its pocket is opened. */
export function isPocketAccount(info: AccountInfo<Uint8Array> | null, appId: Uint8Array, expectedProgram = POCKET): boolean {
  return Boolean(
    info && !info.executable && info.owner.equals(expectedProgram) && info.data.length >= 40 &&
    appId.length === 32 && POCKET_DISC.every((b, i) => info.data[i] === b) &&
    appId.every((b, i) => info.data[8 + i] === b),
  );
}

/** Decode the Borsh fields, whose offsets depend on policy and pending vectors. */
export function readPocketAccount(info: AccountInfo<Uint8Array>, expectedProgram = POCKET): PocketAccountState {
  if (!isPocketAccount(info, info.data.subarray(8, 40), expectedProgram)) throw new Error("not a Pocket account");
  if (info.data.length !== POCKET_ACCOUNT_SIZE) {
    throw new Error(`unsupported Pocket account size: expected ${POCKET_ACCOUNT_SIZE}, got ${info.data.length}`);
  }
  let off = 8;
  const take = (size: number) => {
    if (off + size > info.data.length) throw new Error("truncated Pocket account");
    const bytes = info.data.subarray(off, off + size);
    off += size;
    return bytes;
  };
  const integer = (size: number) => {
    const bytes = take(size);
    let value = 0n;
    for (let i = bytes.length - 1; i >= 0; i--) value = value * 256n + BigInt(bytes[i]!);
    return value;
  };
  const u8 = () => Number(integer(1));
  const u64 = () => integer(8);
  const key = () => new PublicKey(take(32));
  const rollingWindow = (): RollingWindowState => ({ latestBucket: u64(),
    amounts: Array.from({ length: ROLLING_WINDOW_BUCKETS }, u64) });
  const vector = <T>(read: () => T): T[] => {
    const size = Number(integer(4));
    if (size > 8) throw new Error("invalid Pocket policy vector");
    return Array.from({ length: size }, read);
  };
  const readPolicy = (): Policy => {
    const policy: Policy = {
    dailyCapUsdE6: u64(), maxSlippageBps: Number(integer(2)),
    bigActionThresholdUsdE6: u64(), noOracleCapUsdE6: u64(), sessionMaxSlots: u64(),
    allowedOutMints: vector(() => take(32)),
    oracleFeeds: vector(() => ({ mint: take(32), feedId: take(32), decimals: u8() })),
    };
    const enabled = u8();
    if (enabled === 1) {
      policy.speculative = { dailyBuyCapUsdE6: u64(), maxCostExposureUsdE6: u64(),
        maxPositions: u8(), baseMints: vector(() => take(32)) };
    } else if (enabled !== 0) throw new Error("invalid speculative policy flag");
    return policy;
  };
  const appId = take(32);
  const domainHash = take(32);
  const home = key();
  const sessionKind = u8();
  const sessionKey = take(33);
  const sessionExpirySlot = u64();
  const authorizationEpoch = u64();
  const policy = readPolicy();
  const hasPending = u8();
  let pending: { change: { home: PublicKey } | { policy: Policy }; executableAfterSlot: bigint } | undefined;
  if (hasPending === 1) {
    const tag = u8();
    if (tag !== 0 && tag !== 1) throw new Error("invalid Pocket change variant");
    pending = { change: tag === 0 ? { home: key() } : { policy: readPolicy() }, executableAfterSlot: u64() };
  } else if (hasPending !== 0) throw new Error("invalid Pocket pending flag");
  const spending = rollingWindow();
  const nonceBitmap = take(256);
  const bump = u8();
  const maxSessionExpirySlot = u64();
  const nonceBase = u64();
  const ownerActionNonce = u64();
  const speculativeBuys = rollingWindow();
  const speculativePositions = Array.from({ length: POCKET_POSITIONS }, () => ({ mint: key(), baseMint: key(),
    tokenAccount: key(), quantity: u64(), costUsdE6: u64() })).filter(p => p.quantity > 0n);
  return { speculativeBuys, speculativePositions, appId, domainHash, home, sessionKind, sessionKey, sessionExpirySlot, authorizationEpoch,
    policy, pending, spending, nonceBitmap, bump, maxSessionExpirySlot, nonceBase, ownerActionNonce };
}

/**
 * The inverse of readPocketAccount, for fixtures and simulations: the full
 * PocketV3 allocation with every omitted field zero. It encodes; it never
 * creates or authorizes an on-chain account.
 */
export function encodePocketAccount(
  state: Pick<PocketAccountState, "appId" | "home" | "policy"> & Partial<PocketAccountState>,
): Buffer {
  const zero = (length: number) => new Uint8Array(length);
  const writeWindow = (window: RollingWindowState | undefined) => {
    if (window && window.amounts.length !== ROLLING_WINDOW_BUCKETS) throw new Error("invalid rolling window");
    w.u64(window?.latestBucket ?? 0n);
    for (let i = 0; i < ROLLING_WINDOW_BUCKETS; i++) w.u64(window?.amounts[i] ?? 0n);
  };
  const positions = state.speculativePositions ?? [];
  if (positions.length > POCKET_POSITIONS) throw new Error("too many speculative positions");
  const w = new BorshWriter().fixed(POCKET_DISC, 8).fixed(state.appId, 32).fixed(state.domainHash ?? zero(32), 32)
    .fixed(state.home.toBytes(), 32).u8(state.sessionKind ?? 0).fixed(state.sessionKey ?? zero(33), 33)
    .u64(state.sessionExpirySlot ?? 0n).u64(state.authorizationEpoch ?? 0n);
  writePolicy(w, state.policy);
  w.option(state.pending, (writer, pending) => {
    if ("home" in pending.change) writer.u8(0).fixed(pending.change.home.toBytes(), 32);
    else { writer.u8(1); writePolicy(writer, pending.change.policy); }
    writer.u64(pending.executableAfterSlot);
  });
  writeWindow(state.spending);
  w.fixed(state.nonceBitmap ?? zero(256), 256).u8(state.bump ?? 0).u64(state.maxSessionExpirySlot ?? 0n)
    .u64(state.nonceBase ?? 0n).u64(state.ownerActionNonce ?? 0n);
  writeWindow(state.speculativeBuys);
  for (let i = 0; i < POCKET_POSITIONS; i++) {
    const p = positions[i];
    if (p) w.fixed(p.mint.toBytes(), 32).fixed(p.baseMint.toBytes(), 32).fixed(p.tokenAccount.toBytes(), 32).u64(p.quantity).u64(p.costUsdE6);
    else w.fixed(zero(112), 112);
  }
  const bytes = w.out();
  if (bytes.length > POCKET_ACCOUNT_SIZE) throw new Error("Pocket fields exceed the account allocation");
  const data = Buffer.alloc(POCKET_ACCOUNT_SIZE);
  data.set(bytes);
  return data;
}
