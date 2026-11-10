/**
 * @ghostlink/prover-wasm: device-side GhostLink proving.
 *
 * - `createProver` proves on the calling thread (a worker of your own, Node).
 * - `createWorkerProver` proves in a Web Worker started from this package's
 *   worker entry, `@ghostlink/prover-wasm/worker`, keeping the page responsive.
 *
 * Neither imports snarkjs until the first proof.
 */
export {
  createProver,
  type CircuitArtifacts,
  type Circuit,
  type CircuitInput,
  type ProofResult,
  type Prover,
  type ProverConfig,
} from "./prover.js";
export {
  createWorkerProver,
  type WorkerLike,
  type WorkerProveOptions,
  type WorkerProver,
  type WorkerProverConfig,
} from "./worker-prover.js";
