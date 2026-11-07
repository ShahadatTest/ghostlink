/**
 * The device-side prover: proving stays on the device, so the identity
 * secret never reaches a server.
 *
 * Artifacts (circuit wasm + proving key) are fetched once, checked
 * against pinned SHA-256 integrity hashes when you supply them (the
 * supply-chain control in the threat model), cached, and handed to
 * snarkjs. Use `createProver` in a web worker where possible: a login
 * proof takes seconds (docs/benchmarks.md).
 */
import * as snarkjs from "snarkjs";

export interface CircuitArtifacts {
  wasmUrl: string;
  zkeyUrl: string;
  /**
   * Hex SHA-256 of each artifact; proving is refused on a mismatch.
   * Without them the downloaded files are used unchecked, so whoever
   * controls those URLs controls what runs on the user's secret: pin
   * both in production.
   */
  wasmSha256?: string;
  zkeySha256?: string;
}

export interface ProverConfig {
  login: CircuitArtifacts;
  /** Only needed to prove owner actions; login-only sites can leave it out. */
  owner?: CircuitArtifacts;
  fetchFn?: typeof fetch;
}

export interface Prover {
  prove(
    circuit: "login" | "owner",
    input: Record<string, string | string[]>,
  ): Promise<{ proof: object; publicSignals: string[] }>;
}

export function createProver(config: ProverConfig): Prover {
  const fetchFn = config.fetchFn ?? fetch;
  const cache = new Map<string, Promise<Uint8Array>>();

  async function load(url: string, expectedSha256?: string): Promise<Uint8Array> {
    if (expectedSha256 !== undefined && !/^[0-9a-fA-F]{64}$/.test(expectedSha256)) {
      throw new Error(`invalid SHA-256 integrity hash for ${url}`);
    }
    // The same URL may be configured for multiple circuits. Reuse is only
    // valid under the same integrity requirement, including pinned vs not.
    const key = JSON.stringify([url, expectedSha256?.toLowerCase() ?? null]);
    const hit = cache.get(key);
    if (hit) return hit;
    const pending = download(url, expectedSha256);
    cache.set(key, pending);
    try {
      return await pending;
    } catch (e) {
      cache.delete(key);
      throw e;
    }
  }

  async function download(url: string, expectedSha256?: string): Promise<Uint8Array> {
    const res = await fetchFn(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (expectedSha256) {
      const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer);
      const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
      if (hex !== expectedSha256.toLowerCase()) {
        throw new Error(`integrity check failed for ${url}`);
      }
    }
    return bytes;
  }

  return {
    async prove(circuit, input) {
      if (circuit !== "login" && circuit !== "owner") throw new Error(`unknown circuit: ${String(circuit)}`);
      const art = config[circuit];
      // Login-only sites configure no owner circuit: fail before any download.
      if (!art) throw new Error(`no ${circuit} circuit artifacts configured: pass createProver({ ${circuit}: { wasmUrl, zkeyUrl, wasmSha256, zkeySha256 } })`);
      const [wasm, zkey] = await Promise.all([
        load(art.wasmUrl, art.wasmSha256),
        load(art.zkeyUrl, art.zkeySha256),
      ]);
      const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasm, zkey);
      return { proof: proof as object, publicSignals: publicSignals as string[] };
    },
  };
}
