/**
 * HTTP surface of the indexer (wire shapes in @ghostlink/common api.ts).
 * Roots, paths, leaves, bindings and census snapshots cover completed
 * root-history buckets only (see store.ts): a leaf whose bucket has not
 * ended answers 404 with the slot after which to retry.
 */
import type { Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { HttpError, Router, decodeLogs, type GhostLinkEvent } from "@ghostlink/service-kit";
import type { IndexerStore, TreeKind } from "./store.js";
import type { PollerStatus } from "./poller.js";
import type { IndexerDatabase } from "./database.js";
import type { ChainRoots } from "./chain-roots.js";

export interface ServerOptions {
  /**
   * Shared secret a webhook poster must send in `authorization` (Helius:
   * the `authHeader` of the webhook). Without it POST /webhook is off.
   */
  webhookSecret?: string;
  /** When set, every tree event must be vouched for by the on-chain ring (`ChainRoots.accepts`). */
  chainRoots?: ChainRoots;
  poller?: PollerStatus;
  database?: IndexerDatabase;
  /** Hosted webhooks only wake the ordered poller; they never mutate checkpoint state. */
  onIngestionHint?: () => void;
}

export function buildServer(store: IndexerStore, options: ServerOptions = {}): Server & { drain(): void; readonly active: number } {
  // Webhook batches can be large; everything else is tiny.
  const router = new Router({ maxBodyBytes: 1024 * 1024 });
  let draining = false, active = 0;
  const ready = () => {
    const status = options.poller;
    const fresh = (value: string | null) => value !== null && Date.now() - Date.parse(value) >= 0 && Date.now() - Date.parse(value) < 30_000;
    // Refuse known catch-up before counting a potentially large spool on a public read.
    if (draining || !status || status.catchingUp || status.lastError !== null ||
      !fresh(status.lastSuccessAt) || !fresh(status.lastHeadAdvancedAt) ||
      (status.rootReconciliationRequired && (!status.rootsUsable || !fresh(status.rootsCheckedAt)))) return false;
    try { options.database?.assertOwned(); return Boolean(options.database); }
    catch { return false; } // Keep storage diagnostics private.
  };
  const requireReconciled = () => {
    if (options.poller?.rootReconciliationRequired && !ready()) throw new HttpError(503, "indexer is not ready; reconciled history and usable roots are required");
  };
  router.get("/ready", async () => {
    const available = ready(); return { status: available ? 200 : 503, json: { ready: available } };
  });

  router.get("/health", async () => ({
    json: {
      ok: !options.poller || options.poller.lastError === null,
      registryLeaves: store.registryLeaves.length,
      censusLeaves: store.censusLeaves.length,
      servedLeaves: { registry: store.completedSize("registry"), census: store.completedSize("census") },
      webhook: Boolean(options.webhookSecret),
      poller: options.poller ?? null,
    },
  }));

  router.get("/roots/:tree", async ({ params }) => {
    requireReconciled();
    const tree = treeName(params.tree);
    if (!tree) return { status: 404, json: { error: "unknown tree" } };
    return {
      json: { tree, roots: store.recentRoots(tree), nextIndex: store.completedSize(tree),
        completeBeforeSlot: String(store.completeBeforeSlot(tree)) },
    };
  });

  router.get("/path/:tree/:leafIndex", async ({ params }) => {
    requireReconciled();
    const tree = treeName(params.tree);
    if (!tree) return { status: 404, json: { error: "unknown tree" } };
    if (!/^(0|[1-9][0-9]{0,15})$/.test(params.leafIndex ?? "")) return { status: 400, json: { error: "bad leaf index" } };
    const index = Number(params.leafIndex);
    const pending = store.completesAfterSlot(tree, index);
    if (pending !== undefined) return notYetServed(pending);
    if (index >= store.completedSize(tree)) return { status: 404, json: { error: "no such leaf" } };
    const path = store.completedPath(tree, index);
    return {
      json: {
        tree,
        index: path.index,
        siblings: path.siblings.map((s) => s.toString()),
        root: path.root.toString(),
      },
    };
  });

  /**
   * A page of leaves in append order, so a client can rebuild the tree
   * and compute its own path without ever naming the leaf it wants.
   */
  router.get("/leaves/:tree", async ({ params, query }) => {
    requireReconciled();
    const tree = treeName(params.tree);
    if (!tree) return { status: 404, json: { error: "unknown tree" } };
    const leaves = tree === "registry" ? store.registryLeaves : store.censusLeaves;
    const served = store.completedSize(tree);
    const from = pageInteger(query.get("from"), 0, 0, Number.MAX_SAFE_INTEGER, "from");
    const limit = pageInteger(query.get("limit"), 5000, 1, 5000, "limit");
    return {
      json: { tree, from, leaves: leaves.slice(from, Math.min(from + limit, served)), nextIndex: served,
        completeBeforeSlot: String(store.completeBeforeSlot(tree)) },
    };
  });

  router.get("/registry/binding/:wallet", async ({ params }) => {
    requireReconciled();
    const binding = store.bindings.get(params.wallet ?? "");
    if (!binding) {
      const pending = store.pendingBinding(params.wallet ?? "");
      if (pending) return notYetServed(store.completesAfterSlot("registry", pending.leafIndex)!);
      return { status: 404, json: { error: "not registered" } };
    }
    return { json: { leafIndex: binding.leafIndex, commitment: binding.commitmentHex, slot: binding.slot } };
  });

  /** The newest snapshot a prover can use now, i.e. the newest of a completed bucket. */
  router.get("/census/latest", async ({ query }) => {
    requireReconciled();
    const wallet = query.get("wallet");
    const mint = query.get("mint");
    if (!wallet || !mint) return { status: 400, json: { error: "wallet and mint required" } };
    const entry = store.latestCensus.get(`${wallet}:${mint}`);
    if (!entry) {
      const pending = store.pendingSnapshot(`${wallet}:${mint}`);
      if (pending) return notYetServed(store.completesAfterSlot("census", pending.leafIndex)!);
      return { status: 404, json: { error: "no snapshot" } };
    }
    return { json: entry };
  });

  // ---- dashboard API -----------------------------------------------------

  router.get("/pockets/:appIdHex", async ({ params }) => {
    requireReconciled();
    const entry = store.pocketByAppId(params.appIdHex ?? "");
    if (!entry) return { status: 404, json: { error: "no pocket for this app id" } };
    return { json: entry };
  });

  router.get("/activity/:pocket", async ({ params, query }) => {
    requireReconciled();
    const limit = pageInteger(query.get("limit"), 50, 1, 200, "limit");
    return { json: { pocket: params.pocket, events: store.activityFor(params.pocket!, limit) } };
  });

  router.get("/stats", async () => {
    requireReconciled();
    return { json: {
      registrations: store.registryLeaves.length,
      snapshots: store.censusLeaves.length,
      pockets: store.pockets.size,
      activity: store.activity.length,
    } };
  });

  /**
   * Webhook ingestion: a Helius raw-transaction webhook array (each item
   * carrying `meta.logMessages`) or the shape { logs: string[] }. Needs
   * the shared secret, drops failed transactions, and — when the chain
   * is reachable — accepts a tree event only if its root is in the
   * program's own root ring. The store's chaining checks run after that.
   */
  router.post("/webhook", async ({ body, raw }) => {
    if (draining) throw new HttpError(503, "indexer is draining");
    active++;
    try {
      if (!options.webhookSecret) throw new HttpError(404, "webhook disabled: set WEBHOOK_SECRET");
      if (!authorized(raw.headers.authorization, options.webhookSecret)) {
        throw new HttpError(401, "bad webhook secret");
      }
      if (options.onIngestionHint) { options.onIngestionHint(); return { status: 202, json: { queued: true } }; }
      const batches: { logs: string[]; signature?: string }[] = [];
      const add = (logs: unknown, signature: unknown) => {
        if (!Array.isArray(logs) || !logs.every((line) => typeof line === "string")) throw new HttpError(400, "logs must be an array of strings");
        if (signature !== undefined && (typeof signature !== "string" || !signature || signature.length > 128)) {
          throw new HttpError(400, "invalid transaction signature");
        }
        batches.push({ logs, signature: signature as string | undefined });
      };
      if (Array.isArray(body)) {
        for (const item of body as { signature?: string; transaction?: { signatures?: string[] }; meta?: { err?: unknown; logMessages?: string[] } }[]) {
          if (item?.meta?.err) continue;
          if (Array.isArray(item?.meta?.logMessages)) add(item.meta.logMessages, item.signature ?? item.transaction?.signatures?.[0]);
        }
      } else if (body && typeof body === "object" && Array.isArray((body as { logs?: unknown }).logs)) {
        const item = body as { logs: unknown; signature?: unknown };
        add(item.logs, item.signature);
      } else {
        throw new HttpError(400, "expected a transaction array or { logs }");
      }
      let applied = 0;
      let ignored = 0;
      for (const { logs, signature } of batches) {
        const events = decodeLogs(logs);
        if (!signature && events.some((event) => event.kind !== "Registered" && event.kind !== "SnapshotTaken")) {
          throw new HttpError(400, "transaction signature required for pocket events");
        }
        let valid = true;
        for (const event of events) {
          if (options.chainRoots && !(await rootOnChain(options.chainRoots, event))) {
            valid = false;
            break;
          }
        }
        if (!valid) { ignored += events.length; continue; }
        const count = signature ? store.applyTransaction(signature, events) : events.filter((event) => store.apply(event)).length;
        applied += count;
        ignored += events.length - count;
      }
      return { json: { applied, ignored } };
    } finally { active--; }
  });

  const server = Object.assign(router.server(), { drain: () => { draining = true; } });
  return Object.defineProperty(server, "active", { get: () => active }) as Server & { drain(): void; readonly active: number };
}

function pageInteger(value: string | null, fallback: number, minimum: number, maximum: number, name: string): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new HttpError(400, `bad ${name}`);
  }
  return Math.min(parsed, maximum);
}

async function rootOnChain(chain: ChainRoots, event: GhostLinkEvent): Promise<boolean> {
  if (event.kind === "Registered") return chain.accepts("registry", event.root, event.leafIndex, event.slot);
  if (event.kind === "SnapshotTaken") return chain.accepts("census", event.root, event.leafIndex, event.slot);
  return true;
}

function treeName(value: string | undefined): TreeKind | null {
  return value === "registry" || value === "census" ? value : null;
}

/** 404 for a leaf the indexer holds whose root bucket has not ended yet. */
function notYetServed(completesAfterSlot: number) {
  return { status: 404, json: { error: "not yet in a completed root bucket; retry after the slot",
    completesAfterSlot: String(completesAfterSlot) } };
}

function authorized(header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const presented = header.startsWith("Bearer ") ? header.slice(7) : header;
  const a = Buffer.from(presented);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}
