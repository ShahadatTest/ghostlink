import { bytesToHex, relayerRequestDigest, type RelayerReceipt, type RelayerRequests, type RelayerRoute } from "@ghostlink/common";
import { unboundFetch } from "./transport.js";

export interface PreparedRelayerOperation<R extends RelayerRoute = RelayerRoute> {
  route: R; requestIdHex: string; digestHex: string; request: RelayerRequests[R];
}
/** Save this complete object in the caller's encrypted durable store BEFORE sending. Never regenerate it to retry. */
export function prepareRelayerOperation<R extends RelayerRoute>(route: R, request: RelayerRequests[R], requestIdHex?: string): PreparedRelayerOperation<R> {
  const digestHex = relayerRequestDigest(route, request);
  const id = requestIdHex ?? bytesToHex(globalThis.crypto.getRandomValues(new Uint8Array(32)));
  if (!/^[0-9a-f]{64}$/.test(id)) throw new Error("invalid relayer request ID");
  return { route, requestIdHex: id, digestHex, request: JSON.parse(JSON.stringify(request)) as RelayerRequests[R] };
}

/**
 * The stable machine-readable `code` of a relayer error response. Codes
 * are part of the API: messages may be reworded, codes are not. A response
 * without a code (from the HTTP layer, or an older relayer) is mapped from
 * its status: 400 `bad_request`, 403 `partner_only`, 404 `not_found`, 409
 * `request_conflict`, 413 `body_too_large`, 422 `simulation_failed`, 429
 * `rate_limited`, 500 `internal`, 503 `unavailable`, anything else `unknown`.
 */
export type RelayerErrorCode =
  | "bad_request" | "partner_only" | "not_found" | "request_conflict" | "body_too_large" | "simulation_failed"
  | "rate_limited" | "snapshot_cooldown" | "internal"
  | "draining" | "not_ready" | "budget_exhausted" | "reserve_unavailable" | "journal_full" | "simulation_unavailable"
  | "chain_unavailable" | "census_fee_unavailable" | "snapshot_fee_too_high" | "unavailable" | "unknown";

const RELAYER_ERROR_CODES: ReadonlySet<string> = new Set<RelayerErrorCode>([
  "bad_request", "partner_only", "not_found", "request_conflict", "body_too_large", "simulation_failed", "rate_limited",
  "snapshot_cooldown", "internal", "draining", "not_ready", "budget_exhausted", "reserve_unavailable", "journal_full",
  "simulation_unavailable", "chain_unavailable", "census_fee_unavailable", "snapshot_fee_too_high", "unavailable", "unknown",
]);
const STATUS_CODES: Readonly<Record<number, RelayerErrorCode>> = {
  400: "bad_request", 403: "partner_only", 404: "not_found", 409: "request_conflict", 413: "body_too_large",
  422: "simulation_failed", 429: "rate_limited", 500: "internal", 503: "unavailable",
};

interface RelayerHttpFailure { status: number; code: RelayerErrorCode; serverMessage: string }

async function httpFailure(response: Response): Promise<RelayerHttpFailure> {
  const body = await response.json().catch(() => null) as { error?: unknown; code?: unknown } | null;
  const code = typeof body?.code === "string" && RELAYER_ERROR_CODES.has(body.code) ? body.code as RelayerErrorCode
    : STATUS_CODES[response.status] ?? "unknown";
  const serverMessage = typeof body?.error === "string" ? body.error.slice(0, 500) : "";
  return { status: response.status, code, serverMessage };
}

/**
 * The relayer refused the request (HTTP 4xx): nothing was reserved or
 * sent. `code` says why. `rate_limited` and `snapshot_cooldown` succeed
 * later with the same operation; `simulation_failed` means the chain would
 * reject it (a stale proof or nonce, a spent registration); the others mean
 * the request itself must change.
 */
export class RelayerRequestError extends Error {
  readonly status: number;
  readonly code: RelayerErrorCode;
  /** The relayer's own message, for logs. Branch on `code`, not on this text. */
  readonly serverMessage: string;
  constructor(failure: RelayerHttpFailure, readonly operation?: PreparedRelayerOperation) {
    super(`relayer ${operation ? `refused ${operation.route}` : "request failed"}: HTTP ${failure.status} ${failure.code}` +
      (failure.serverMessage ? `: ${failure.serverMessage}` : ""));
    this.name = "RelayerRequestError";
    this.status = failure.status;
    this.code = failure.code;
    this.serverMessage = failure.serverMessage;
  }
}

/**
 * The outcome is unknown (transport failure, an unavailable relayer, a bad
 * receipt, or not yet confirmed): keep the operation and reconcile it with
 * `RelayerClient.settle`. When the relayer answered with an error, `status`,
 * `code` (for example `budget_exhausted` or `not_ready`) and `serverMessage`
 * say which.
 */
export class RelayerOperationPendingError extends Error {
  readonly status?: number;
  readonly code?: RelayerErrorCode;
  readonly serverMessage?: string;
  constructor(readonly operation: PreparedRelayerOperation, readonly receipt?: RelayerReceipt, failure?: RelayerHttpFailure) {
    super("Relayer operation is not confirmed; retain this operation and reconcile before retrying" +
      (failure ? ` (HTTP ${failure.status} ${failure.code})` : ""));
    this.name = "RelayerOperationPendingError";
    if (failure) { this.status = failure.status; this.code = failure.code; this.serverMessage = failure.serverMessage; }
  }
}

/**
 * The relayer reports a confirmed/finalized execution error for this exact
 * operation. Retrying it reuses the same request ID and saved transaction,
 * so it can only return the same failure: inspect `receipt`, fix the cause,
 * then prepare a new operation (for a session, a new authorization).
 */
