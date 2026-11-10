/**
 * The device-side prover: proving stays on the device, so the identity
 * secret never reaches a server.
 *
 * Artifacts (circuit wasm + proving key) are fetched once, checked
 * against pinned SHA-256 integrity hashes when you supply them (the
 * supply-chain control in the threat model), cached, and handed to
 * snarkjs. `createProver` runs on the calling thread, and a login proof
 * takes seconds (docs/benchmarks.md): in a page, prefer
 * `createWorkerProver`, which runs this same code in a Web Worker.
 */

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

export type Circuit = "login" | "owner";
export type CircuitInput = Record<string, string | string[]>;
export interface ProofResult {
  proof: object;
  publicSignals: string[];
}

export interface Prover {
  prove(circuit: Circuit, input: CircuitInput): Promise<ProofResult>;
}

const SHA256_HEX = /^[0-9a-fA-F]{64}$/;

function checkPin(url: string, expectedSha256: string | undefined): void {
  if (expectedSha256 !== undefined && !SHA256_HEX.test(expectedSha256)) {
    throw new Error(`invalid SHA-256 integrity hash for ${url}`);
  }
}

/**
 * The artifacts configured for `circuit`, with malformed pins refused:
 * every check that can fail before anything is downloaded.
 */
export function artifactsFor(
  config: Pick<ProverConfig, "login" | "owner">,
  circuit: Circuit,
  factory = "createProver",
): CircuitArtifacts {
  if (circuit !== "login" && circuit !== "owner") throw new Error(`unknown circuit: ${String(circuit)}`);
  const art = config[circuit];
  // Login-only sites configure no owner circuit: fail before any download.
  if (!art) throw new Error(`no ${circuit} circuit artifacts configured: pass ${factory}({ ${circuit}: { wasmUrl, zkeyUrl, wasmSha256, zkeySha256 } })`);
  checkPin(art.wasmUrl, art.wasmSha256);
  checkPin(art.zkeyUrl, art.zkeySha256);
  return art;
}

type FullProve = (input: CircuitInput, wasm: Uint8Array, zkey: Uint8Array) => Promise<{ proof: object; publicSignals: string[] }>;
let fullProveLoad: Promise<FullProve> | undefined;

/**
 * snarkjs is large and touches browser or Node APIs as it loads, so it is
 * imported on the first proof, not with this module: importing the package
 * on a server or into a page costs nothing until someone proves.
 */
function loadFullProve(): Promise<FullProve> {
  fullProveLoad ??= import("snarkjs").then(
    (m) => m.groth16.fullProve as FullProve,
    (e: unknown) => {
      fullProveLoad = undefined;
      throw e;
    },
  );
  return fullProveLoad;
}

export function createProver(config: ProverConfig): Prover {
  const fetchFn = config.fetchFn ?? fetch;
  const cache = new Map<string, Promise<Uint8Array>>();

  async function load(url: string, expectedSha256?: string): Promise<Uint8Array> {
    checkPin(url, expectedSha256);
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
      const art = artifactsFor(config, circuit);
      const [wasm, zkey] = await Promise.all([
        load(art.wasmUrl, art.wasmSha256),
        load(art.zkeyUrl, art.zkeySha256),
      ]);
      const fullProve = await loadFullProve();
      const { proof, publicSignals } = await fullProve(input, wasm, zkey);
      return { proof: proof as object, publicSignals: publicSignals as string[] };
    },
  };
}
