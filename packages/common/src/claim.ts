/**
 * The holdings claim: "holds at least `threshold` base units of `mint`".
 *
 * One shape for every package. The SDK proves it, `openSession` checks it
 * against a proof, and `@ghostlink/verify` expects it. Inside the circuit
 * the mint is two field elements (`mint_hi`, `mint_lo`); `claimMintFields`
 * converts between the two forms so nobody has to split bytes by hand.
 */
import bs58 from "bs58";
import { FIELD_PRIME, joinBytes32, splitBytes32 } from "./field.js";

export interface HoldingsClaim {
  /** The SPL mint, 32 bytes. */
  mint: Uint8Array;
  /** Minimum balance in the mint's base units (raw integer, not UI amount). */
  threshold: bigint;
}

/** The older decimal-string form of a claim, as `verifyLogin` accepted it before `HoldingsClaim`. */
export interface HoldingsClaimFields {
  mintHi: string;
  mintLo: string;
  threshold: bigint;
}

const U64_MAX = (1n << 64n) - 1n;

/** A mint as 32 bytes, from bytes or a base58 address. Throws on anything else. */
export function mintBytes(mint: Uint8Array | string): Uint8Array {
  const bytes = typeof mint === "string" ? bs58.decode(mint) : mint;
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) throw new Error("mint must be 32 bytes or a base58 address");
  return bytes.slice();
}

/** The login circuit's `mint_hi` and `mint_lo` public signals for a mint, as canonical decimal strings. */
export function claimMintFields(mint: Uint8Array | string): { mintHi: string; mintLo: string } {
  const { hi, lo } = splitBytes32(mintBytes(mint));
  return { mintHi: hi.toString(), mintLo: lo.toString() };
}

/** A checked `HoldingsClaim` from a mint (bytes or base58) and a u64 threshold. */
export function holdingsClaim(mint: Uint8Array | string, threshold: bigint): HoldingsClaim {
  if (typeof threshold !== "bigint" || threshold < 0n || threshold > U64_MAX) throw new Error("claim threshold must be a u64 bigint");
  return { mint: mintBytes(mint), threshold };
}

/** Converts the older `{ mintHi, mintLo, threshold }` form back to a `HoldingsClaim`. */
export function holdingsClaimFromFields(fields: HoldingsClaimFields): HoldingsClaim {
  const half = (value: unknown) => {
    if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,38})$/.test(value)) throw new Error("mintHi and mintLo must be decimal strings");
    const v = BigInt(value);
    if (v >= 1n << 128n || v >= FIELD_PRIME) throw new Error("mintHi and mintLo must each fit in 16 bytes");
    return v;
  };
  return holdingsClaim(joinBytes32(half(fields.mintHi), half(fields.mintLo)), fields.threshold);
}
