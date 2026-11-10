import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { RelayerJournal } from "../src/journal.js";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, type VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { POCKET_ACCOUNT_SIZE, POCKET, CENSUS, REGISTRY, censusConfigPda } from "@ghostlink/service-kit";
import { readFileSync, readdirSync } from "node:fs";
import { buildServer, relayerErrorCode, type RelayerDeps } from "../src/server.js";

const payer = Keypair.generate();
const genesisHash = Keypair.generate().publicKey.toBase58();
/** The census config account: discriminator, fee u64, bump. */
function censusConfig(fee: bigint) {
  const data = Buffer.alloc(17);
  createHash("sha256").update("account:Config").digest().copy(data, 0, 0, 8);
  data.writeBigUInt64LE(fee, 8);
  return { owner: CENSUS, data, executable: false, lamports: 1_000_000 };
}
function rpc(balance = 1_000_000_000, initialSnapshotFee = 0n) {
  let slot = 48, simulationError: unknown = null, snapshotFee = initialSnapshotFee;
  const accepted = new Set<string>();
  return {
    failSimulation: (error: unknown) => { simulationError = error; },
    setSnapshotFee: (fee: bigint) => { snapshotFee = fee; },
    getBalanceAndContext: vi.fn(async () => ({ context: { slot: ++slot }, value: balance })),
    getGenesisHash: vi.fn(async () => genesisHash),
    getBlockHeight: vi.fn(async () => 50),
    getSignatureStatuses: vi.fn(async (ids: string[]) => ({ context: { slot }, value: ids.map(id => accepted.has(id) ? { slot, confirmationStatus: "confirmed", err: null } : null) })),
    getAccountInfo: vi.fn(async (address: PublicKey): Promise<unknown> => address.equals(censusConfigPda()) ? censusConfig(snapshotFee)
      : { owner: SystemProgram.programId, data: Buffer.alloc(0), executable: false }),
    getLatestBlockhashAndContext: vi.fn(async () => ({ context: { slot }, value: { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 } })),
    getFeeForMessage: vi.fn(async () => ({ context: { slot }, value: 10_000 })),
    getMinimumBalanceForRentExemption: vi.fn(async () => 30_000_000),
    simulateTransaction: vi.fn(async (_tx: VersionedTransaction, _config?: Record<string, unknown>) =>
      ({ context: { slot }, value: { err: simulationError, logs: ["SYNTHETIC_PROVIDER_LOG"], unitsConsumed: 1000 } })),
    sendRawTransaction: vi.fn(async (bytes: Uint8Array) => { const signature = bs58.encode(Transaction.from(bytes).signature!); accepted.add(signature); return signature; }),
    confirmTransaction: vi.fn(async () => ({ value: { err: null } })),
  };
}
async function withServer(deps: Partial<RelayerDeps> & { dailyBudgetLamports?: bigint }, run: (base: string, server: ReturnType<typeof buildServer>) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "relayer-http-"));
  const journal = new RelayerJournal(join(dir, "journal.db"), randomBytes(32), { genesisHash, payer: payer.publicKey.toBase58(), pocket: POCKET.toBase58(), registry: REGISTRY.toBase58(), census: CENSUS.toBase58() }, deps.dailyBudgetLamports);
  const server = buildServer({ connection: rpc() as unknown as Connection, payer, journal, ...deps });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  await server.operations.refresh(); await server.operations.refresh();
  const address = server.address() as { port: number };
  try { await run(`http://127.0.0.1:${address.port}`, server); }
  finally { server.drain(); await server.operations.refresh(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); journal.close(); rmSync(dir, { recursive: true, force: true }); }
}
async function spent(base: string, server: ReturnType<typeof buildServer>) {
  await server.operations.refresh();
  return (await (await fetch(`${base}/health`)).json()).spentLamports24h;
}
function post(base: string, path: string, body: unknown) {
  return fetch(`${base}/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
const snapshot = () => ({ requestIdHex: randomBytes(32).toString("hex"), wallet: Keypair.generate().publicKey.toBase58(), holding: payer.publicKey.toBase58() });
const opening = () => ({
  appIdHex: "01".repeat(32), domainHashHex: "02".repeat(32), sessionKind: 0,
  proofAHex: "00".repeat(64), proofBHex: "00".repeat(128), proofCHex: "00".repeat(64),
  registryRootHex: "00".repeat(32), censusRootHex: "00".repeat(32),
  mint: payer.publicKey.toBase58(), threshold: "0", minSlot: "0", claimHoldings: false,
  sessionKeyHex: "03".repeat(33), sessionExpirySlot: "100", home: payer.publicKey.toBase58(),
  policy: { dailyCapUsdE6: "100", bigActionThresholdUsdE6: "10", noOracleCapUsdE6: "0", sessionMaxSlots: "100",
    maxSlippageBps: 0, allowedOutMints: [], oracleFeeds: [] },
});

describe("relayer fee and creation boundary", () => {
  it("checks actual quoted costs atomically even while cached readiness is still healthy", async () => {
    const connection = rpc(50_010_000);
    await withServer({ connection: connection as unknown as Connection }, async (base, server) => {
      expect(server.operations.snapshot().ready).toBe(true);
      const responses = await Promise.all([post(base, "snapshot", snapshot()), post(base, "snapshot", snapshot())]);
      expect(responses.map(r => r.status).sort()).toEqual([200, 503]);
      expect(connection.sendRawTransaction).toHaveBeenCalledTimes(1);
      await server.operations.refresh();
      expect(server.operations.snapshot().checks.feeReserve).toBe(true); // Exactly the floor remains; another fee still fails atomically.
      expect((await post(base, "snapshot", snapshot())).status).toBe(503);
    });
  });
  it("serves cached liveness and readiness without RPC probes or journal scans per HTTP poll", async () => {
    const connection = rpc();
    await withServer({ connection: connection as unknown as Connection }, async (base, server) => {
      const calls = connection.getBalanceAndContext.mock.calls.length;
      const polls = await Promise.all(Array.from({ length: 20 }, (_, i) => fetch(`${base}/${i % 2 ? "health" : "ready"}`)));
      expect(polls.every(p => p.status === 200)).toBe(true);
      expect(connection.getBalanceAndContext).toHaveBeenCalledTimes(calls);
      expect((await fetch(`${base}/ready`)).headers.get("cache-control")).toBe("no-store");
    });
  });
  it("keeps original packet reconciliation available while new admission fails", async () => {
    const connection = rpc();
    await withServer({ connection: connection as unknown as Connection }, async (base, server) => {
      const body = snapshot();
      const first = await (await post(base, "snapshot", body)).json();
      connection.getBalanceAndContext.mockResolvedValue({ context: { slot: 100 }, value: 1 });
      await server.operations.refresh();
      expect((await fetch(`${base}/ready`)).status).toBe(503);
      expect((await post(base, "snapshot", snapshot())).status).toBe(503);
      expect((await post(base, "snapshot", body)).status).toBe(200);
      expect((await (await fetch(`${base}/submissions/${body.requestIdHex}`)).json()).signature).toBe(first.signature);
      expect(connection.sendRawTransaction).toHaveBeenCalledTimes(1);
    });
  });
  it("refuses new paid work when the payer cannot fund the quoted cost and operational reserve", async () => {
    const connection = rpc(1);
    await withServer({ connection: connection as unknown as Connection }, async (base, server) => {
      expect(server.operations.snapshot().checks).toMatchObject({ chainProgress: true, feeReserve: false });
      expect((await post(base, "open-session", opening())).status).toBe(503);
      expect(connection.sendRawTransaction).not.toHaveBeenCalled();
    });
  });
  it("keeps one paid transaction when an opening is retried after a lost send reply", async () => {
    const connection = rpc();
    connection.sendRawTransaction.mockRejectedValue(new Error("accepted response lost"));
    await withServer({ connection: connection as unknown as Connection }, async (base, server) => {
      const body = opening();
      await post(base, "open-session", body); await post(base, "open-session", body);
      expect(new Set(connection.sendRawTransaction.mock.calls.map(call => Buffer.from(call[0]).toString("base64"))).size).toBe(1);
    });
  });
  it("reserves current-layout quoted rent before funding pocket creation", async () => {
    const connection = rpc();
    await withServer({ connection: connection as unknown as Connection, dailyBudgetLamports: 20_000_000n }, async (base, server) => {
      expect((await post(base, "open-session", opening())).status).toBe(503);
      expect(connection.getMinimumBalanceForRentExemption).toHaveBeenCalledWith(POCKET_ACCOUNT_SIZE, "confirmed");
      expect(connection.sendRawTransaction).not.toHaveBeenCalled();
      expect(await spent(base, server)).toBe("0");
      connection.getMinimumBalanceForRentExemption.mockResolvedValueOnce(19_990_000);
      expect((await post(base, "open-session", opening())).status).toBe(200);
      expect(await spent(base, server)).toBe("20000000");
    });
  });

  it("never echoes provider broadcast/confirmation diagnostics and keeps uncertain sends charged", async () => {
    const marker = "SYNTHETIC_RELAYER_PROVIDER_SECRET";
    const connection = rpc();
    connection.sendRawTransaction.mockRejectedValueOnce(new Error(`provider ${marker}`));
    connection.sendRawTransaction.mockRejectedValue(new Error(`provider ${marker}`));
    await withServer({ connection: connection as unknown as Connection }, async (base, server) => {
      for (let i = 0; i < 3; i++) {
        const response = await post(base, "snapshot", snapshot());
        expect(response.status).toBe(202);
        const body = await response.text();
        expect(body).not.toContain(marker);
        const signature = bs58.encode(Transaction.from(connection.sendRawTransaction.mock.calls[i]![0]).signature!);
        expect(body).toContain(signature);
      }
      expect(await spent(base, server)).toBe("30000");
    });
  });

  it("does not confirm a provider-substituted transaction signature", async () => {
    const connection = rpc();
    const substituted = bs58.encode(new Uint8Array(64).fill(7));
    connection.sendRawTransaction.mockResolvedValueOnce(substituted);
    await withServer({ connection: connection as unknown as Connection }, async (base, server) => {
      const response = await post(base, "snapshot", snapshot());
      expect(response.status).toBe(202);
      const body = await response.text();
      const expected = bs58.encode(Transaction.from(connection.sendRawTransaction.mock.calls[0]![0]).signature!);
      expect(body).toContain(expected);
      expect(body).not.toContain(substituted);
      expect(connection.confirmTransaction).not.toHaveBeenCalled();
      expect(await spent(base, server)).toBe("10000");
    });
  });

  it("does not let a prefunded system PDA bypass the partner allowlist", async () => {
    const connection = rpc();
    await withServer({ connection: connection as unknown as Connection, allowedDomainHashes: new Set() }, async (base, server) => {
      const response = await post(base, "open-session", { appIdHex: "01".repeat(32), domainHashHex: "02".repeat(32), sessionKind: 0 });
      expect(response.status).toBe(403);
      expect(connection.sendRawTransaction).not.toHaveBeenCalled();
    });
  });

  it("charges the actual quoted fee atomically so concurrent requests cannot exceed the budget", async () => {
    const connection = rpc();
    await withServer({ connection: connection as unknown as Connection, dailyBudgetLamports: 10_000n }, async (base, server) => {
      const responses = await Promise.all([post(base, "snapshot", snapshot()), post(base, "snapshot", snapshot())]);
      expect(responses.map((r) => r.status).sort()).toEqual([200, 503]);
      expect(connection.sendRawTransaction).toHaveBeenCalledTimes(1);
      expect(await spent(base, server)).toBe("10000");
    });
  });

  it("keeps an ambiguous broadcast charged, but does not charge a preparation failure", async () => {
    const connection = rpc();
    connection.getLatestBlockhashAndContext.mockRejectedValueOnce(new Error("RPC unavailable"));
    connection.sendRawTransaction.mockRejectedValueOnce(new Error("response lost after broadcast"));
    await withServer({ connection: connection as unknown as Connection, dailyBudgetLamports: 10_000n }, async (base, server) => {
      expect((await post(base, "snapshot", snapshot())).status).toBe(500);
      expect(await spent(base, server)).toBe("0");
      expect((await post(base, "snapshot", snapshot())).status).toBe(202);
      expect((await post(base, "snapshot", snapshot())).status).toBe(503);
      expect(connection.sendRawTransaction).toHaveBeenCalledTimes(1);
    });
  });

  it("refuses changed request content, oversized fees and new admission during drain", async () => {
    const connection = rpc();
    await withServer({ connection: connection as unknown as Connection }, async (base, server) => {
      const body = snapshot();
      expect((await post(base, "snapshot", body)).status).toBe(200);
      expect((await post(base, "snapshot", { ...body, holding: Keypair.generate().publicKey.toBase58() })).status).toBe(409);
      expect((await post(base, "snapshot", body)).status).toBe(200);
      expect(connection.sendRawTransaction).toHaveBeenCalledTimes(1);
      connection.getFeeForMessage.mockResolvedValueOnce({ context: { slot: 999 }, value: 20_001 });
      expect((await post(base, "snapshot", snapshot())).status).toBe(503);
      server.drain();
      expect((await post(base, "snapshot", snapshot())).status).toBe(503);
      expect((await fetch(`${base}/submissions/${body.requestIdHex}`)).status).toBe(503);
      expect(server.active).toBe(0);
      expect(connection.sendRawTransaction).toHaveBeenCalledTimes(1);
    });
  });

  it("simulates before reserving, so invalid proofs cannot exhaust the budget or leave unsettled records", async () => {
    const connection = rpc();
    connection.failSimulation({ InstructionError: [1, { Custom: 6000 }] });
    // A single pocket creation (rent plus fee) uses this whole budget; refused simulations must not count.
    await withServer({ connection: connection as unknown as Connection, dailyBudgetLamports: 30_010_000n }, async (base, server) => {
      for (let i = 0; i < 5; i++) {
        const body = { ...opening(), appIdHex: randomBytes(32).toString("hex"), requestIdHex: randomBytes(32).toString("hex") };
        const response = await post(base, "open-session", body);
        expect(response.status).toBe(422);
        expect(await response.text()).not.toContain("SYNTHETIC_PROVIDER_LOG");
        expect((await fetch(`${base}/submissions/${body.requestIdHex}`)).status).toBe(404);
      }
      expect(connection.sendRawTransaction).not.toHaveBeenCalled();
      expect(await spent(base, server)).toBe("0");
      expect(server.operations.snapshot()).toMatchObject({ retainedRecords: 0, unsettledLamports: "0" });
      const [refused, config] = connection.simulateTransaction.mock.calls[0]!;
      // The provider never receives a broadcastable transaction before its journal record exists.
      expect(config).toMatchObject({ sigVerify: false, replaceRecentBlockhash: false, commitment: "confirmed" });
      expect(refused.signatures.every(signature => signature.every(byte => byte === 0))).toBe(true);
      connection.failSimulation(null);
      expect((await post(base, "open-session", opening())).status).toBe(200);
      const [simulated] = connection.simulateTransaction.mock.calls.at(-1)!;
      const sent = Transaction.from(connection.sendRawTransaction.mock.calls[0]![0]);
      expect(Buffer.from(simulated.message.serialize()).equals(sent.serializeMessage())).toBe(true);
      expect(await spent(base, server)).toBe("30010000");
    });
  });

  it("reserves nothing when simulation evidence is unavailable or stale, and the same request can retry", async () => {
    const connection = rpc();
    await withServer({ connection: connection as unknown as Connection }, async (base, server) => {
      const body = { ...opening(), requestIdHex: randomBytes(32).toString("hex") };
      connection.simulateTransaction.mockRejectedValueOnce(new Error("SYNTHETIC_PROVIDER_SECRET"));
      const unavailable = await post(base, "open-session", body);
      expect(unavailable.status).toBe(503); expect(await unavailable.text()).not.toContain("SYNTHETIC_PROVIDER_SECRET");
      connection.simulateTransaction.mockResolvedValueOnce({ context: { slot: 1 }, value: { err: null, logs: [], unitsConsumed: 1 } });
      expect((await post(base, "open-session", body)).status).toBe(503);
      expect((await fetch(`${base}/submissions/${body.requestIdHex}`)).status).toBe(404);
      expect(connection.sendRawTransaction).not.toHaveBeenCalled();
      expect(await spent(base, server)).toBe("0");
      expect((await post(base, "open-session", body)).status).toBe(200);
      expect(connection.sendRawTransaction).toHaveBeenCalledOnce();
    });
  });

  it("pays and budgets the census fee it read, and refuses a fee above its limit", async () => {
    const connection = rpc(1_000_000_000, 100_000n);
    await withServer({ connection: connection as unknown as Connection, maxSnapshotFeeLamports: 100_000n }, async (base, server) => {
      expect((await post(base, "snapshot", snapshot())).status).toBe(200);
      expect(await spent(base, server)).toBe("110000"); // network fee plus census fee
      const sent = Transaction.from(connection.sendRawTransaction.mock.calls[0]![0]);
      expect(sent.instructions).toHaveLength(1); // a snapshot transaction holds nothing else
      expect(sent.instructions[0]!.programId.equals(CENSUS)).toBe(true);
      expect(sent.instructions[0]!.data.subarray(8).readBigUInt64LE(0)).toBe(100_000n); // the fee read is the maximum paid
      connection.setSnapshotFee(100_001n);
      expect((await post(base, "snapshot", snapshot())).status).toBe(503);
      connection.getAccountInfo.mockResolvedValueOnce(null);
      expect((await post(base, "snapshot", snapshot())).status).toBe(503);
      expect(connection.sendRawTransaction).toHaveBeenCalledTimes(1);
      expect(await spent(base, server)).toBe("110000");
    });
  });

  it("rejects malformed bodies with a client error before any paid operation", async () => {
    await withServer({}, async (base, server) => {
      for (const path of ["snapshot", "register", "open-session", "owner-action"]) {
        expect((await post(base, path, null)).status).toBe(400);
      }
    });
  });

  it("answers every refusal with its message and a stable code", async () => {
    const connection = rpc(1_000_000_000, 100_000n);
    await withServer({ connection: connection as unknown as Connection, maxSnapshotFeeLamports: 100_000n, allowedDomainHashes: new Set() },
      async (base, server) => {
        const body = async (response: Response) => ({ status: response.status, ...(await response.json()) });
        expect(await body(await post(base, "snapshot", null))).toEqual({ status: 400, error: "expected a JSON object", code: "bad_request" });
        expect(await body(await post(base, "open-session", { ...opening(), requestIdHex: randomBytes(32).toString("hex") })))
          .toEqual({ status: 403, error: "this relayer only creates pockets for its partner apps", code: "partner_only" });
        const first = snapshot();
        expect((await post(base, "snapshot", first)).status).toBe(200);
        expect(await body(await post(base, "snapshot", { ...first, holding: Keypair.generate().publicKey.toBase58() })))
          .toEqual({ status: 409, error: "request ID is bound to different content", code: "request_conflict" });
        expect(await body(await post(base, "snapshot", { ...snapshot(), wallet: first.wallet })))
          .toEqual({ status: 429, error: "that holding was snapshotted less than a minute ago", code: "snapshot_cooldown" });
        connection.setSnapshotFee(100_001n);
        expect(await body(await post(base, "snapshot", snapshot())))
          .toEqual({ status: 503, error: "census snapshot fee exceeds this relayer's limit", code: "snapshot_fee_too_high" });
        connection.setSnapshotFee(100_000n);
        connection.failSimulation({ InstructionError: [0, "Custom"] });
        expect(await body(await post(base, "snapshot", snapshot())))
          .toEqual({ status: 422, error: "transaction failed simulation; nothing was reserved or broadcast", code: "simulation_failed" });
        expect(await body(await fetch(`${base}/submissions/${"ab".repeat(32)}`)))
          .toEqual({ status: 404, error: "submission not found", code: "not_found" });
        server.drain();
        expect(await body(await post(base, "snapshot", snapshot()))).toEqual({ status: 503, error: "relayer is draining", code: "draining" });
      });
  });

  it("gives every fixed refusal message in the relayer sources a specific code", () => {
    const dir = new URL("../src/", import.meta.url);
    const thrown = readdirSync(dir).filter(name => name.endsWith(".ts")).flatMap(name =>
      [...readFileSync(new URL(name, dir), "utf8").matchAll(/new HttpError\((\d{3}), "([^"]+)"\)/g)].map(m => [Number(m[1]), m[2]!] as const));
    expect(thrown.length).toBeGreaterThan(15);
    for (const [status, message] of thrown) {
      const code = relayerErrorCode(status, message);
      expect(code, `${status} ${message}`).toMatch(/^[a-z_]+$/);
      // A 503 or 429 must say which one: clients act differently on budget, cooldown or readiness.
      if (status === 503 || status === 429) expect(code, message).not.toBe(status === 503 ? "unavailable" : "unknown");
    }
    expect(relayerErrorCode(400, "walletPubkey required")).toBe("bad_request");
    expect(relayerErrorCode(418, "teapot")).toBe("unknown");
  });
});
