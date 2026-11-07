/** Protocol constants. Changing any of these is a breaking protocol change. */

/** Merkle tree depth for both the registry and census trees (2^26 ≈ 67M leaves). */
export const TREE_DEPTH = 26;

/** How many historical roots each tree keeps, so slightly stale proofs still verify. */
export const ROOT_HISTORY_SIZE = 128;

/**
 * Width of a root-history bucket in slots (about a minute). Each tree keeps
 * one root per bucket, its last, so the ring spans at least
 * ROOT_HISTORY_SIZE buckets however busy the tree is. Prove against the root
 * of a bucket that has ended: the newest entry can still be overwritten.
 */
export const ROOT_BUCKET_SLOTS = 150;

/** The root-history bucket a slot falls in. */
export function rootBucket(slot: number | bigint): number {
  const value = typeof slot === "bigint" ? slot : BigInt(slot);
  if (value < 0n || (typeof slot === "number" && !Number.isSafeInteger(slot))) throw new Error("slot out of range");
  return Number(value / BigInt(ROOT_BUCKET_SLOTS));
}

/** Default census snapshot fee of a fresh deployment, in lamports. */
export const DEFAULT_SNAPSHOT_FEE_LAMPORTS = 100_000n;

/**
 * The statement inside the Sign-In-With-Solana message the wallet signs
 * (twice) to derive the identity secret. The message's first line names
 * GhostLink's own domain; SIWS-capable wallets show it and warn when a
 * different page asks for the signature.
 */
export const IDENTITY_STATEMENT =
  "This signature derives your private GhostLink identity. Only the GhostLink sign-in " +
  "asks for it, during setup. Never sign it to verify, claim or recover anything on another site.";

/**
 * Intent nonces use a sliding window this wide per pocket: any value in
 * [nonce_base, nonce_base + NONCE_WINDOW) once, in any order; a larger
 * value slides the window forward and retires everything it leaves behind.
 */
export const NONCE_WINDOW = 2048n;

/** ASCII prefix of the registration message the wallet signs once. */
export const REGISTER_TAG = "ghostlink:register:v1";

/** ASCII prefix of canonical intent bytes. */
export const INTENT_TAG = "ghostlink:intent:v1";

/** Domain separators for Poseidon shapes: never reuse a shape for two meanings. */
export const SEP_APP_ID = 1n;
export const SEP_OWNER_TAG = 2n;

/** Program IDs (devnet/localnet deploy keys; mainnet IDs are chosen at M4). */
export const REGISTRY_PROGRAM_ID = "54EZ5ZkUANBs1SfQoXaU5EQSR8VAaD3XDtKEZGp6KjRv";
export const CENSUS_PROGRAM_ID = "CvRA16GAa5ynUE3bzgMWuPYTbHLsdvyBydJoZVft5x9d";
export const POCKET_PROGRAM_ID = "HbSux9YnTupzNiRUwdR2mjTpJJryx25RV42wry4kCwiH";

/** Well-known Solana program IDs. */
export const ED25519_PROGRAM_ID = "Ed25519SigVerify111111111111111111111111111";
export const SECP256R1_PROGRAM_ID = "Secp256r1SigVerify1111111111111111111111111";
export const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const SYSVAR_INSTRUCTIONS_ID = "Sysvar1nstructions1111111111111111111111111";

/** Pyth receiver: owns every PriceUpdateV2 account the pocket accepts. */
export const PYTH_RECEIVER_PROGRAM_ID = "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ";
/** Pyth push oracle: its shard-0 PDA per feed id is the sponsored price account. */
export const PYTH_PUSH_ORACLE_PROGRAM_ID = "pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT";
/** The shard Pyth's sponsored pusher keeps current; the pocket accepts no other. */
export const PYTH_SPONSORED_SHARD = 0;

export type Cluster = "localnet" | "devnet" | "mainnet-beta";
