/**
 * Every public input must take part in at least one constraint. If circom's
 * optimizer ever folded away a binding such as `x <== input * 1`, that
 * input's IC point in the verifying key would be the point at infinity and
 * a proof would verify for ANY value of it — a replayable session key,
 * home address or action digest. Two guards: the IC points are finite, and
 * the committed proofs stop verifying when any public signal changes.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - snarkjs ships no types
import * as snarkjs from "snarkjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const keys = join(root, "circuits/keys");
const load = (name: string) => JSON.parse(readFileSync(join(keys, name), "utf8"));

const INFINITY = (p: string[]) => p[0] === "0" && p[1] === "1" && p[2] === "0";

const circuits = [
  { name: "login", vk: "login_vk.json", proof: "login_proof.json", publicInputs: 12 },
  { name: "owner", vk: "owner_vk.json", proof: "owner_proof.json", publicInputs: 4 },
];

describe("verifying keys bind every public input", () => {
  for (const c of circuits) {
    const present = existsSync(join(keys, c.vk)) && existsSync(join(keys, c.proof));

    it(`${c.name}: every IC point is a finite curve point`, () => {
      expect(present, `${c.vk} / ${c.proof} missing — run scripts/build-circuits.sh`).toBe(true);
      const vk = load(c.vk);
      expect(vk.nPublic).toBe(c.publicInputs);
      expect(vk.IC).toHaveLength(c.publicInputs + 1);
      for (const [i, p] of (vk.IC as string[][]).entries()) {
        expect(INFINITY(p), `IC[${i}] is the point at infinity: public input ${i} is unconstrained`).toBe(false);
        expect(p[2]).toBe("1");
      }
    });

    it(`${c.name}: changing any public signal breaks the committed proof`, async () => {
      expect(present).toBe(true);
      const vk = load(c.vk);
      const { proof, publicSignals } = load(c.proof) as { proof: object; publicSignals: string[] };
      expect(await snarkjs.groth16.verify(vk, publicSignals, proof)).toBe(true);
      for (let i = 0; i < publicSignals.length; i++) {
        const mutated = [...publicSignals];
        mutated[i] = (BigInt(mutated[i]!) + 1n).toString();
        expect(
          await snarkjs.groth16.verify(vk, mutated, proof),
          `public signal ${i} is not bound by the proof`,
        ).toBe(false);
      }
    });
  }
});

/**
 * snarkjs fixes gamma to the G2 generator. `groth16 setup` alone leaves delta
 * equal to it as well, and with gamma == delta anyone can forge a proof for
 * any public inputs from the verifying key alone: A = alpha, B = beta,
 * C = -(IC_0 + sum s_i * IC_i). One random phase-2 contribution
 * (`zkey contribute`, see scripts/build-circuits.sh) makes the dev keys sound
 * against everyone except whoever ran the setup. Production keys still need
 * a public multi-party ceremony.
 */
describe("verifying keys come from a setup with a phase-2 contribution", () => {
  for (const c of circuits) {
    it(`${c.name}: delta differs from gamma`, () => {
      const vk = load(c.vk);
      expect(vk.vk_delta_2, "delta equals gamma: the setup had no phase-2 contribution").not.toEqual(vk.vk_gamma_2);
    });

    it(`${c.name}: the textbook forgery for a degenerate setup is rejected`, async () => {
      const vk = load(c.vk);
      const curve = await snarkjs.curves.getCurveFromName("bn128");
      const { G1 } = curve;
      const signals = (vk.IC as string[][]).slice(1).map((_, i) => String(1000 + i));
      let vkX = G1.fromObject((vk.IC[0] as string[]).map(BigInt));
      signals.forEach((s, i) => {
        vkX = G1.add(vkX, G1.timesScalar(G1.fromObject((vk.IC[i + 1] as string[]).map(BigInt)), BigInt(s)));
      });
      const forged = {
        pi_a: vk.vk_alpha_1,
        pi_b: vk.vk_beta_2,
        pi_c: (G1.toObject(G1.toAffine(G1.neg(vkX))) as bigint[]).map(String),
        protocol: "groth16",
        curve: "bn128",
      };
      expect(await snarkjs.groth16.verify(vk, signals, forged)).toBe(false);
    });
  }
});
