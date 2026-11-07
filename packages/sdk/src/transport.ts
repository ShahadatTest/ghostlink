/**
 * Internal (not exported from the package). Clients store fetch and call it
 * as `this.fetchFn(...)`, which passes the client as the receiver; the
 * browser's native fetch then throws "Illegal invocation". The wrapper
 * always invokes the supplied function without a receiver, which every
 * fetch implementation accepts.
 */
export function unboundFetch(fetchFn?: typeof fetch): typeof fetch {
  const call = fetchFn ?? globalThis.fetch.bind(globalThis);
  return ((input: RequestInfo | URL, init?: RequestInit) => call(input, init)) as typeof fetch;
}
