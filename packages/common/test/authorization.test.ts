import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { sha256 } from "@noble/hashes/sha256";
import {
  POCKET_AUTHORIZATION_EPOCH_OFFSET, conservativePolicy, developmentSessionDeployment, hashToField, hexToBytes,
  pocketAuthorizationContext, pocketAuthorizationEpoch, policyHash,
} from "../src/index.js";

const v = JSON.parse(readFileSync(new URL("../fixtures/vectors.json", import.meta.url), "utf8"));
const policy = () => ({ ...conservativePolicy(), oracleFeeds: v.policyWithFeeds.feeds.map(
  (f: { mint: string; feedId: string; decimals: number }) => ({ mint: hexToBytes(f.mint), feedId: hexToBytes(f.feedId), decimals: f.decimals }),
) });

describe("V2 pocket authorization context", () => {
  it("pins the cross-language fixture and separates every deployment identity and key kind", () => {
    const expected = BigInt(v.circuits.login.public.authorization_context);
    expect(pocketAuthorizationContext(policy(), 0)).toBe(expected);
    expect(expected).not.toBe(0n);
    expect(pocketAuthorizationContext(policy(), 1)).not.toBe(expected);
    for (const key of ["pocketProgram", "registryProgram", "censusProgram"] as const) {
      const d = developmentSessionDeployment();
      d[key][0] ^= 1;
      expect(pocketAuthorizationContext(policy(), 0, d)).not.toBe(expected);
    }
    // Mutable caller state must not poison the default deployment.
    expect(pocketAuthorizationContext(policy(), 0)).toBe(expected);
    expect(() => pocketAuthorizationContext(policy(), 2)).toThrow(/session kind/);
    expect(() => pocketAuthorizationContext(policy(), 0, {
      ...developmentSessionDeployment(), pocketProgram: new Uint8Array(31),
    })).toThrow(/32 bytes/);
  });

  it("binds the pocket's revocation epoch as the v3 preimage's last eight bytes", () => {
    const expected = BigInt(v.circuits.login.public.authorization_context);
    expect(pocketAuthorizationContext(policy(), 0, undefined, 0n)).toBe(expected);
    const epochs = [1n, 2n, 256n, (1n << 64n) - 1n].map(e => pocketAuthorizationContext(policy(), 0, undefined, e));
    expect(new Set([expected, ...epochs]).size).toBe(5);
    // Independent preimage: tag, three program ids, policy hash, kind, epoch (u64 LE).
    const d = developmentSessionDeployment(), tag = new TextEncoder().encode("ghostlink:open-session:v3");
    const preimage = Buffer.concat([tag, d.pocketProgram, d.registryProgram, d.censusProgram, policyHash(policy()),
      Buffer.from([0]), Buffer.from([2, 0, 0, 0, 0, 0, 0, 0])]);
    expect(pocketAuthorizationContext(policy(), 0, undefined, 2n)).toBe(hashToField(sha256(preimage)));
    for (const bad of [-1n, 1n << 64n, 1 as unknown as bigint]) {
      expect(() => pocketAuthorizationContext(policy(), 0, undefined, bad)).toThrow(/u64/);
    }
  });

  it("reads the epoch at its fixed PocketV3 offset and refuses other accounts", () => {
    const data = new Uint8Array(POCKET_AUTHORIZATION_EPOCH_OFFSET + 8);
    data.set(sha256(new TextEncoder().encode("account:PocketV3")).subarray(0, 8));
    data.set([7, 1, 0, 0, 0, 0, 0, 0], POCKET_AUTHORIZATION_EPOCH_OFFSET);
    expect(POCKET_AUTHORIZATION_EPOCH_OFFSET).toBe(146);
    expect(pocketAuthorizationEpoch(data)).toBe(263n);
    expect(() => pocketAuthorizationEpoch(data.subarray(0, data.length - 1))).toThrow(/PocketV3/);
    data[0] ^= 1;
    expect(() => pocketAuthorizationEpoch(data)).toThrow(/PocketV3/);
  });
});