export class RelayerOperationFailedError extends Error {
  constructor(readonly operation: PreparedRelayerOperation, readonly receipt: RelayerReceipt) {
    super("Relayer operation failed on-chain; resubmitting it returns the same failure, so prepare a new operation after fixing the cause");
    this.name = "RelayerOperationFailedError";
  }
}

export interface SettleOptions {
  /**
   * How long to keep reconciling a pending operation, in milliseconds.
   * Default 60 000. Zero submits once and never polls.
   */
  timeoutMs?: number;
  /** Delay between status checks; default 500 ms. */
  pollMs?: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Receipts are provider evidence; independently verify chain effects before granting bot authority. */
export class RelayerClient {
  readonly #fetch: typeof fetch;
  constructor(private readonly endpoint: string, fetchFn?: typeof fetch) {
    this.#fetch = unboundFetch(fetchFn);
  }
  #check(value: unknown, id: string): RelayerReceipt {
    const receipt = value as RelayerReceipt;
    if (!receipt || receipt.requestIdHex !== id || !["preparing", "pending", "confirmed", "finalized", "failed", "unknown"].includes(receipt.state)) throw new Error("invalid relayer receipt");
    if ((!['preparing', 'unknown'].includes(receipt.state) || receipt.signature !== undefined) &&
      (typeof receipt.signature !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(receipt.signature))) throw new Error("missing relayer transaction identity");
    if (["confirmed", "finalized", "failed"].includes(receipt.state) && (!Number.isSafeInteger(receipt.slot) || receipt.slot! < 0 ||
      !["confirmed", "finalized"].includes(receipt.confirmationStatus ?? ""))) throw new Error("missing relayer confirmation evidence");
    if (["confirmed", "finalized"].includes(receipt.state) && receipt.state !== receipt.confirmationStatus) throw new Error("inconsistent relayer confirmation evidence");
    return receipt;
  }
  /**
   * Sends the operation once and returns the relayer's receipt, which may
   * be pending. Throws `RelayerRequestError` for a refusal (HTTP 4xx) and
   * `RelayerOperationPendingError` when the outcome is unknown.
   */
  async submit(operation: PreparedRelayerOperation): Promise<RelayerReceipt> {
    if (!/^[0-9a-f]{64}$/.test(operation.requestIdHex) || relayerRequestDigest(operation.route, operation.request) !== operation.digestHex) throw new Error("relayer operation was mutated");
    // Snapshot mutable caller data before yielding so a later mutation cannot replace the submitted request.
    const saved = JSON.parse(JSON.stringify(operation)) as PreparedRelayerOperation;
    const id = saved.requestIdHex, url = `${this.endpoint}${saved.route}`;
    const body = JSON.stringify({ ...saved.request, requestIdHex: id });
    let response: Response;
    try { response = await this.#fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body }); }
    catch { throw new RelayerOperationPendingError(saved); }
    if (response.status >= 500 && response.status !== 502) throw new RelayerOperationPendingError(saved, undefined, await httpFailure(response));
    if (!response.ok && response.status !== 502) throw new RelayerRequestError(await httpFailure(response), saved);
    try { return this.#check(await response.json(), id); }
    catch { throw new RelayerOperationPendingError(saved); }
  }
  async status(requestIdHex: string): Promise<RelayerReceipt> {
    if (!/^[0-9a-f]{64}$/.test(requestIdHex)) throw new Error("invalid relayer request ID");
    const response = await this.#fetch(`${this.endpoint}/submissions/${requestIdHex}`);
    if (!response.ok) throw new RelayerRequestError(await httpFailure(response));
    return this.#check(await response.json(), requestIdHex);
  }
  /**
   * Submits the operation and reconciles it until it is confirmed or
   * finalized, it fails, or `timeoutMs` passes. Returns the confirmed
   * receipt. Throws `RelayerOperationFailedError` for a final on-chain
   * failure, `RelayerRequestError` for a refusal, and
   * `RelayerOperationPendingError` (keep `error.operation`, call `settle`
   * again later) when the deadline passes first. Safe to call again with
   * the same operation after a crash or a lost reply.
   */
  async settle(operation: PreparedRelayerOperation, options: SettleOptions = {}): Promise<RelayerReceipt> {
    const timeoutMs = options.timeoutMs ?? 60_000, pollMs = options.pollMs ?? 500;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || !Number.isFinite(pollMs) || pollMs < 0) throw new Error("invalid settle timing");
    const deadline = Date.now() + timeoutMs;
    let receipt = await this.submit(operation);
    while (!["confirmed", "finalized", "failed"].includes(receipt.state)) {
      if (Date.now() >= deadline) throw new RelayerOperationPendingError(operation, receipt);
      await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
      try {
        receipt = await this.status(operation.requestIdHex);
        // The original call may have saved a packet but lacked evidence to broadcast it.
        // Retry only this immutable request after reconciliation permits pending/preparing work.
        if (receipt.state === "pending" || receipt.state === "preparing") receipt = await this.submit(operation);
      } catch (error) {
        // An unavailable or rate-limiting relayer is an unknown outcome: keep polling until the deadline.
        const transient = error instanceof RelayerOperationPendingError ||
          (error instanceof RelayerRequestError && (error.status >= 500 || error.code === "rate_limited"));
        if (!transient) throw error;
        if (Date.now() >= deadline) throw error instanceof RelayerOperationPendingError ? error : new RelayerOperationPendingError(operation, receipt);
      }
    }
    if (receipt.state === "failed") throw new RelayerOperationFailedError(operation, receipt);
    return receipt;
  }
}
export type { RelayerReceipt, RelayerRoute, RelayerRequests };
