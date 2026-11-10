#!/usr/bin/env node
/**
 * Deployment manifest tooling. See docs/DEPLOYMENTS.md.
 *
 *   node scripts/deployment.mjs new --cluster <c> --keys <dir> --out <manifest.json> [--genesis-hash <hash>]
 *       Generates three program keypairs in <dir> (outside this checkout), or
 *       reuses the three already there, and writes a manifest for them.
 *   node scripts/deployment.mjs check [<manifest.json>]
 *       Validates a manifest (default: the built-in localnet deployment) and
 *       checks it against this checkout's verifying keys and program sources.
 *   node scripts/deployment.mjs ids [<manifest.json>]
 *       Prints "registry census pocket" program IDs.
 *   node scripts/deployment.mjs artifacts <manifest.json>
 *       Prints the directory holding the programs built for the manifest,
 *       after checking they were built for exactly that manifest.
 *   node scripts/deployment.mjs deploy-check <manifest.json> --keys <dir> --url <rpc> --payer <keypair.json>
 *       Everything scripts/deploy-programs.sh checks before deploying.
 *   node scripts/deployment.mjs initialize <manifest.json> --url <rpc> --payer <keypair.json>
 *       Creates the registry and census trees if they do not exist yet.
 *
 * Used by scripts/build-programs.sh (prepare-build, stamp) and
 * scripts/localnet-e2e.sh. Requires a built @ghostlink/common.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import {
  chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PROGRAM_SOURCES, disagreements, rewriteProgramSources } from "./program-ids.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROLES = /** @type {const} */ (["registryProgram", "censusProgram", "pocketProgram"]);
const NAMES = { registryProgram: "registry", censusProgram: "census", pocketProgram: "pocket" };
const STAMP = "deployment-manifest.json";

let common;
try {
  common = await import(pathToFileURL(join(ROOT, "packages/common/dist/index.js")).href);
} catch {
  fail("build @ghostlink/common first: pnpm --filter @ghostlink/common build");
}

function fail(message) {
  console.error(`deployment: ${message}`);
  process.exit(1);
}

function options(args, allowed) {
  const positional = [], named = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    const name = arg.slice(2);
    if (!allowed.includes(name) || i + 1 >= args.length) fail(`unknown or incomplete option ${arg}`);
    named[name] = args[++i];
  }
  return { positional, named };
}

/** Reads and validates a manifest file; no argument means the built-in localnet deployment. */
function loadManifest(path) {
  if (path === undefined) return common.LOCALNET_DEPLOYMENT;
  let raw;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch { fail(`cannot read ${path} as JSON`); }
  try { return common.parseDeployment(raw); } catch (error) { fail(`${path}: ${error.message}`); }
}

function idsOf(manifest) {
  return Object.fromEntries(ROLES.map(role => [role, manifest[role]]));
}

/** Digests of the verifying keys this checkout's programs embed (generated from circuits/keys). */
function checkoutVerifyingKeys() {
  const digest = name => common.verifyingKeyDigest(JSON.parse(readFileSync(join(ROOT, `circuits/keys/${name}_vk.json`), "utf8")));
  return { login: digest("login"), owner: digest("owner") };
}

function checkVerifyingKeys(manifest) {
  const local = checkoutVerifyingKeys();
  for (const name of ["login", "owner"]) {
    if (manifest.verifyingKeys[name] !== local[name]) {
      fail(`the manifest's ${name} verifying key ${manifest.verifyingKeys[name]} is not the one this checkout builds (${local[name]})`);
    }
  }
}

function outsideCheckout(path, what) {
  const target = resolve(path);
  const real = existsSync(target) ? realpathSync(target) : target;
  for (const candidate of new Set([target, real])) {
    const rel = relative(realpathSync(ROOT), candidate);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) fail(`${what} must be outside this checkout (${ROOT})`);
  }
  return target;
}

function buildRoot(manifest) {
  const target = process.env.CARGO_TARGET_DIR ? resolve(process.env.CARGO_TARGET_DIR) : join(ROOT, "target");
  return join(target, "deployments", manifest.pocketProgram);
}

function canonical(manifest) {
  return JSON.stringify(common.parseDeployment(manifest), null, 2) + "\n";
}

// ---- keypairs ---------------------------------------------------------------

