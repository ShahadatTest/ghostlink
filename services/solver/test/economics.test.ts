/** The solver must never deliver more than the input is worth. */
import { describe, expect, it } from "vitest";
import { PublicKey, type Connection } from "@solana/web3.js";
import { PYTH_RECEIVER_PROGRAM_ID, SPL_TOKEN_PROGRAM_ID, pythPushFeedAddress } from "@ghostlink/common";
import { PriceReader, checkEconomics, parsePriceUpdate, usdE6 } from "../src/economics.js";

// USDC at $1.00 and SOL at $156.25, both exponent -8 (the fixture feeds).
const usdc = { price: 100_000_000n, exponent: -8, decimals: 6 };
const sol = { price: 15_625_000_000n, exponent: -8, decimals: 9 };

describe("economics", () => {
  it("values amounts exactly like the pocket's usd_e6", () => {
    expect(usdE6(25_000_000n, usdc)).toBe(25_000_000n);
    expect(usdE6(160_000_000n, sol)).toBe(25_000_000n);
  });

  it("accepts a fair fill and refuses an overpaying one", () => {
    expect(checkEconomics({ inMax: 25_000_000n, outMin: 160_000_000n }, { in: usdc, out: sol }, 100).ok).toBe(true);
    // 1% spread allows up to 161.6M lamports for $25.
    expect(checkEconomics({ inMax: 25_000_000n, outMin: 161_600_000n }, { in: usdc, out: sol }, 100).ok).toBe(true);
    const greedy = checkEconomics({ inMax: 25_000_000n, outMin: 161_700_000n }, { in: usdc, out: sol }, 100);
    expect(greedy.ok).toBe(false);
    expect(greedy.reason).toContain("more than the input is worth");
  });

  it("refuses the inventory-drain shape: spend nothing, receive the solver's balance", () => {
    const drain = checkEconomics({ inMax: 0n, outMin: 1_000_000_000_000n }, { in: usdc, out: sol }, 100);
    expect(drain.ok).toBe(false);
    expect(drain.reason).toContain("spends nothing");
  });

  it("does not round a sub-micro-dollar overpayment into a free fill", () => {
    const tiny = { price: 1n, exponent: -8, decimals: 9 };
    expect(checkEconomics({ inMax: 1n, outMin: 1000n }, { in: tiny, out: tiny }, 100).ok).toBe(false);
    expect(checkEconomics({ inMax: 1000n, outMin: 1010n }, { in: tiny, out: tiny }, 100).ok).toBe(true);
    expect(() => usdE6(1n, { ...tiny, exponent: 2_147_483_647 })).toThrow(/arithmetic/);
  });

  it("refuses unpriced output mints unless the deployment opts in", () => {
    const nft = { inMax: 10_000_000n, outMin: 1n };
    expect(checkEconomics(nft, { in: usdc }, 100).ok).toBe(false);
    expect(checkEconomics(nft, { in: usdc }, 100, true).ok).toBe(true);
  });

  it("never treats unpriced exit cost basis as market value or allows two unpriced legs", () => {
    const exit = { inMax: 100n, outMin: 1n };
    expect(checkEconomics(exit, { out: usdc }, 100).ok).toBe(false);
    expect(checkEconomics(exit, { out: usdc }, 100, true)).toEqual({ ok: true, outUsdE6: 1n });
    expect(checkEconomics(exit, {}, 100, true).ok).toBe(false);
    expect(checkEconomics({ ...exit, outMin: 0n }, { out: usdc }, 100, true).ok).toBe(false);
  });

  it("parses a PriceUpdateV2 account and rejects partial verification or a wide confidence interval", () => {
    const build = (level: number, conf = 156_250_000n) => {
      const data = Buffer.alloc(134);
      Buffer.from([34, 241, 35, 99, 157, 126, 244, 205]).copy(data, 0);
      data[40] = level;
      data.fill(7, 41, 73); // feed id
      data.writeBigInt64LE(15_625_000_000n, 73);
      data.writeBigUInt64LE(conf, 81);
      data.writeInt32LE(-8, 89);
      data.writeBigInt64LE(1_800_000_000n, 93);
      data.writeBigUInt64LE(123_456n, 125); // posted slot
      return new Uint8Array(data);
    };
    expect(parsePriceUpdate(build(1))).toEqual({ feedId: new Uint8Array(32).fill(7), price: 15_625_000_000n,
      conf: 156_250_000n, exponent: -8, publishTime: 1_800_000_000n, postedSlot: 123_456n });
    expect(() => parsePriceUpdate(build(0))).toThrow(/fully verified/);
    // 1% of the price is the widest interval the pocket accepts.
    expect(() => parsePriceUpdate(build(1, 156_250_001n))).toThrow(/confidence/);
  });

  it("reads prices only from the sponsored push-feed account of their feed", async () => {
    const feedId = new Uint8Array(32).fill(7), canonical = new PublicKey(pythPushFeedAddress(feedId).address);
    const data = Buffer.alloc(134);
    Buffer.from([34, 241, 35, 99, 157, 126, 244, 205]).copy(data, 0);
    data[40] = 1;
    Buffer.from(feedId).copy(data, 41);
    data.writeBigInt64LE(15_625_000_000n, 73);
    data.writeInt32LE(-8, 89);
    const mint = PublicKey.unique(), mintData = Buffer.alloc(82);
    mintData[44] = 9; mintData[45] = 1;
    const accounts = new Map<string, { owner: PublicKey; data: Buffer }>([
      [mint.toBase58(), { owner: new PublicKey(SPL_TOKEN_PROGRAM_ID), data: mintData }],
    ]);
    const connection = { getAccountInfo: async (key: PublicKey) => accounts.get(key.toBase58()) ?? null } as unknown as Connection;
    const receiver = new PublicKey(PYTH_RECEIVER_PROGRAM_ID), elsewhere = PublicKey.unique();
    accounts.set(canonical.toBase58(), { owner: receiver, data });
    accounts.set(elsewhere.toBase58(), { owner: receiver, data });
    await expect(new PriceReader(connection, { [mint.toBase58()]: canonical.toBase58() }).priceFor(mint))
      .resolves.toEqual({ price: 15_625_000_000n, exponent: -8, decimals: 9 });
    await expect(new PriceReader(connection, { [mint.toBase58()]: elsewhere.toBase58() }).priceFor(mint))
      .rejects.toThrow(/sponsored push-feed/);
  });
});
