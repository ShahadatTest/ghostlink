import { describe, expect, it, vi } from "vitest";
import { RelayerClient, RelayerOperationFailedError, RelayerOperationPendingError, RelayerRequestError, prepareRelayerOperation } from "../src/relayer.js";
import { relayerRequestDigest } from "@ghostlink/common";

const id = "01".repeat(32);
const operation = () => prepareRelayerOperation("/snapshot", { wallet: "wallet", holding: "holding" }, id);
describe("recoverable relayer operations", () => {
  it("snapshots the exact submitted operation before a network failure or caller mutation", async () => {
    const original = operation(); let reject!: (error: Error) => void;
    const transport = vi.fn(() => new Promise<Response>((_resolve, fail) => { reject = fail; }));
    const pending = new RelayerClient("https://relayer.test", transport).submit(original);
    original.request.holding = "different"; original.requestIdHex = "02".repeat(32);
    reject(new Error("SYNTHETIC_PROVIDER_SECRET"));
    const error = await pending.catch(error => error);
    expect(error).toBeInstanceOf(RelayerOperationPendingError);
    expect(error.operation).toEqual(operation()); expect(error.message).not.toContain("SYNTHETIC_PROVIDER_SECRET");
    expect(JSON.parse(transport.mock.calls[0]![1].body as string).requestIdHex).toBe(id);
  });
  it("refuses mutation before sending and preserves recovery data after invalid or substituted receipts", async () => {
    const send = vi.fn(async () => Response.json({ requestIdHex: "02".repeat(32), state: "confirmed", signature: "1".repeat(64), slot: 50, confirmationStatus: "confirmed" }));
    const client = new RelayerClient("https://relayer.test", send), changed = operation();
    changed.request.wallet = "different";
    await expect(client.submit(changed)).rejects.toThrow("mutated"); expect(send).not.toHaveBeenCalled();
    await expect(client.submit(operation())).rejects.toMatchObject({ operation: operation() });
    send.mockImplementation(async () => Response.json({ requestIdHex: id, state: "confirmed", signature: "1".repeat(64) } as any));
    await expect(client.submit(operation())).rejects.toBeInstanceOf(RelayerOperationPendingError);
  });
  it("returns pending and failed receipts without misreporting confirmation", async () => {
    const send = vi.fn(async () => Response.json({ requestIdHex: id, state: "pending", signature: "1".repeat(64) }, { status: 202 }));
    const client = new RelayerClient("https://relayer.test", send);
    expect((await client.submit(operation())).state).toBe("pending");
    send.mockImplementation(async () => Response.json({ requestIdHex: id, state: "failed", signature: "1".repeat(64), slot: 50, confirmationStatus: "finalized" }, { status: 502 }));
    expect((await client.submit(operation())).state).toBe("failed");
  });
  it("keeps exact JSON identity across serialization and distinguishes routes and changed bodies", () => {
    const original = operation();
    expect(relayerRequestDigest("/snapshot", { holding: "holding", wallet: "wallet", requestIdHex: id })).toBe(original.digestHex);
    expect(relayerRequestDigest("/register", original.request)).not.toBe(original.digestHex);
    expect(relayerRequestDigest("/snapshot", { ...original.request, holding: "different" })).not.toBe(original.digestHex);
    expect(() => relayerRequestDigest("/snapshot", { amount: 1n })).toThrow("JSON");
  });
});

describe("relayer errors and settlement", () => {
  const confirmed = { requestIdHex: id, state: "confirmed", signature: "1".repeat(64), slot: 50, confirmationStatus: "confirmed" };
  it("turns refusals into typed errors with the HTTP status, a stable code and the server's message", async () => {
    const send = vi.fn(async () => Response.json({ error: "that holding was snapshotted less than a minute ago", code: "snapshot_cooldown" }, { status: 429 }));
    const client = new RelayerClient("https://relayer.test", send);
    const refused = await client.submit(operation()).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(RelayerRequestError);
    expect(refused).toMatchObject({ status: 429, code: "snapshot_cooldown", serverMessage: "that holding was snapshotted less than a minute ago",
      operation: operation() });
    expect((refused as Error).message).toContain("HTTP 429 snapshot_cooldown");
    // A relayer (or HTTP layer) without codes still yields one, from the status.
    send.mockImplementation(async () => Response.json({ error: "rate limited" }, { status: 429 }));
    await expect(client.submit(operation())).rejects.toMatchObject({ code: "rate_limited" });
    send.mockImplementation(async () => new Response("nope", { status: 422 }));
    await expect(client.submit(operation())).rejects.toMatchObject({ code: "simulation_failed", serverMessage: "" });
    send.mockImplementation(async () => Response.json({ error: "x", code: "made_up" }, { status: 418 }));
    await expect(client.submit(operation())).rejects.toMatchObject({ code: "unknown", status: 418 });
    // 5xx keeps the operation pending and still says why.
    send.mockImplementation(async () => Response.json({ error: "relayer daily budget exhausted", code: "budget_exhausted" }, { status: 503 }));
    const pending = await client.submit(operation()).catch((e: unknown) => e);
    expect(pending).toBeInstanceOf(RelayerOperationPendingError);
    expect(pending).toMatchObject({ status: 503, code: "budget_exhausted", serverMessage: "relayer daily budget exhausted" });
    send.mockImplementation(async () => Response.json({ error: "submission not found", code: "not_found" }, { status: 404 }));
    await expect(client.status(id)).rejects.toMatchObject({ name: "RelayerRequestError", code: "not_found" });
  });

  it("settles a pending operation, retrying only the same request, until confirmed or the deadline", async () => {
    const replies = [Response.json({ requestIdHex: id, state: "preparing" }, { status: 202 }),
      Response.json({ error: "relayer busy; retain the original request", code: "not_ready" }, { status: 503 }),
      Response.json({ requestIdHex: id, state: "pending", signature: "1".repeat(64) }),
      Response.json({ requestIdHex: id, state: "pending", signature: "1".repeat(64) }, { status: 202 }),
      Response.json(confirmed)];
    const send = vi.fn(async () => replies.shift()!);
    const client = new RelayerClient("https://relayer.test", send);
    expect(await client.settle(operation(), { pollMs: 1 })).toMatchObject({ state: "confirmed" });
    const posts = send.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST");
    expect(posts.map(([, init]) => JSON.parse(String((init as RequestInit).body)).requestIdHex)).toEqual([id, id]);
    send.mockImplementation(async () => Response.json({ requestIdHex: id, state: "unknown" }, { status: 202 }));
    const late = await client.settle(operation(), { timeoutMs: 20, pollMs: 5 }).catch((e: unknown) => e);
    expect(late).toBeInstanceOf(RelayerOperationPendingError);
    expect((late as RelayerOperationPendingError).operation).toEqual(operation());
    send.mockImplementation(async () => Response.json({ ...confirmed, state: "failed", confirmationStatus: "finalized" }, { status: 502 }));
    await expect(client.settle(operation())).rejects.toBeInstanceOf(RelayerOperationFailedError);
    send.mockImplementation(async () => Response.json({ error: "bad", code: "bad_request" }, { status: 400 }));
    await expect(client.settle(operation())).rejects.toBeInstanceOf(RelayerRequestError);
  });
});