function keypairPath(dir, role) {
  return join(dir, `${NAMES[role]}.keypair.json`);
}

/** Public key of a Solana keypair file (64-byte JSON array: seed then public key), checked against its seed. */
function readKeypair(path) {
  let bytes;
  try { bytes = Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))); } catch { fail(`cannot read keypair ${path}`); }
  if (bytes.length !== 64) fail(`${path} is not a 64-byte Solana keypair`);
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), bytes.subarray(0, 32)]);
  const derived = Buffer.from(createPublicKey(createPrivateKey({ key: der, format: "der", type: "pkcs8" }))
    .export({ format: "jwk" }).x, "base64url");
  if (!derived.equals(Buffer.from(bytes.subarray(32)))) fail(`${path}: public key does not match its secret key`);
  return common.toBase58(derived);
}

function writeKeypair(path) {
  const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
  const bytes = [...Buffer.from(jwk.d, "base64url"), ...Buffer.from(jwk.x, "base64url")];
  writeFileSync(path, JSON.stringify(bytes) + "\n", { flag: "wx", mode: 0o600 });
  return common.toBase58(Buffer.from(jwk.x, "base64url"));
}

// ---- commands ---------------------------------------------------------------

function cmdNew(args) {
  const { positional, named } = options(args, ["cluster", "keys", "out", "genesis-hash"]);
  if (positional.length || !named.cluster || !named.keys || !named.out) {
    fail("usage: new --cluster <localnet|devnet|mainnet-beta> --keys <dir outside the checkout> --out <manifest.json> [--genesis-hash <hash>]");
  }
  const keys = outsideCheckout(named.keys, "the keypair directory");
  const out = resolve(named.out);
  if (existsSync(out)) fail(`${out} already exists; refusing to overwrite a manifest`);
  const genesisHash = named["genesis-hash"] ?? common.PUBLIC_GENESIS_HASHES[named.cluster];
  // Validate everything except the program IDs before creating any key.
  try {
    common.parseDeployment({ version: 1, cluster: named.cluster, ...(genesisHash ? { genesisHash } : {}),
      registryProgram: "11111111111111111111111111111112", censusProgram: "11111111111111111111111111111113",
      pocketProgram: "11111111111111111111111111111114", verifyingKeys: checkoutVerifyingKeys() });
  } catch (error) { fail(error.message); }
  mkdirSync(keys, { recursive: true, mode: 0o700 });
  const present = ROLES.filter(role => existsSync(keypairPath(keys, role)));
  if (present.length !== 0 && present.length !== 3) fail(`${keys} holds only some program keypairs; supply all three or none`);
  const ids = Object.fromEntries(ROLES.map(role => [role,
    present.length ? readKeypair(keypairPath(keys, role)) : writeKeypair(keypairPath(keys, role))]));
  if (process.platform !== "win32") chmodSync(keys, 0o700);
  let manifest;
  try {
    manifest = common.parseDeployment({ version: 1, cluster: named.cluster, ...(genesisHash ? { genesisHash } : {}),
      ...ids, verifyingKeys: checkoutVerifyingKeys() });
  } catch (error) { fail(error.message); }
  if (common.usesBuiltinProgramIds(manifest)) fail("these keypairs are the built-in program IDs; generate new ones");
  writeFileSync(out, canonical(manifest), { flag: "wx" });
  console.log(`${present.length ? "Reused" : "Generated"} program keypairs in ${keys} (keep them private; never commit them).`);
  for (const role of ROLES) console.log(`  ${NAMES[role].padEnd(8)} ${manifest[role]}`);
  console.log(`Manifest: ${out}`);
}

function cmdCheck(args) {
  const { positional } = options(args, []);
  if (positional.length > 1) fail("usage: check [<manifest.json>]");
  const manifest = loadManifest(positional[0]);
  checkVerifyingKeys(manifest);
  const builtin = disagreements(ROOT, PROGRAM_SOURCES, idsOf(common.LOCALNET_DEPLOYMENT));
  if (builtin.length) fail(`this checkout's program sources do not carry the built-in IDs:\n${builtin.join("\n")}`);
  console.log(`ok: ${manifest.cluster} deployment ${ROLES.map(r => manifest[r]).join(" ")}` +
    (common.usesBuiltinProgramIds(manifest) ? " (built-in IDs)" : " (built by scripts/build-programs.sh --deployment)"));
}

