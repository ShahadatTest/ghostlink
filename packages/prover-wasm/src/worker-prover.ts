/**
 * Proving in a Web Worker, so the page stays responsive for the seconds a
 * proof takes. The worker runs `createProver` itself: the same pinned-hash
 * checks, the same cache and the same errors as the direct path.
 *
 * This module never imports snarkjs. A bundle that uses only
 * `createWorkerProver` carries snarkjs in the separate worker file.
 */
import { artifactsFor, type CircuitArtifacts, type Circuit, type CircuitInput, type ProofResult, type Prover } from "./prover.js";
import { PROTOCOL, fromWireError, isProverResponse, type ProverRequest, type WorkerArtifacts } from "./protocol.js";

/** What `createWorkerProver` needs from a worker: the browser `Worker` has it. */
export interface WorkerLike {
  postMessage(message: unknown): void;
  addEventListener(type: "message" | "error" | "messageerror", listener: (event: any) => void): void;
  terminate(): void;
}

export interface WorkerProverConfig {
  login: CircuitArtifacts;
  /** Only needed to prove owner actions; login-only sites can leave it out. */
  owner?: CircuitArtifacts;
  /**
   * Starts the worker. The default is
   * `new Worker(new URL("./worker.js", import.meta.url), { type: "module" })`
   * from inside this package, which webpack 5 (and so Next.js) and Vite
   * builds bundle as a separate file. Pass your own when your bundler needs
   * another pattern or you host the worker file yourself (README).
   */
  createWorker?: () => WorkerLike;
  /**
   * Longest a single proof may run once the worker starts it, downloads
   * included; then the worker is stopped and the proof rejects with a
   * `TimeoutError`. No limit by default.
   */
  timeoutMs?: number;
}

export interface WorkerProveOptions {
  /** Aborting rejects with the signal's reason; a running proof stops its worker. */
  signal?: AbortSignal;
  /** Overrides the prover's `timeoutMs` for this proof. */
  timeoutMs?: number;
}

export interface WorkerProver extends Prover {
  prove(circuit: Circuit, input: CircuitInput, options?: WorkerProveOptions): Promise<ProofResult>;
  /** Stops the worker and rejects pending proofs; later proofs are refused. */
  terminate(): void;
}

interface Job {
  id: number;
  circuit: Circuit;
  input: CircuitInput;
  timeoutMs?: number;
  signal?: AbortSignal;
  onAbort?: () => void;
  timer?: ReturnType<typeof setTimeout>;
  resolve(result: ProofResult): void;
  reject(error: unknown): void;
}

function defaultWorker(): WorkerLike {
  if (typeof Worker !== "function") {
    throw new Error("Web Workers are unavailable in this environment: createWorkerProver proves in a browser; use createProver elsewhere");
  }
  // Written out literally so that bundlers recognise it and emit worker.js.
  return new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
}

function checkTimeout(timeoutMs: number | undefined): void {
  if (timeoutMs !== undefined && !(Number.isFinite(timeoutMs) && timeoutMs > 0)) {
    throw new Error(`timeoutMs must be a positive number of milliseconds, not ${String(timeoutMs)}`);
  }
}

