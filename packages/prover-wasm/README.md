# @ghostlink/prover-wasm

Device-side Groth16 prover for GhostLink. It downloads a circuit's WebAssembly witness generator and proving key once, checks them against the SHA-256 pins you give it, caches them, and runs snarkjs, so the identity secret never leaves the device. **Experimental: there is no official public deployment yet; see [deployments](../../docs/DEPLOYMENTS.md).**

A login proof takes seconds. In a web page, prove in a Web Worker with `createWorkerProver` so the page stays responsive. `createProver` proves on the calling thread, for code that already runs in a worker of its own, or in Node.

```ts
import { createWorkerProver } from "@ghostlink/prover-wasm";
import { GhostLink } from "@ghostlink/sdk";

// The .wasm and .zkey files come from `bash scripts/build-circuits.sh` in the
// repository (circuits/build/). They are not published yet: host your own copies.
const prover = createWorkerProver({
  login: {
    wasmUrl: "/circuits/login.wasm",
    zkeyUrl: "/circuits/login.zkey",
    wasmSha256: "<64 hex characters>", // pins: see below
    zkeySha256: "<64 hex characters>",
  },
  // owner: { ... }, only if this app proves owner actions
  timeoutMs: 120_000, // optional
});

const client = await GhostLink.init({ cluster: "localnet", indexer: "http://127.0.0.1:8787", prover });
```

## Proving in a Web Worker

`createWorkerProver(config)` returns a prover that the SDK accepts like any other. The worker runs `createProver` itself, so pins, caching and error messages are the same on both paths.

- **Lazy and reused.** Nothing starts until the first proof, so creating the prover during server rendering is safe. One worker serves every proof and keeps the downloaded artifacts. Proofs run one at a time; later calls wait their turn.
- **Errors come back as errors.** A failed download, a pin mismatch (`integrity check failed for <url>`) or a snarkjs failure rejects `prove` with the original message and error name. If the worker script cannot load or the worker crashes, the proof rejects with `prover worker failed…` and the next proof starts a new worker.
- **Cancellation and timeouts.** `prove(circuit, input, { signal })` accepts an `AbortSignal`. `timeoutMs`, set on the prover or per proof, limits how long a proof may run once its worker starts it, downloads included; it rejects with a `TimeoutError`. snarkjs cannot be interrupted, so cancelling or timing out a running proof stops its worker. A queued proof is simply removed.
- **`terminate()`** stops the worker, rejects pending proofs and refuses later ones.
- **Early refusals.** An unknown circuit, a missing `owner` configuration or a malformed pin is refused before a worker starts or anything downloads.
- **Artifact URLs** are resolved against the page before they reach the worker, so relative URLs mean what they mean in the page.

### Bundlers

The worker entry is `@ghostlink/prover-wasm/worker` (`dist/worker.js`). By default `createWorkerProver` starts it with

```ts
new Worker(new URL("./worker.js", import.meta.url), { type: "module" })
```

written literally inside the package, the pattern bundlers recognise:

- **Vite** (production build, checked with Vite 7): emits the worker as its own file, which loads snarkjs as a further file of its own; the page's chunk contains no snarkjs. In `vite dev`, dependency pre-bundling moves the package's code away from `worker.js`; if the worker fails to load there, add `@ghostlink/prover-wasm` to `optimizeDeps.exclude` (inferred from how Vite pre-bundles, not tested here).
- **webpack 5, and so Next.js on webpack**: documented to handle this pattern; not tested here.
- **Anything else**, or to control the file yourself: pass `createWorker`. These were checked with Vite 7:

```ts
// A package URL inside new Worker(new URL(...)):
createWorkerProver({ login, createWorker: () => new Worker(new URL("@ghostlink/prover-wasm/worker", import.meta.url), { type: "module" }) });

// Vite's worker import:
import ProverWorker from "@ghostlink/prover-wasm/worker?worker";
createWorkerProver({ login, createWorker: () => new ProverWorker() });
```

Without a bundler that handles workers (esbuild, a CDN), build the worker into one self-contained file and serve it like any static asset:

```sh
esbuild node_modules/@ghostlink/prover-wasm/dist/worker.js --bundle --format=esm --conditions=browser --outfile=public/ghostlink-prover-worker.js
```

```ts
createWorkerProver({ login, createWorker: () => new Worker("/ghostlink-prover-worker.js", { type: "module" }) });
```

That file was checked with esbuild 0.28: it made a real login proof in a worker thread.

Inside the worker, snarkjs starts helper workers from `blob:` URLs when the browser supports workers inside workers, and proves on a single thread when it does not. A Content Security Policy must therefore allow `worker-src 'self' blob:`; blocking `blob:` workers can make proving fail rather than fall back.

Importing `@ghostlink/prover-wasm/worker` outside a dedicated worker (in a page, during server rendering, in Node) does nothing.

### Next.js

Create the prover in a client component (a file starting with `"use client"`). A prover holds functions, so it cannot be passed from a server component as a prop. Creating it at module level is fine: the worker starts only on the first proof, in the browser.

## Pin the artifacts in production

**Set `wasmSha256` and `zkeySha256` for every circuit you deploy.** They are optional so that development builds can change circuits freely, and **when a pin is missing the file is used unchecked**. The witness generator runs on the user's identity secret and the proving key shapes the proof, so whoever can change the files behind those URLs (a compromised host, CDN or cache) would otherwise change what runs on that secret.

- Compute the pins from the exact files you reviewed: `sha256sum login.wasm login.zkey`, or `Get-FileHash -Algorithm SHA256` on Windows.
- Ship the pins inside your application code. A pin downloaded from the same server as the file it protects protects nothing.
- A mismatch refuses to prove (`integrity check failed for <url>`). A malformed pin is refused before anything is downloaded.
- Downloads are cached per URL and pin, so an unchecked download is never reused where a pin is required. A failed download is retried on the next call.

## Login-only sites

`owner` is optional. Leave it out unless the app proves owner actions: `prove("owner", ...)` then fails with `no owner circuit artifacts configured` without downloading anything.

## Module format

ESM only: `"type": "module"` and an `exports` map with `types`, `import` and `default` conditions for `.` and `./worker`. Use `import`, or `await import()` from CommonJS. TypeScript finds the types with `moduleResolution` set to `NodeNext` or `Bundler`. snarkjs is imported on the first proof, not when the package loads, so importing the package on a server or into a page costs nothing until someone proves. `sideEffects` names only the worker entry, so bundlers can drop anything else that is unused but never `import "@ghostlink/prover-wasm/worker"`.

## Licensing of snarkjs

This package is Apache-2.0. It depends on [snarkjs](https://github.com/iden3/snarkjs) and its libraries, such as ffjavascript, which are GPL-3.0. A browser prover reaches users as JavaScript, so a site that uses this package distributes snarkjs to its visitors, and GPL-3.0's conditions for distributed code apply to that snarkjs code. With `createWorkerProver`, snarkjs is loaded only by the separate worker file, not by your page's own bundle (checked with a Vite 7 build: the page's chunk contains no snarkjs). That keeps the GPL-3.0 code a separable file you can identify and offer source for. Whether that is enough for your product is a legal question. See [LICENSING.md](../../LICENSING.md). This is a plain-language summary, not legal advice.

## Performance

The login proof took about 2.4 s in desktop Chromium; phones are not yet measured ([benchmarks](../../docs/benchmarks.md)).

Development networks only. Pins prove that you serve the files you reviewed, not that their setup was sound: this repository's circuit keys come from a single-party development setup, and production needs a public multi-party ceremony ([circuits](../../circuits/README.md), [threat model](../../docs/THREAT-MODEL.md)).
