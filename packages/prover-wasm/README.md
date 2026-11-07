# @ghostlink/prover-wasm

Device-side Groth16 prover for GhostLink. It downloads a circuit's WebAssembly witness generator and proving key once, checks them against the SHA-256 pins you give it, caches them, and runs snarkjs in the caller's context, so the identity secret never leaves the device. **V2 candidate: localnet only; not deployed.**

```ts
import { createProver } from "@ghostlink/prover-wasm";
import { GhostLink } from "@ghostlink/sdk";

const prover = createProver({
  login: {
    wasmUrl: "/circuits/login.wasm",
    zkeyUrl: "/circuits/login.zkey",
    wasmSha256: "<64 hex characters>", // pins: see below
    zkeySha256: "<64 hex characters>",
  },
  // owner: { ... }, only if this app proves owner actions
});

const client = await GhostLink.init({ cluster: "localnet", indexer: "http://127.0.0.1:8787", prover });
```

## Pin the artifacts in production

**Set `wasmSha256` and `zkeySha256` for every circuit you deploy.** They are optional so that development builds can change circuits freely, and **when a pin is missing the file is used unchecked**. The witness generator runs on the user's identity secret and the proving key shapes the proof, so whoever can change the files behind those URLs (a compromised host, CDN or cache) would otherwise change what runs on that secret.

- Compute the pins from the exact files you reviewed: `sha256sum login.wasm login.zkey`, or `Get-FileHash -Algorithm SHA256` on Windows.
- Ship the pins inside your application code. A pin downloaded from the same server as the file it protects protects nothing.
- A mismatch refuses to prove (`integrity check failed for <url>`). A malformed pin is refused before anything is downloaded.
- Downloads are cached per URL and pin, so an unchecked download is never reused where a pin is required. A failed download is retried on the next call.

## Login-only sites

`owner` is optional. Leave it out unless the app proves owner actions: `prove("owner", ...)` then fails with `no owner circuit artifacts configured` without downloading anything.

## Performance

Proving blocks the thread that runs it. Create the prover in a web worker where possible. The login proof took about 2.4 s in desktop Chromium; phones are not yet measured ([benchmarks](../../docs/benchmarks.md)).

Development networks only. Pins prove that you serve the files you reviewed, not that their setup was sound: this repository's circuit keys come from a single-party development setup, and production needs a public multi-party ceremony ([circuits](../../circuits/README.md), [threat model](../../docs/THREAT-MODEL.md)).