/** A worker resolves relative URLs against its own script, not the page: resolve them here. */
function absolute(url: string): string {
  const base = (globalThis as { location?: { href?: string } }).location?.href;
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

const copy = (a: CircuitArtifacts): CircuitArtifacts => ({
  wasmUrl: absolute(a.wasmUrl),
  zkeyUrl: absolute(a.zkeyUrl),
  ...(a.wasmSha256 === undefined ? {} : { wasmSha256: a.wasmSha256 }),
  ...(a.zkeySha256 === undefined ? {} : { zkeySha256: a.zkeySha256 }),
});

function workerFailure(event: unknown): Error {
  const detail = (event as { message?: unknown } | null)?.message;
  return new Error(typeof detail === "string" && detail
    ? `prover worker failed: ${detail}`
    : "prover worker failed to start or crashed: check that its script loads (see the @ghostlink/prover-wasm README)");
}

/**
 * A prover that runs each proof in a reusable Web Worker. One worker serves
 * one proof at a time; later calls queue. Nothing starts until the first
 * proof, so it is safe to create during server rendering.
 */
export function createWorkerProver(config: WorkerProverConfig): WorkerProver {
  checkTimeout(config.timeoutMs);
  // Copied now: changing the config object later cannot change pins or URLs.
  const setup: Pick<WorkerProverConfig, "login" | "owner"> = {
    login: { ...config.login },
    ...(config.owner ? { owner: { ...config.owner } } : {}),
  };
  const spawn = config.createWorker ?? defaultWorker;
  const queue: Job[] = [];
  let worker: WorkerLike | undefined;
  let active: Job | undefined;
  let closed = false;
  let nextId = 1;

  function start(): WorkerLike {
    const w = spawn();
    w.addEventListener("message", (event: { data?: unknown }) => onMessage(w, event?.data));
    w.addEventListener("error", (event: unknown) => onFailure(w, workerFailure(event)));
    w.addEventListener("messageerror", () => onFailure(w, new Error("prover worker sent a message that could not be read")));
    // Snapshot the configuration per worker, with URLs resolved against the page.
    const artifacts: WorkerArtifacts = { login: copy(setup.login), ...(setup.owner ? { owner: copy(setup.owner) } : {}) };
    w.postMessage({ protocol: PROTOCOL, type: "configure", config: artifacts } satisfies ProverRequest);
    return w;
  }

  function discard(w: WorkerLike): void {
    if (worker === w) worker = undefined;
    try {
      w.terminate();
    } catch {
      // Already gone.
    }
  }

  function settle(job: Job): void {
    if (job.timer !== undefined) clearTimeout(job.timer);
    if (job.onAbort) job.signal?.removeEventListener("abort", job.onAbort);
    if (active === job) active = undefined;
    const queued = queue.indexOf(job);
    if (queued >= 0) queue.splice(queued, 1);
  }

  function fail(job: Job, error: unknown): void {
    settle(job);
    job.reject(error);
  }

  function onMessage(w: WorkerLike, data: unknown): void {
    if (w !== worker || !active || !isProverResponse(data) || data.id !== active.id) return;
    const job = active;
    settle(job);
    if (data.ok) job.resolve({ proof: data.proof, publicSignals: data.publicSignals });
    else job.reject(fromWireError(data.error));
    pump();
  }

  function onFailure(w: WorkerLike, error: Error): void {
    if (w !== worker) return;
    discard(w);
    if (active) fail(active, error);
    pump();
  }

  /** A proof cannot be interrupted inside snarkjs: stopping it means stopping its worker. */
  function cancel(job: Job, reason: unknown): void {
    if (job === active && worker) discard(worker);
    fail(job, reason);
    pump();
  }

  function pump(): void {
    if (active || closed) return;
    const job = queue.shift();
    if (!job) return;
    active = job;
    try {
      worker ??= start();
      worker.postMessage({ protocol: PROTOCOL, type: "prove", id: job.id, circuit: job.circuit, input: job.input } satisfies ProverRequest);
    } catch (e) {
      // No Worker here, a factory that threw, or input that cannot be cloned.
      fail(job, e);
      pump();
      return;
    }
    if (job.timeoutMs !== undefined) {
      const ms = job.timeoutMs;
      job.timer = setTimeout(() => {
        const error = new Error(`proof timed out after ${ms} ms; its worker was stopped`);
        error.name = "TimeoutError";
        cancel(job, error);
      }, ms);
    }
  }

  return {
    prove(circuit, input, options = {}) {
      if (closed) return Promise.reject(new Error("this worker prover was terminated"));
      try {
        // The direct path's early refusals, before a worker exists or anything downloads.
        artifactsFor(setup, circuit, "createWorkerProver");
        checkTimeout(options.timeoutMs);
      } catch (e) {
        return Promise.reject(e);
      }
      const { signal } = options;
      if (signal?.aborted) return Promise.reject(signal.reason);
      return new Promise<ProofResult>((resolve, reject) => {
        const job: Job = {
          id: nextId++, circuit, input, signal, resolve, reject,
          timeoutMs: options.timeoutMs ?? config.timeoutMs,
        };
        if (signal) {
          job.onAbort = () => cancel(job, signal.reason);
          signal.addEventListener("abort", job.onAbort, { once: true });
        }
        queue.push(job);
        pump();
      });
    },
    terminate() {
      if (closed) return;
      closed = true;
      if (worker) discard(worker);
      const error = new Error("this worker prover was terminated");
      for (const job of [...(active ? [active] : []), ...queue]) fail(job, error);
    },
  };
}
