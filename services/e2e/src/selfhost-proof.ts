/**
 * The self-hosting proof's client (run by scripts/selfhost-proof.sh). The five
 * services run as separate processes started by scripts/selfhost.sh; this
 * talks to them only through their public HTTP APIs, and to the validator
 * only to set up a wallet and check chain effects:
 *
 *   1. every service answers /ready
 *   2. a fresh wallet registers through the relayer (POST /register, sent
 *      by the SDK's `register`)
 *   3. the relayer takes a census snapshot of the wallet's token account
 *      (POST /snapshot, sent by the SDK's `snapshot`) and the census fee
 *      vault gains exactly the fee
 *   4. the indexer serves the wallet's binding and its snapshot once their
 *      root buckets end and the history is finalized
 *
 * Disposable localnet only: a loopback RPC, a localnet deployment and
 * generated keys. Environment: RPC_URL, INDEXER_URL, RELAYER_URL, SOLVER_URL,
 * ACTIONS_URL, WATCHER_URL and GHOSTLINK_DEPLOYMENT.
 */
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, type TransactionInstruction } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import { assertDeploymentGenesis, bytesToHex, fieldToBytes32 } from "@ghostlink/common";
import { GhostLink, deriveIdentity, jsonRpcChainReader } from "@ghostlink/sdk";
import {
  DEPLOYMENT, ataAddress, censusConfigPda, censusFeeVaultPda, createAtaIdempotentIx, initializeMint2Ix, mintToIx,
  readCensusFee,
} from "@ghostlink/service-kit";

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ok = (step: string) => console.log(`✓ ${step}`);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function loopback(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(value).hostname)) throw new Error(`${name} must be a loopback URL`);
  return value.replace(/\/$/, "");
}

async function main() {
  const rpc = loopback("RPC_URL");
  const urls = Object.fromEntries(["INDEXER", "RELAYER", "SOLVER", "ACTIONS", "WATCHER"].map(name => [name, loopback(`${name}_URL`)]));
  if (DEPLOYMENT.cluster !== "localnet") throw new Error("the self-hosting proof runs only a localnet deployment");
  const connection = new Connection(rpc, "confirmed");
  assertDeploymentGenesis(DEPLOYMENT, await connection.getGenesisHash());

  // The indexer answers 503 for the length of each poll's scan, so allow a few retries.
  for (const [name, url] of Object.entries(urls)) {
    const deadline = Date.now() + 30_000;
    let response = await fetch(`${url}/ready`);
    while (response.status !== 200 && Date.now() < deadline) { await sleep(700); response = await fetch(`${url}/ready`); }
    if (response.status !== 200) throw new Error(`${name.toLowerCase()} is not ready: HTTP ${response.status} ${await response.text()}`);
  }
  ok("indexer, relayer, solver, Actions and watcher answer /ready as separate processes");

  // ---- a fresh wallet holding a token -------------------------------------
  const payer = Keypair.generate(), wallet = Keypair.generate(), mint = Keypair.generate();
  for (const [key, lamports] of [[payer, 2_000_000_000], [wallet, 100_000_000]] as const) {
    const signature = await connection.requestAirdrop(key.publicKey, lamports);
    const status = await connection.confirmTransaction(signature, "confirmed");
    if (status.value.err) throw new Error("airdrop failed");
  }
  const send = async (instructions: TransactionInstruction[], signers: Keypair[]) => {
    const transaction = new Transaction().add(...instructions);
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    transaction.feePayer = payer.publicKey; transaction.recentBlockhash = blockhash;
    transaction.sign(payer, ...signers);
    const signature = await connection.sendRawTransaction(transaction.serialize());
    const status = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
    if (status.value.err) throw new Error(`setup transaction ${signature} failed`);
  };
  const holding = ataAddress(wallet.publicKey, mint.publicKey);
  await send([
    SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey, space: 82, programId: TOKEN_PROGRAM,
      lamports: await connection.getMinimumBalanceForRentExemption(82) }),
    initializeMint2Ix(mint.publicKey, 6, payer.publicKey),
    createAtaIdempotentIx(payer.publicKey, wallet.publicKey, mint.publicKey),
    mintToIx(mint.publicKey, holding, payer.publicKey, 150_000_000n),
  ], [mint]);
  ok(`wallet ${wallet.publicKey.toBase58()} holds 150 test tokens`);

  // ---- relayer: register and snapshot, through the SDK ---------------------
  // A reserved test domain (RFC 6761).
  const origin = "https://selfhost.ghostlink.test";
  const client = await GhostLink.init({ cluster: DEPLOYMENT.cluster, deployment: DEPLOYMENT, indexer: urls.INDEXER!, relayer: urls.RELAYER!,
    solver: urls.SOLVER!, actions: urls.ACTIONS!, origin, chain: jsonRpcChainReader(rpc) });
  const signMessage = async (message: Uint8Array) => ed25519.sign(message, wallet.secretKey.subarray(0, 32));
  const identity = await deriveIdentity(signMessage, { cluster: "devnet", domain: new URL(origin).host, address: wallet.publicKey.toBase58() });
  await client.register({ identity, wallet: wallet.publicKey.toBytes(), signMessage });
  ok("registered through the relayer's POST /register (GhostLink.register)");

  const fee = readCensusFee(await connection.getAccountInfo(censusConfigPda(), "confirmed"));
  const vaultBefore = BigInt(await connection.getBalance(censusFeeVaultPda(), "confirmed"));
  await client.snapshot({ wallet: wallet.publicKey.toBytes(), holding: holding.toBytes() });
  const gained = BigInt(await connection.getBalance(censusFeeVaultPda(), "confirmed")) - vaultBefore;
  if (gained !== fee) throw new Error(`the census fee vault gained ${gained} lamports, expected the ${fee}-lamport snapshot fee`);
  ok(`census snapshot through the relayer's POST /snapshot (GhostLink.snapshot); the fee vault collected the ${fee}-lamport fee`);

  // ---- indexer: binding and snapshot, once finalized and their buckets end ----
  const wait = async (what: string, path: string) => {
    const deadline = Date.now() + 300_000;
    for (;;) {
      const response = await fetch(`${urls.INDEXER}${path}`);
      if (response.status === 200) return response.json() as Promise<Record<string, unknown>>;
      if (![404, 503].includes(response.status)) throw new Error(`indexer ${path}: HTTP ${response.status}`);
      if (Date.now() > deadline) throw new Error(`the indexer did not serve the ${what} within 5 minutes`);
      // Every indexer poll briefly refuses reads (503) while it scans; a period unrelated to the
      // poll interval keeps these retries from landing in that window every time.
      await sleep(700);
    }
  };
  const binding = await wait("registration", `/registry/binding/${wallet.publicKey.toBase58()}`);
  if (binding.commitment !== bytesToHex(fieldToBytes32(identity.commitment))) throw new Error("the indexer serves another commitment");
  ok(`indexer GET /registry/binding serves the wallet at registry leaf ${binding.leafIndex}`);
  const snapshot = await wait("snapshot", `/census/latest?wallet=${wallet.publicKey.toBase58()}&mint=${mint.publicKey.toBase58()}`);
  ok(`indexer GET /census/latest serves the snapshot at census leaf ${snapshot.leafIndex}`);
  console.log("SELF-HOSTED SERVICES PASSED — ready, register, snapshot with fee, indexed.");
}

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
