/**
 * The worker path without a browser: each fake worker is a real
 * MessageChannel (so every message is structured-cloned, as with a Worker)
 * whose far end runs the same `serveProver` the worker entry runs, with an
 * injected fetch. snarkjs is mocked; the packaging check runs the built
 * worker entry in a real thread.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { createWorkerProver, type WorkerLike } from "../src/index.js";
import { PROTOCOL, serveProver, type ProverWorkerScope } from "../src/protocol.js";

const fullProve = vi.hoisted(() => vi.fn());
vi.mock("snarkjs", () => ({ groth16: { fullProve } }));

const bytes = new Uint8Array([1, 2, 3]);
const hash = createHash("sha256").update(bytes).digest("hex");
const artifacts = { wasmUrl: "https://artifacts.test/circuit.wasm", zkeyUrl: "https://artifacts.test/circuit.zkey" };
const pinned = { ...artifacts, wasmSha256: hash, zkeySha256: hash };
const proofOf = (input: Record<string, unknown>) => ({ proof: { pi_a: ["1", "2", "1"], protocol: "groth16" }, publicSignals: [String(input.x ?? "0")] });

class ChannelWorker implements WorkerLike {
  readonly port: MessagePort;
  terminated = false;
  private readonly errorListeners: ((event: unknown) => void)[] = [];

  constructor(fetchFn: typeof fetch) {
    const { port1, port2 } = new MessageChannel();
    this.port = port1;
    serveProver(port2 as unknown as ProverWorkerScope, { fetchFn });
    port2.start();
    port1.start();
  }

  postMessage(message: unknown): void {
    this.port.postMessage(message);
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    if (type === "message") this.port.addEventListener("message", listener as never);
    else if (type === "error") this.errorListeners.push(listener);
  }

  terminate(): void {
    this.terminated = true;
    this.port.close();
  }

  crash(message: string): void {
    for (const listener of this.errorListeners) listener({ message });
  }
}

let workers: ChannelWorker[] = [];
const fetchFn = vi.fn(async (_url: string) => new Response(bytes));
const createWorker = () => {
  const w = new ChannelWorker(fetchFn as unknown as typeof fetch);
  workers.push(w);
  return w;
};

beforeEach(() => {
  workers = [];
  fetchFn.mockClear();
  fullProve.mockReset();
  fullProve.mockImplementation(async (input: Record<string, unknown>) => proofOf(input));
});
afterEach(() => {
  for (const w of workers) if (!w.terminated) w.terminate();
  vi.unstubAllGlobals();
});

describe("createWorkerProver", () => {
  it("proves in one reused worker, downloading each pinned artifact once", async () => {
    const prover = createWorkerProver({ login: pinned, createWorker });
    expect(workers).toHaveLength(0); // nothing starts before the first proof
    const [a, b] = await Promise.all([prover.prove("login", { x: "7" }), prover.prove("login", { x: "8" })]);
    expect(a).toEqual(proofOf({ x: "7" }));
    expect(b).toEqual(proofOf({ x: "8" }));
    await prover.prove("login", { x: "9" });
    expect(workers).toHaveLength(1);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fullProve).toHaveBeenCalledTimes(3);
    const [input, wasm, zkey] = fullProve.mock.calls[0]!;
    expect(input).toEqual({ x: "7" });
    expect(wasm).toEqual(bytes);
    expect(zkey).toEqual(bytes);
    prover.terminate();
    expect(workers[0]!.terminated).toBe(true);
  });

  it("enforces the pins inside the worker and carries the error back", async () => {
    const prover = createWorkerProver({ login: { ...pinned, wasmSha256: "00".repeat(32) }, createWorker });
    const error = await prover.prove("login", {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("integrity check failed for https://artifacts.test/circuit.wasm");
    expect(fullProve).not.toHaveBeenCalled();
  });

  it("refuses malformed pins, unknown circuits and missing owner artifacts before starting a worker", async () => {
    const prover = createWorkerProver({ login: { ...pinned, zkeySha256: "not-a-hash" }, createWorker });
    await expect(prover.prove("login", {})).rejects.toThrow("invalid SHA-256 integrity hash for https://artifacts.test/circuit.zkey");
    await expect(prover.prove("owner", {})).rejects.toThrow(/^no owner circuit artifacts configured: pass createWorkerProver/);
    await expect(prover.prove("__proto__" as never, {})).rejects.toThrow("unknown circuit");
    expect(() => createWorkerProver({ login: pinned, timeoutMs: 0 })).toThrow(/timeoutMs/);
    await expect(createWorkerProver({ login: pinned, createWorker }).prove("login", {}, { timeoutMs: -1 })).rejects.toThrow(/timeoutMs/);
    expect(workers).toHaveLength(0);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("keeps the configuration it was created with", async () => {
    const login = { ...pinned };
    const prover = createWorkerProver({ login, createWorker });
    login.wasmSha256 = "00".repeat(32);
    await expect(prover.prove("login", {})).resolves.toEqual(proofOf({}));
  });

  it("propagates a proving error with its name and message", async () => {
    fullProve.mockRejectedValueOnce(new TypeError("Too many values for input signal x"));
    const prover = createWorkerProver({ login: pinned, createWorker });
    const error = (await prover.prove("login", { x: ["1", "2"] }).catch((e: unknown) => e)) as Error;
    expect(error.name).toBe("TypeError");
    expect(error.message).toBe("Too many values for input signal x");
    // The worker survives an ordinary failure.
    await expect(prover.prove("login", {})).resolves.toEqual(proofOf({}));
    expect(workers).toHaveLength(1);
  });

  it("times out a stuck proof, stops its worker and proves the next one in a fresh worker", async () => {
    fullProve.mockImplementationOnce(() => new Promise(() => {}));
    const prover = createWorkerProver({ login: pinned, createWorker, timeoutMs: 50 });
    const error = (await prover.prove("login", {}).catch((e: unknown) => e)) as Error;
    expect(error.name).toBe("TimeoutError");
    expect(error.message).toMatch(/timed out after 50 ms/);
    expect(workers[0]!.terminated).toBe(true);
    await expect(prover.prove("login", { x: "2" })).resolves.toEqual(proofOf({ x: "2" }));
    expect(workers).toHaveLength(2);
  });

  it("cancels a running proof by stopping its worker, and a queued proof without touching the running one", async () => {
    let release!: () => void;
    fullProve.mockImplementationOnce(() => new Promise(() => {}))
      .mockImplementationOnce(async (input: Record<string, unknown>) => {
        await new Promise<void>((resolve) => { release = resolve; });
        return proofOf(input);
      });
    const prover = createWorkerProver({ login: pinned, createWorker });
    const running = new AbortController();
    const first = prover.prove("login", { x: "1" }, { signal: running.signal });
    const second = prover.prove("login", { x: "2" });
    const queued = new AbortController();
    const third = prover.prove("login", { x: "3" }, { signal: queued.signal });
    await vi.waitFor(() => expect(fullProve).toHaveBeenCalledTimes(1));
    running.abort(new Error("user closed the dialog"));
    await expect(first).rejects.toThrow("user closed the dialog");
    expect(workers[0]!.terminated).toBe(true);
    queued.abort();
    await expect(third).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(fullProve).toHaveBeenCalledTimes(2));
    release();
    await expect(second).resolves.toEqual(proofOf({ x: "2" }));
    expect(workers).toHaveLength(2);
    expect(fullProve).toHaveBeenCalledTimes(2); // the cancelled queued proof never ran
    const aborted = AbortSignal.abort(new Error("already gone"));
    await expect(prover.prove("login", {}, { signal: aborted })).rejects.toThrow("already gone");
  });

  it("rejects the running proof when the worker crashes, then starts a new worker", async () => {
    fullProve.mockImplementationOnce(() => new Promise(() => {}));
    const prover = createWorkerProver({ login: pinned, createWorker });
    const pending = prover.prove("login", {});
    await vi.waitFor(() => expect(fullProve).toHaveBeenCalledTimes(1));
    workers[0]!.crash("out of memory");
    await expect(pending).rejects.toThrow("prover worker failed: out of memory");
    expect(workers[0]!.terminated).toBe(true);
    await expect(prover.prove("login", {})).resolves.toEqual(proofOf({}));
    expect(workers).toHaveLength(2);
  });

  it("rejects input the worker cannot receive, and keeps the worker", async () => {
    const prover = createWorkerProver({ login: pinned, createWorker });
    await expect(prover.prove("login", { x: (() => "1") as never })).rejects.toThrow(/could not be cloned/);
    await expect(prover.prove("login", {})).resolves.toEqual(proofOf({}));
    expect(workers).toHaveLength(1);
  });

  it("terminate rejects pending proofs and refuses later ones", async () => {
    fullProve.mockImplementation(() => new Promise(() => {}));
    const prover = createWorkerProver({ login: pinned, createWorker });
    const running = prover.prove("login", {});
    const queued = prover.prove("login", {});
    prover.terminate();
    await expect(running).rejects.toThrow("this worker prover was terminated");
    await expect(queued).rejects.toThrow("this worker prover was terminated");
    await expect(prover.prove("login", {})).rejects.toThrow("this worker prover was terminated");
    expect(workers.every((w) => w.terminated)).toBe(true);
  });

  it("resolves relative artifact URLs against the page, not the worker script", async () => {
    vi.stubGlobal("location", { href: "https://app.test/account/login" });
    const pageFetch = vi.fn(async (_url: string) => new Response(bytes));
    const prover = createWorkerProver({
      login: { wasmUrl: "/circuits/login.wasm", zkeyUrl: "login.zkey" },
      createWorker: () => new ChannelWorker(pageFetch as unknown as typeof fetch),
    });
    await prover.prove("login", {});
    prover.terminate();
    expect(pageFetch.mock.calls.map(([url]) => url).sort()).toEqual([
      "https://app.test/account/login.zkey",
      "https://app.test/circuits/login.wasm",
    ]);
  });

  it("is safe to create where Web Workers do not exist, and says why proving fails there", async () => {
    expect(typeof (globalThis as { Worker?: unknown }).Worker).toBe("undefined");
    const prover = createWorkerProver({ login: pinned });
    await expect(prover.prove("login", {})).rejects.toThrow(/Web Workers are unavailable/);
  });
});

describe("serveProver", () => {
  function serve() {
    const { port1, port2 } = new MessageChannel();
    serveProver(port2 as unknown as ProverWorkerScope, { fetchFn: fetchFn as unknown as typeof fetch });
    port2.start();
    const replies: unknown[] = [];
    port1.on("message", (data) => replies.push(data));
    return { port: port1, replies, close: () => port1.close() };
  }

  it("refuses to prove before it is configured, ignores foreign messages, and keeps its first pins", async () => {
    const { port, replies, close } = serve();
    try {
      port.postMessage({ type: "prove", id: 1, circuit: "login", input: {} });
      port.postMessage({ protocol: PROTOCOL, type: "prove", id: 2, circuit: "login", input: {} });
      await vi.waitFor(() => expect(replies).toHaveLength(1));
      expect(replies[0]).toMatchObject({ id: 2, ok: false, error: { message: expect.stringMatching(/before its configuration/) } });
      port.postMessage({ protocol: PROTOCOL, type: "configure", config: { login: { ...pinned, wasmSha256: "00".repeat(32) } } });
      port.postMessage({ protocol: PROTOCOL, type: "configure", config: { login: artifacts } });
      port.postMessage({ protocol: PROTOCOL, type: "prove", id: 3, circuit: "login", input: {} });
      await vi.waitFor(() => expect(replies).toHaveLength(2));
      expect(replies[1]).toMatchObject({ id: 3, ok: false, error: { message: expect.stringMatching(/integrity check failed/) } });
    } finally {
      close();
    }
  });
});

describe("worker entry", () => {
  it("does nothing when imported outside a worker, and serves inside one", async () => {
    const addEventListener = vi.fn();
    vi.resetModules();
    await import("../src/worker.js"); // Node's main thread: no worker globals
    vi.stubGlobal("postMessage", vi.fn());
    vi.stubGlobal("addEventListener", addEventListener);
    vi.stubGlobal("window", {}); // a page has both, and a window
    vi.resetModules();
    await import("../src/worker.js");
    expect(addEventListener).not.toHaveBeenCalled();
    vi.stubGlobal("window", undefined);
    vi.resetModules();
    await import("../src/worker.js");
    expect(addEventListener).toHaveBeenCalledWith("message", expect.any(Function));
  });
});
