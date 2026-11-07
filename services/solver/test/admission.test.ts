import { afterEach, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import { POCKET_PROGRAM_ID, bytesToHex, conservativePolicy, domainHash, fieldToBytes32, intentHash, policyHash } from "@ghostlink/common";
import { BorshWriter, POCKET, POCKET_ACCOUNT_SIZE, pocketPda, writePolicy } from "@ghostlink/service-kit";
import { buildServer, MockPlanner } from "../src/server.js";
import { SubmissionJournal } from "../src/journal.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

it("charges a pocket's request quota only for intents its current session authorized", async () => {
  let slot = 100;
  const genesis = Keypair.generate().publicKey.toBase58(), solver = Keypair.generate(), session = Keypair.generate();
  const policy = conservativePolicy(), appId = fieldToBytes32(23n), pocket = pocketPda(appId);
  const account = () => {
    const w = new BorshWriter().fixed(createHash("sha256").update("account:PocketV3").digest().subarray(0, 8))
      .fixed(appId).fixed(fieldToBytes32(domainHash("https://bot.example.com"))).fixed(solver.publicKey.toBytes())
      .u8(0).fixed(Buffer.concat([session.publicKey.toBuffer(), Buffer.alloc(1)])).u64(100_000n);
    writePolicy(w, policy); w.u8(0).u64(0n).u64(0n);
    w.fixed(new Uint8Array(256)).u8(PublicKey.findProgramAddressSync([Buffer.from("pocket"), Buffer.from(appId)], POCKET)[1])
      .u64(100_000n).u64(0n).u64(0n);
    const data = Buffer.alloc(POCKET_ACCOUNT_SIZE); data.set(w.out());
    return { data, owner: POCKET, executable: false, lamports: 1 };
  };
  const connection = {
    getGenesisHash: vi.fn(async () => genesis),
    getBalanceAndContext: vi.fn(async () => ({ context: { slot: ++slot }, value: 10_000_000 })),
    getSlot: vi.fn(async () => slot),
    getAccountInfoAndContext: vi.fn(async () => ({ context: { slot }, value: account() })),
  };
  const dir = mkdtempSync(join(tmpdir(), "ghostlink-solver-admission-")), key = randomBytes(32);
  const journal = new SubmissionJournal(join(dir, "journal.sqlite"), key,
    { genesisHash: genesis, solver: solver.publicKey.toBase58(), pocketProgram: POCKET_PROGRAM_ID });
  cleanups.push(() => { journal.close(); key.fill(0); rmSync(dir, { recursive: true, force: true }); });
  const server = buildServer({ connection: connection as unknown as Connection, journal, keypair: solver, planner: new MockPlanner(), priceAccounts: {} });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  cleanups.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  await server.operations.refresh(); await server.operations.refresh();
  expect(server.operations.snapshot().ready).toBe(true);
  const { port } = server.address() as { port: number };
  const intent = (signer: Keypair, nonce: bigint) => {
    const value = { pocket: pocket.toBytes(), nonce, inMint: randomBytes(32), inMax: 10n, outMint: randomBytes(32), outMin: 9n,
      deadlineSlot: 50_000n, policyHash: policyHash(policy) };
    return { pocket: pocket.toBase58(), nonce: nonce.toString(), inMint: bs58.encode(value.inMint), inMax: "10", outMint: bs58.encode(value.outMint),
      outMin: "9", deadlineSlot: "50000", policyHashHex: bytesToHex(value.policyHash), sessionKind: 0,
      sessionKeyHex: bytesToHex(signer.publicKey.toBytes()), signatureHex: bytesToHex(ed25519.sign(intentHash(value), signer.secretKey.subarray(0, 32))) };
  };
  const post = (body: unknown) => fetch(`http://127.0.0.1:${port}/intent`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  // Validly signed by a key of the caller's choosing, naming someone else's pocket.
  const attacker = Keypair.generate();
  for (let i = 0; i < 12; i++) expect((await post(intent(attacker, BigInt(i)))).status).toBe(403);
  expect(journal.authorizationSlot(pocket.toBase58())).toBe(0);
  // The real session keeps its full quota of 10 per minute. These authorized intents are then refused as unpriced.
  for (let i = 0; i < 10; i++) expect((await post(intent(session, BigInt(100 + i)))).status).toBe(400);
  expect(journal.authorizationSlot(pocket.toBase58())).toBeGreaterThan(100);
  expect((await post(intent(session, 200n))).status).toBe(429);
});