function cmdIds(args) {
  const { positional } = options(args, []);
  if (positional.length > 1) fail("usage: ids [<manifest.json>]");
  const manifest = loadManifest(positional[0]);
  console.log(ROLES.map(role => manifest[role]).join(" "));
}

function cmdCluster(args) {
  const { positional } = options(args, []);
  if (positional.length !== 1) fail("usage: cluster <manifest.json>");
  console.log(loadManifest(positional[0]).cluster);
}

/** Copies the Rust workspace into a private build directory and writes the manifest's IDs into the copy. */
function cmdPrepareBuild(args) {
  const { positional } = options(args, []);
  if (positional.length !== 1) fail("usage: prepare-build <manifest.json>");
  const manifest = loadManifest(positional[0]);
  checkVerifyingKeys(manifest);
  const builtin = disagreements(ROOT, PROGRAM_SOURCES, idsOf(common.LOCALNET_DEPLOYMENT));
  if (builtin.length) fail(`this checkout's program sources were edited by hand; restore the built-in IDs first:\n${builtin.join("\n")}`);
  const work = buildRoot(manifest), source = join(work, "src");
  rmSync(source, { recursive: true, force: true });
  rmSync(join(work, "deploy"), { recursive: true, force: true });
  mkdirSync(source, { recursive: true });
  for (const file of ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml"]) cpSync(join(ROOT, file), join(source, file));
  cpSync(join(ROOT, "programs"), join(source, "programs"), { recursive: true,
    filter: path => !relative(join(ROOT, "programs"), path).split(/[\\/]/).includes("target") });
  rewriteProgramSources(source, idsOf(manifest));
  if (!common.usesBuiltinProgramIds(manifest)) {
    // Nothing compiled into the three programs may still name a built-in ID.
    const ids = idsOf(common.LOCALNET_DEPLOYMENT);
    for (const program of ["registry", "census", "pocket"]) {
      for (const file of readdirSync(join(source, "programs", program, "src"), { recursive: true })) {
        if (!String(file).endsWith(".rs")) continue;
        const text = readFileSync(join(source, "programs", program, "src", String(file)), "utf8");
        const left = ROLES.find(role => text.includes(ids[role]));
        if (left) fail(`programs/${program}/src/${file} still names the built-in ${left} after the rewrite`);
      }
    }
  }
  console.log(work);
}

/** Records which manifest a build directory holds and removes cargo's random program keypairs. */
function cmdStamp(args) {
  const { positional } = options(args, []);
  if (positional.length !== 1) fail("usage: stamp <manifest.json>");
  const manifest = loadManifest(positional[0]);
  const deploy = join(buildRoot(manifest), "deploy");
  for (const file of readdirSync(deploy)) {
    // cargo-build-sbf creates a random keypair beside each program; it is not the manifest's key.
    if (file.endsWith("-keypair.json")) rmSync(join(deploy, file));
  }
  writeFileSync(join(deploy, STAMP), canonical(manifest));
  console.log(`Programs for ${manifest.cluster} deployment in ${deploy}:`);
  for (const role of ROLES) {
    const so = join(deploy, `ghostlink_${NAMES[role]}.so`);
    const hash = createHash("sha256").update(stripZeros(readFileSync(so))).digest("hex");
    console.log(`  ${NAMES[role].padEnd(8)} ${manifest[role]}  sha256 ${hash}`);
  }
}

function stripZeros(bytes) {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  return bytes.subarray(0, end);
}

function artifactsFor(manifest) {
  const deploy = join(buildRoot(manifest), "deploy");
  let stamped;
  try { stamped = readFileSync(join(deploy, STAMP), "utf8"); } catch {
    fail(`no programs built for this manifest in ${deploy}; run scripts/build-programs.sh --deployment <manifest>`);
  }
  if (stamped !== canonical(manifest)) fail(`${deploy} holds programs built for a different manifest; rebuild`);
  for (const role of ROLES) {
    if (!existsSync(join(deploy, `ghostlink_${NAMES[role]}.so`))) fail(`${deploy} is missing ghostlink_${NAMES[role]}.so; rebuild`);
  }
  return deploy;
}

function cmdArtifacts(args) {
  const { positional } = options(args, []);
  if (positional.length !== 1) fail("usage: artifacts <manifest.json>");
  console.log(artifactsFor(loadManifest(positional[0])));
}

async function genesisOf(url) {
  let response;
  try {
    response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getGenesisHash" }), signal: AbortSignal.timeout(15_000) });
  } catch { fail(`cannot reach ${url}`); }
  const body = await response.json().catch(() => ({}));
  if (typeof body.result !== "string") fail(`${url} did not return a genesis hash`);
  return body.result;
}

async function cmdDeployCheck(args) {
  const { positional, named } = options(args, ["keys", "url", "payer"]);
  if (positional.length !== 1 || !named.keys || !named.url || !named.payer) {
    fail("usage: deploy-check <manifest.json> --keys <dir> --url <rpc> --payer <keypair.json>");
  }
  const manifest = loadManifest(positional[0]);
  // The built-in IDs are the preserved V1 programs on devnet: never a deploy target, on any cluster.
  if (common.usesBuiltinProgramIds(manifest)) fail("refusing to deploy to a built-in program ID (the preserved V1 deployment)");
  checkVerifyingKeys(manifest);
  const keys = outsideCheckout(named.keys, "the keypair directory");
  for (const role of ROLES) {
    if (readKeypair(keypairPath(keys, role)) !== manifest[role]) fail(`${keypairPath(keys, role)} is not the manifest's ${role}`);
  }
  const payer = readKeypair(outsideCheckout(named.payer, "the payer keypair"));
  if (ROLES.some(role => manifest[role] === payer)) fail("the payer must not be a program keypair");
  const deploy = artifactsFor(manifest);
  const genesis = await genesisOf(named.url);
  try { common.assertDeploymentGenesis(manifest, genesis); } catch (error) { fail(error.message); }
  // Plain lines for scripts/deploy-programs.sh.
  console.log(`cluster ${manifest.cluster}`);
  console.log(`genesis ${genesis}`);
  console.log(`programs ${deploy}`);
  console.log(`payer ${payer}`);
  for (const role of ROLES) console.log(`${NAMES[role]} ${manifest[role]}`);
}

async function cmdInitialize(args) {
  const { positional, named } = options(args, ["url", "payer"]);
  if (positional.length !== 1 || !named.url || !named.payer) fail("usage: initialize <manifest.json> --url <rpc> --payer <keypair.json>");
  const manifest = loadManifest(positional[0]);
  // service-kit reads the deployment once, at import.
  process.env.GHOSTLINK_DEPLOYMENT = resolve(positional[0]);
  const require = createRequire(join(ROOT, "services/shared/package.json"));
  const web3 = require("@solana/web3.js");
  let kit;
  try { kit = await import(pathToFileURL(join(ROOT, "services/shared/dist/index.js")).href); } catch {
    fail("build @ghostlink/service-kit first: pnpm --filter @ghostlink/service-kit... build");
  }
  if (kit.POCKET.toBase58() !== manifest.pocketProgram) fail("service-kit did not load the manifest");
  const connection = new web3.Connection(named.url, "confirmed");
  try { common.assertDeploymentGenesis(manifest, await connection.getGenesisHash()); } catch (error) { fail(error.message); }
  readKeypair(named.payer);
  const payer = web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(named.payer, "utf8"))));
  for (const [program, tree] of [["registry", kit.registryTreePda()], ["census", kit.censusTreePda()]]) {
    if (await connection.getAccountInfo(tree, "confirmed")) { console.log(`${program} tree already exists: ${tree.toBase58()}`); continue; }
    const transaction = new web3.Transaction().add(kit.initializeIx(program, payer.publicKey));
    const signature = await web3.sendAndConfirmTransaction(connection, transaction, [payer], { commitment: "confirmed" });
    console.log(`${program} tree initialized: ${tree.toBase58()} (${signature})`);
  }
}

const [command, ...rest] = process.argv.slice(2);
const commands = { new: cmdNew, check: cmdCheck, ids: cmdIds, cluster: cmdCluster, "prepare-build": cmdPrepareBuild,
  stamp: cmdStamp, artifacts: cmdArtifacts, "deploy-check": cmdDeployCheck, initialize: cmdInitialize };
if (!commands[command]) fail(`usage: node scripts/deployment.mjs <${Object.keys(commands).join("|")}> ...`);
await commands[command](rest);
