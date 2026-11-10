/**
 * The worker entry: `new Worker(new URL("./worker.js", import.meta.url), { type: "module" })`.
 * It proves with `createProver` off the page's main thread and answers
 * `createWorkerProver`. It serves only inside a dedicated worker; imported
 * anywhere else (a page, a server render, a test) it does nothing.
 */
import { serveProver, type ProverWorkerScope } from "./protocol.js";

const scope = globalThis as Partial<ProverWorkerScope> & { window?: unknown };
if (scope.window === undefined && typeof scope.postMessage === "function" && typeof scope.addEventListener === "function") {
  serveProver(scope as ProverWorkerScope);
}
