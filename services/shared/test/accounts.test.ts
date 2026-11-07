import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha256";
import { SystemProgram } from "@solana/web3.js";
import { BorshWriter, POCKET, POCKET_ACCOUNT_SIZE, encodePocketAccount, isPocketAccount, isPocketNonceUsed, readPocketAccount,
  rollingWindowTotal, writePolicy } from "../src/index.js";
import { pocketAuthorizationEpoch, type Policy } from "@ghostlink/common";

const appId = new Uint8Array(32).fill(3);
const policy: Policy = { dailyCapUsdE6: 1n, maxSlippageBps: 100, bigActionThresholdUsdE6: 2n, noOracleCapUsdE6: 0n,
  sessionMaxSlots: 10n, allowedOutMints: [new Uint8Array(32).fill(5)],
  oracleFeeds: [{ mint: new Uint8Array(32).fill(5), feedId: new Uint8Array(32).fill(6), decimals: 9 }] };

describe("Pocket account decoding", () => {
  it("interprets wrapped nonce bits and never reuses values below the on-chain window", () => {
    const a = { nonceBase: 3000n, nonceBitmap: new Uint8Array(256) };
    a.nonceBitmap[0] = 128; // circular bit 7 belongs to 4103 in this window.
    expect(isPocketNonceUsed(a, 7n)).toBe(true);
    expect(isPocketNonceUsed(a, 2999n)).toBe(true);
    expect(isPocketNonceUsed(a, 3000n)).toBe(false);
    expect(isPocketNonceUsed(a, 4103n)).toBe(true);
    expect(isPocketNonceUsed(a, 6151n)).toBe(false); // same bit, beyond this window.
    expect(() => isPocketNonceUsed(a, 1n << 64n)).toThrow();
  });
  it("finds the owner nonce after dynamic policy and pending-change layouts", () => {
    for (const enabled of [false, true]) for (const pending of [undefined, "home", "policy"]) {
      const chosen: Policy = enabled ? { ...policy, noOracleCapUsdE6: 1n,
        speculative: { dailyBuyCapUsdE6: 2n, maxCostExposureUsdE6: 3n, maxPositions: 1,
          baseMints: [policy.oracleFeeds[0]!.mint] } } : policy;
      const w = new BorshWriter().fixed(sha256(new TextEncoder().encode("account:PocketV3")).subarray(0, 8))
        .fixed(appId).fixed(new Uint8Array(32)).fixed(SystemProgram.programId.toBytes())
        .u8(0).fixed(new Uint8Array(33)).u64(100n).u64(4n); // session expiry, revocation epoch
      writePolicy(w, chosen);
      w.option(pending, (writer, value) => {
        if (value === "home") writer.u8(0).fixed(SystemProgram.programId.toBytes());
        else { writer.u8(1); writePolicy(writer, chosen); }
        writer.u64(500n);
      });
      // Rolling windows: newest bucket index, then 25 hourly amounts (bucket b at b % 25).
      const window = (latest: bigint, entries: [number, bigint][]) => {
        w.u64(latest);
        for (let i = 0; i < 25; i++) w.u64(entries.find(([at]) => at === i)?.[1] ?? 0n);
      };
      window(13_741n, [[16, 2n], [17, 3n]]); // index 16 is hour 13,741; index 17 is hour 13,717.
      w.fixed(new Uint8Array(256)).u8(254).u64(100n).u64(2048n).u64(17n);
      window(13_741n, [[16, 9n]]);
      w.fixed(new Uint8Array(32).fill(7)).fixed(new Uint8Array(32).fill(5))
        .fixed(SystemProgram.programId.toBytes()).u64(12n).u64(13n);
      const data = new Uint8Array(POCKET_ACCOUNT_SIZE);
      data.set(w.out());
      const info = { owner: POCKET, data, executable: false, lamports: 1, rentEpoch: 0 };
      expect(readPocketAccount(info).ownerActionNonce).toBe(17n);
      expect(readPocketAccount(info).authorizationEpoch).toBe(4n);
      expect(pocketAuthorizationEpoch(data)).toBe(4n);
      expect(readPocketAccount(info).policy).toEqual(chosen);
      const slot = 13_741n * 9_000n;
      expect(rollingWindowTotal(readPocketAccount(info).speculativeBuys, slot)).toBe(9n);
      // Hour 13,717 is the oldest still inside the window at hour 13,741 and leaves it next hour.
      expect(rollingWindowTotal(readPocketAccount(info).spending, slot)).toBe(5n);
      expect(rollingWindowTotal(readPocketAccount(info).spending, slot + 9_000n)).toBe(2n);
      expect(rollingWindowTotal(readPocketAccount(info).spending, slot + 25n * 9_000n)).toBe(0n);
      expect(readPocketAccount(info).speculativePositions).toHaveLength(1);
      expect(readPocketAccount(info).speculativePositions[0]).toMatchObject({ quantity: 12n, costUsdE6: 13n });
      expect(isPocketAccount({ ...info, owner: SystemProgram.programId }, appId)).toBe(false);
      // Old allocations had padding that looks like a zero owner nonce.
      expect(() => readPocketAccount({ ...info, data: info.data.subarray(0, 2081) })).toThrow(/unsupported Pocket account size/);
      // The fixture encoder agrees with this independent byte layout.
      const decoded = readPocketAccount(info);
      expect(Buffer.from(encodePocketAccount(decoded)).equals(Buffer.from(data))).toBe(true);
    }
  });
  it("encodes fixture accounts that decode to the same state", () => {
    const home = SystemProgram.programId, position = { mint: home, baseMint: POCKET, tokenAccount: POCKET, quantity: 4n, costUsdE6: 5n };
    const spending = { latestBucket: 14n, amounts: Array.from({ length: 25 }, (_, i) => BigInt(i)) };
    const state = { appId, home, policy, bump: 7, sessionExpirySlot: 9n, authorizationEpoch: 3n, nonceBase: 10n, ownerActionNonce: 11n,
      pending: { change: { policy }, executableAfterSlot: 12n }, speculativePositions: [position], spending };
    const data = encodePocketAccount(state);
    const decoded = readPocketAccount({ owner: POCKET, data, executable: false, lamports: 1, rentEpoch: 0 });
    expect([decoded.bump, decoded.sessionExpirySlot, decoded.authorizationEpoch, decoded.nonceBase, decoded.ownerActionNonce])
      .toEqual([7, 9n, 3n, 10n, 11n]);
    expect(Buffer.from(decoded.appId).equals(Buffer.from(appId)) && decoded.home.equals(home)).toBe(true);
    expect(decoded.pending?.executableAfterSlot).toBe(12n);
    expect(decoded.speculativePositions).toEqual([position]);
    expect(decoded.spending).toEqual(spending);
    expect(decoded.speculativeBuys).toEqual({ latestBucket: 0n, amounts: Array(25).fill(0n) });
    expect(encodePocketAccount(decoded).equals(data)).toBe(true);
    expect(() => encodePocketAccount({ ...state, speculativePositions: Array(9).fill(position) })).toThrow(/too many/);
    expect(() => encodePocketAccount({ ...state, spending: { latestBucket: 0n, amounts: [1n] } })).toThrow(/rolling window/);
  });
});
