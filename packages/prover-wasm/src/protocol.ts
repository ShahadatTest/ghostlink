/**
 * The messages between `createWorkerProver` (the page) and the worker entry
 * (`@ghostlink/prover-wasm/worker`). Internal: both ends ship together in
 * this package, so the protocol needs no compatibility promise beyond its tag.
 */
import { createProver, type CircuitArtifacts, type Circuit, type CircuitInput, type Prover } from "./prover.js";

export const PROTOCOL = "ghostlink-prover/1";

/** The artifacts a worker proves with; URLs are absolute (a worker resolves relative URLs against its own script). */
export interface WorkerArtifacts {
  login: CircuitArtifacts;
  owner?: CircuitArtifacts;
}

export type ProverRequest =
  | { protocol: typeof PROTOCOL; type: "configure"; config: WorkerArtifacts }
  | { protocol: typeof PROTOCOL; type: "prove"; id: number; circuit: Circuit; input: CircuitInput };

export interface WireError {
  name: string;
  message: string;
}

export type ProverResponse =
  | { protocol: typeof PROTOCOL; type: "result"; id: number; ok: true; proof: object; publicSignals: string[] }
  | { protocol: typeof PROTOCOL; type: "result"; id: number; ok: false; error: WireError };

/** The part of a DedicatedWorkerGlobalScope (or a MessagePort) the worker side uses. */
export interface ProverWorkerScope {
  postMessage(message: ProverResponse): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

export function isProverResponse(data: unknown): data is ProverResponse {
  return isObject(data) && data.protocol === PROTOCOL && data.type === "result" && typeof data.id === "number";
}

export function toWireError(e: unknown): WireError {
  if (e instanceof Error) return { name: e.name, message: e.message };
  return { name: "Error", message: String(e) };
}

export function fromWireError(wire: unknown): Error {
  const e = new Error(isObject(wire) && typeof wire.message === "string" ? wire.message : "prover worker failed");
  if (isObject(wire) && typeof wire.name === "string" && wire.name) e.name = wire.name;
  return e;
}

/**
 * Answers prove requests on `scope` with `createProver`, so the worker path
 * has exactly the pinned-hash checks, cache and errors of the direct path.
 * The first configuration wins: pins cannot be swapped once set.
 */
export function serveProver(scope: ProverWorkerScope, options: { fetchFn?: typeof fetch } = {}): void {
  let prover: Prover | undefined;
  scope.addEventListener("message", (event) => {
    const message = event.data;
    if (!isObject(message) || message.protocol !== PROTOCOL) return;
    if (message.type === "configure") {
      prover ??= createProver({ ...(message.config as WorkerArtifacts), fetchFn: options.fetchFn });
      return;
    }
    if (message.type !== "prove" || typeof message.id !== "number") return;
    const id = message.id;
    const fail = (e: unknown) => scope.postMessage({ protocol: PROTOCOL, type: "result", id, ok: false, error: toWireError(e) });
    if (!prover) return fail(new Error("prover worker received a proof request before its configuration"));
    let pending: Promise<{ proof: object; publicSignals: string[] }>;
    try {
      pending = prover.prove(message.circuit as Circuit, message.input as CircuitInput);
    } catch (e) {
      return fail(e);
    }
    pending.then(
      ({ proof, publicSignals }) => scope.postMessage({ protocol: PROTOCOL, type: "result", id, ok: true, proof, publicSignals }),
      fail,
    );
  });
}
