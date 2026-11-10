# @ghostlink/react

React bindings for the [GhostLink SDK](../sdk/README.md): a provider that owns one GhostLink client and the signed-in session, a `useGhostLink` hook, and a drop-in `ContinueWithGhostLink` button. **Experimental: it runs on a local validator out of the box, and on other networks with your own [deployment](../../docs/DEPLOYMENTS.md); there is no official public deployment yet.**

```tsx
import { ContinueWithGhostLink, GhostLinkProvider, useGhostLink } from "@ghostlink/react";
import { createWorkerProver } from "@ghostlink/prover-wasm";
import type { GhostLink, GhostLinkSession } from "@ghostlink/sdk";

const config = {
  cluster: "localnet" as const,
  indexer: "http://127.0.0.1:8787",
  prover: createWorkerProver({ login: { wasmUrl, zkeyUrl, wasmSha256, zkeySha256 } }), // proves in a Web Worker
};

// Your login flow (loginParams and sendToBackend are your app's code): derive the identity
// (deriveIdentity) and gather its witness (client.witness), prove on the device, then send the
// proof with a session-signed server challenge to your backend, which checks both with
// @ghostlink/verify. The SDK guide shows each call.
async function signIn(client: GhostLink): Promise<GhostLinkSession> {
  const session = await client.prove(await loginParams(client));
  await sendToBackend(session);
  return session;
}

export function App() {
  return (
    <GhostLinkProvider config={config}>
      <ContinueWithGhostLink onLogin={signIn} />
      <Status />
    </GhostLinkProvider>
  );
}

function Status() {
  const { status, session } = useGhostLink();
  if (status === "proving") return <p>Proving on this device…</p>;
  return session ? <p>Signed in as {session.appIdBase58}</p> : null;
}
```

## API

`<GhostLinkProvider config={...}>` creates the client from `config` on first use. It reads `config` once: to change it, remount the provider with a new React `key`.

`useGhostLink()` returns:

- `client`: `null` until `ensureClient()` or the first login creates it.
- `ensureClient()`: creates the client (concurrent calls share one) and resolves with it. Call it from an effect when you need the client before the user signs in.
- `login(flow)`: runs your flow with the client. `status` is `"proving"` until it settles, and the session it resolves with becomes `session`. It rejects with the flow's error, which is also kept in `error`.
- `status`: `"idle"`, `"initializing"`, `"proving"`, `"ready"`, or `"error"` when the client failed to initialize (the next call retries).
- `session`, `setSession` and `error`.

`<ContinueWithGhostLink onLogin={flow} label? busyLabel? className? />` calls `login(onLogin)`, shows `busyLabel` (default "Proving…") while it runs, and shows any failure below itself.

While a login runs the button has `aria-busy="true"` and `aria-disabled="true"`, and presses are ignored, so a second click never starts another login. It does not use the `disabled` attribute, so keyboard focus stays on the button; style the busy state with `[aria-disabled="true"]` instead of `:disabled`.

`useGhostLink()` and the button throw when rendered outside a `GhostLinkProvider`.

The session, including its signing key, lives only in React state. Do not persist it.

## Next.js App Router and module format

The built entry starts with `"use client"`, so every export is a client component and you can import the package from a server component without a wrapper file. Props that cross from a server component to a client component must be serializable, though: `config` with a `prover`, and `onLogin`, are functions. Render `<GhostLinkProvider>` and `<ContinueWithGhostLink>` from a client component of your own when you pass them, which is the usual case. Nothing runs at import time, and the client is created on first use in the browser.

The example proves with `createWorkerProver` from [`@ghostlink/prover-wasm`](../prover-wasm/README.md), which runs in a Web Worker so the page stays responsive while a proof runs.

The package is ESM only: `"type": "module"` and an `exports` map with `types`, `import` and `default` conditions. TypeScript finds the types with `moduleResolution` set to `NodeNext` or `Bundler`. React 18 or later is a peer dependency, and the JSX compiles to `react/jsx-runtime`.

Development networks only. See the [SDK](../sdk/README.md), [`@ghostlink/prover-wasm`](../prover-wasm/README.md) and [`@ghostlink/verify`](../verify/README.md).
