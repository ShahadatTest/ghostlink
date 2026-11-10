// Pack only public libraries and test them in a consumer outside the monorepo.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = join(root, "artifacts", "sdk");
const pnpm = process.env.npm_execpath;
if (!pnpm || !/pnpm/i.test(pnpm)) throw new Error("Run through pnpm: pnpm pack:sdk or pnpm test:package");
const run = (args, cwd = root) => execFileSync(process.execPath, [pnpm, ...args], { cwd, stdio: "inherit" });
mkdirSync(destination, { recursive: true });
const includeBot = process.argv.includes("--bot");
const folders = ["packages/common", "packages/sdk", "packages/verify", "packages/prover-wasm", "packages/react",
  ...(includeBot ? ["services/shared", "packages/bot"] : [])];
// Files a consumer cannot work without, beyond each package's dist entry point.
const required = { "@ghostlink/verify": ["package/keys/login_vk.json"] };
// The front-end packages ship exactly these modules (each as .js and .d.ts):
// a new file fails the check until it is listed here on purpose.
const exactModules = {
  "@ghostlink/verify": ["index", "login-vk"],
  "@ghostlink/prover-wasm": ["index", "prover", "protocol", "worker-prover", "worker"],
  "@ghostlink/react": ["index"],
};
// A static or dynamic import of a Node built-in, or CommonJS loading: none may reach a browser or edge bundle.
const nodeOnly = /\bfrom\s*["'](?:node:|(?:fs|path|module|os|crypto|url|worker_threads)["'])|\bimport\s*\(\s*["']node:|\brequire\s*\(|\bcreateRequire\b/;
// Comments may precede a directive; nothing else may.
const firstStatement = (source) => source.replace(/^(?:\s+|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*/, "");
const tarballs = [], packageOverrides = {};
for (const relative of folders) {
  const folder = join(root, relative);
  const pkg = JSON.parse(readFileSync(join(folder, "package.json"), "utf8"));
  // Packing never builds: an unbuilt package would ship without its code.
  if (!existsSync(join(folder, pkg.main))) throw new Error(`${pkg.name} is not built: run pnpm --filter ${pkg.name} build`);
  run(["pack", "--pack-destination", destination], folder);
  const tarball = join(destination, `${pkg.name.replace(/^@/, "").replace("/", "-")}-${pkg.version}.tgz`);
  // pnpm's allowlisted package contents must not accidentally ship workspace files.
  // A relative name: GNU tar (Git Bash) reads the colon in a Windows drive path as a remote host.
  const files = execFileSync("tar", ["-tzf", basename(tarball)], { cwd: destination, encoding: "utf8" }).trim().split(/\r?\n/);
  for (const file of files) {
    if (!/^package\/(dist\/[^\s]+\.(?:js|d\.ts)|fixtures\/[^\s]+\.json|keys\/login_vk\.json|package\.json|README\.md|LICENSE)$/.test(file)) {
      throw new Error(`Unexpected packed file: ${file}`);
    }
  }
  for (const file of ["package/package.json", "package/README.md", "package/LICENSE", "package/dist/index.js", "package/dist/index.d.ts", ...(required[pkg.name] ?? [])]) {
    if (!files.includes(file)) throw new Error(`${pkg.name} archive is missing ${file}`);
  }
  const modules = exactModules[pkg.name];
  if (modules) {
    const expected = ["package/package.json", "package/README.md", "package/LICENSE", ...(required[pkg.name] ?? []),
      ...modules.flatMap(name => [`package/dist/${name}.js`, `package/dist/${name}.d.ts`])].sort();
    const actual = [...files].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`${pkg.name} archive holds ${actual.join(", ")}; expected exactly ${expected.join(", ")}`);
    }
    const packed = (file) => execFileSync("tar", ["-xOzf", basename(tarball), file], { cwd: destination, encoding: "utf8" });
    for (const name of modules) {
      if (nodeOnly.test(packed(`package/dist/${name}.js`))) throw new Error(`${pkg.name} dist/${name}.js loads a Node built-in or uses require`);
    }
    if (pkg.name === "@ghostlink/react" && !firstStatement(packed("package/dist/index.js")).startsWith('"use client";')) {
      throw new Error('@ghostlink/react dist/index.js must start with the "use client" directive');
    }
    if (pkg.name === "@ghostlink/prover-wasm") {
      const manifest = JSON.parse(packed("package/package.json"));
      if (manifest.exports?.["./worker"]?.default !== "./dist/worker.js") throw new Error("@ghostlink/prover-wasm must export ./worker");
      // The worker entry acts on import: a bundler must never drop `import "@ghostlink/prover-wasm/worker"`.
      if (!Array.isArray(manifest.sideEffects) || !manifest.sideEffects.includes("./dist/worker.js")) {
        throw new Error("@ghostlink/prover-wasm must list ./dist/worker.js in sideEffects");
      }
      if (!packed("package/dist/worker-prover.js").includes('new Worker(new URL("./worker.js", import.meta.url), { type: "module" })')) {
        throw new Error("@ghostlink/prover-wasm must start its worker with the literal pattern bundlers recognise");
      }
    }
  }
  tarballs.push(tarball);
  packageOverrides[pkg.name] = `file:${tarball.replaceAll("\\", "/")}`;
}
writeFileSync(join(destination, "SHA256SUMS"), tarballs.map(path => `${createHash("sha256").update(readFileSync(path)).digest("hex")}  ${path.split(/[\\/]/).pop()}`).join("\n") + "\n");

if (process.argv.includes("--test")) {
  const consumer = mkdtempSync(join(tmpdir(), "ghostlink-sdk-consumer-"));
  // Until registry publication, resolve the SDK's versioned common dependency
  // to the reviewed companion archive, including under pnpm's strict resolver.
  writeFileSync(join(consumer, "package.json"), JSON.stringify({
    name: "ghostlink-install-check", private: true, type: "module",
    pnpm: { overrides: { ...JSON.parse(readFileSync(join(root, "package.json"), "utf8")).pnpm.overrides, ...packageOverrides } },
  }));
  // A React app supplies react (a peer dependency) and its types: use the versions the workspace tests.
  const reactWorkspace = createRequire(join(root, "packages", "react", "package.json"));
  const reactDeps = ["react", "@types/react"].map(name => `${name}@${reactWorkspace(`${name}/package.json`).version}`);
  // The documentation snippets compiled below also show @solana/web3.js interop and a Node backend: the versions the SDK tests with.
  const sdkWorkspace = createRequire(join(root, "packages", "sdk", "package.json"));
  const docDeps = ["@solana/web3.js", "@types/node"].map(name => `${name}@${sdkWorkspace(`${name}/package.json`).version}`);
  run(["add", "--ignore-scripts", ...tarballs, ...reactDeps, ...docDeps], consumer);
  writeFileSync(join(consumer, "check.mjs"), `
import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { GhostLink, softwareSession, sessionPublicKey, derivePocket, signIntent, policyToDto, policyFromDto,
  ApplicationRegistry, applicationRegistryDigest, OwnerConsentController, verifyTelegramOwnerInitData,
  prepareTelegramPairing, parseTelegramPairingCode, verifyTelegramPairingClaim,
  RelayerClient, prepareRelayerOperation, RelayerOperationPendingError, RelayerRequestError, prepareFundingTransaction,
  claimMintFields, jsonRpcChainReader } from '@ghostlink/sdk';
import { intentHash, conservativePolicy, policyHash, u64le, LOCALNET_DEPLOYMENT, PUBLIC_GENESIS_HASHES, parseDeployment, toBase58 } from '@ghostlink/common';
const relayerOperation = prepareRelayerOperation('/snapshot', {wallet:'wallet',holding:'holding'});
const relayerClient = new RelayerClient('https://relayer.invalid', async () => { throw new Error('synthetic offline'); });
await assert.rejects(relayerClient.submit(relayerOperation), e => e instanceof RelayerOperationPendingError && e.operation.digestHex === relayerOperation.digestHex);
const refusingRelayer = new RelayerClient('https://relayer.invalid', async () => Response.json({ error: 'rate limited', code: 'rate_limited' }, { status: 429 }));
await assert.rejects(refusingRelayer.submit(relayerOperation), e => e instanceof RelayerRequestError && e.status === 429 && e.code === 'rate_limited');
assert.deepEqual(claimMintFields(new Uint8Array(32).fill(1)), { mintHi: '1334440654591915542993625911497130241', mintLo: '1334440654591915542993625911497130241' });
assert.equal(await jsonRpcChainReader('https://rpc.invalid', { fetchFn: async () => Response.json({ jsonrpc: '2.0', id: 1, result: 42 }) }).getSlot(), 42n);
const bot = softwareSession();
const publicKey = sessionPublicKey(0, bot.key32);
assert.equal('sign' in publicKey, false);
const base = new Uint8Array(32).fill(2);
const policy = { ...conservativePolicy(), oracleFeeds: [{ mint: base, feedId: new Uint8Array(32).fill(4), decimals: 9 }],
  speculative: { dailyBuyCapUsdE6: 30000000n, maxCostExposureUsdE6: 20000000n, maxPositions: 2, baseMints: [base] } };
assert.deepEqual(policyFromDto(policyToDto(policy)), policy);
const pocket = derivePocket(1n, new Uint8Array(32).fill(1), policy);
// Legacy native deposit fixture, independently assembled from the wire format.
const depositWire = Uint8Array.of(1, ...new Uint8Array(64), 1, 0, 1, 3,
  ...publicKey.key32, ...pocket.address, ...new Uint8Array(32), ...new Uint8Array(32).fill(2),
  1, 2, 2, 0, 1, 12, 2, 0, 0, 0, ...u64le(100n));
const depositApproval = { appId: 1n, funder: publicKey.key32, asset: { kind: 'sol', lamports: 100n }, recentBlockhash: new Uint8Array(32).fill(3) };
const expectedDeposit = Uint8Array.from(depositWire); expectedDeposit.set(depositApproval.recentBlockhash, 165);
assert.deepEqual(prepareFundingTransaction(depositWire, depositApproval), expectedDeposit);
assert.throws(() => prepareFundingTransaction(depositWire, { ...depositApproval, appId: 2n }));
assert.throws(() => prepareFundingTransaction(depositWire, { ...depositApproval, asset: { kind: 'sol', lamports: 101n } }));
const signed = await signIntent(pocket, bot, {
  nonce: 1n, inMint: new Uint8Array(32).fill(2), inMax: 100n,
  outMint: new Uint8Array(32).fill(3), outMin: 90n, deadlineSlot: 1000n,
});
const key = createPublicKey({ format: 'der', type: 'spki', key: Buffer.concat([
  Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKey.key32),
]) });
assert.equal(verify(null, intentHash(signed.intent), key, signed.signature.signature), true);
assert.deepEqual(signed.intent.policyHash, policyHash(policy));
await assert.rejects(GhostLink.init({ cluster: 'mainnet-beta', indexer: 'https://example.invalid' }), /requires an explicit deployment manifest/);
const ownDeployment = { ...LOCALNET_DEPLOYMENT, cluster: 'devnet', genesisHash: PUBLIC_GENESIS_HASHES.devnet,
  registryProgram: toBase58(new Uint8Array(32).fill(1)), censusProgram: toBase58(new Uint8Array(32).fill(2)), pocketProgram: toBase58(new Uint8Array(32).fill(3)) };
assert.deepEqual((await GhostLink.init({ cluster: 'devnet', deployment: ownDeployment, indexer: 'https://example.invalid' })).deployment, parseDeployment(ownDeployment));
await assert.rejects(GhostLink.init({ cluster: 'devnet', deployment: { ...ownDeployment, pocketProgram: LOCALNET_DEPLOYMENT.pocketProgram }, indexer: 'https://example.invalid' }), /built-in program ID/);
for (const api of [ApplicationRegistry, applicationRegistryDigest, OwnerConsentController, verifyTelegramOwnerInitData,
  prepareTelegramPairing, parseTelegramPairingCode, verifyTelegramPairingClaim]) assert.equal(typeof api, 'function');
assert.throws(() => verifyTelegramOwnerInitData('user=forged', '12345'));
assert.throws(() => prepareTelegramPairing('user=forged', '12345'));
const code = 'GLP1.12345.42.' + 'ab'.repeat(32);
assert.equal(parseTelegramPairingCode(code).userId, '42');
assert.throws(() => verifyTelegramPairingClaim(code, '12345', { initData: 'user=forged', expiresAt: Math.floor(Date.now()/1000)+60 }));
console.log('Installed SDK: ESM import, public delegation, real intent signature and exact funding validation verified. No network transaction sent.');
`);
  execFileSync(process.execPath, [join(consumer, "check.mjs")], { cwd: consumer, stdio: "inherit" });
  writeFileSync(join(consumer, "login.mjs"), `
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { bundledLoginVerificationKey, loginChallengeDigest, verifyLogin, verifyLoginChallenge } from '@ghostlink/verify';
import { createProver } from '@ghostlink/prover-wasm';
import { ContinueWithGhostLink, GhostLinkProvider, useGhostLink } from '@ghostlink/react';
import { softwareSession } from '@ghostlink/sdk';
const require = createRequire(import.meta.url);
const fixture = JSON.parse(readFileSync(${JSON.stringify(join(root, "circuits", "keys", "login_offchain_proof.json"))}, 'utf8'));
const vectors = JSON.parse(readFileSync(${JSON.stringify(join(root, "packages", "common", "fixtures", "vectors.json"))}, 'utf8'));
const pub = vectors.circuits.login.public;
const session = softwareSession(Buffer.from(vectors.identity.sessionSeed, 'hex'));
const expirySlot = BigInt(vectors.identity.expirySlot);
const request = { proof: fixture.proof, publicSignals: fixture.publicSignals, expectedDomain: vectors.identity.origin,
  roots: async () => ({ registry: [pub.registry_root], census: [pub.census_root] }),
  expect: { holdsAtLeast: { mintHi: pub.mint_hi, mintLo: pub.mint_lo, threshold: BigInt(pub.threshold) }, minSlot: BigInt(pub.min_slot),
    session: { key32: session.key32, expirySlot, currentSlot: expirySlot - 1n } } };
// The archived verifying key loads from the installed package and verifies a real proof.
assert.deepEqual(await verifyLogin(request), { ok: true, appId: vectors.identity.appId });
assert.deepEqual(require('@ghostlink/verify/keys/login_vk.json'), bundledLoginVerificationKey());
assert.throws(() => require('@ghostlink/verify/dist/index.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
assert.match((await verifyLogin({ ...request, expect: { ...request.expect, minSlot: undefined } })).reason, /freshness bound/);
// The installed SDK's session signature is what the installed verifier accepts.
const nonce = randomBytes(32);
const { signature } = await session.sign(loginChallengeDigest(nonce));
assert.equal(verifyLoginChallenge({ key32: session.key32, nonce, signature }), true);
assert.equal(verifyLoginChallenge({ key32: session.key32, nonce: randomBytes(32), signature }), false);
let downloads = 0;
const prover = createProver({
  login: { wasmUrl: 'https://artifacts.invalid/login.wasm', zkeyUrl: 'https://artifacts.invalid/login.zkey', wasmSha256: '00'.repeat(32), zkeySha256: '00'.repeat(32) },
  fetchFn: async () => { downloads++; return new Response(new Uint8Array([1, 2, 3])); },
});
await assert.rejects(prover.prove('owner', {}), /no owner circuit artifacts configured/);
assert.equal(downloads, 0);
await assert.rejects(prover.prove('login', {}), /integrity check failed/);
for (const component of [GhostLinkProvider, useGhostLink, ContinueWithGhostLink]) assert.equal(typeof component, 'function');
console.log('Installed verify, prover-wasm and react: real proof with the archived key, SDK challenge signature, login-only prover pins and React exports verified.');
// snarkjs keeps its curve worker threads alive.
process.exit(0);
`);
  execFileSync(process.execPath, [join(consumer, "login.mjs")], { cwd: consumer, stdio: "inherit" });
  // The installed worker entry in a real thread. Node has no Web Worker, so a
  // small host gives the thread the three DedicatedWorkerGlobalScope members
  // the entry uses, and an adapter gives createWorkerProver a Worker.
  writeFileSync(join(consumer, "worker-host.mjs"), `
import { registerHooks } from 'node:module';
import { parentPort, workerData } from 'node:worker_threads';
// Resolve as a bundler does for a browser worker, so snarkjs runs its browser
// build here as it would in a page. (Its Node build mistakes any worker thread
// for one of its own helper threads.)
registerHooks({ resolve: (specifier, context, next) => next(specifier, { ...context,
  conditions: ['browser', 'worker', 'import', 'module', 'default', ...(context.conditions.includes('require') ? ['require'] : [])] }) });
const target = new EventTarget();
globalThis.self = globalThis;
globalThis.postMessage = (data) => parentPort.postMessage(data);
globalThis.addEventListener = (type, listener) => target.addEventListener(type, listener);
await import(workerData.entry);
// A port queues messages until it has a listener, so none are lost while the entry loads.
parentPort.on('message', (data) => target.dispatchEvent(new MessageEvent('message', { data })));
`);
  writeFileSync(join(consumer, "worker.mjs"), `
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { Worker } from 'node:worker_threads';
import { createWorkerProver } from '@ghostlink/prover-wasm';
import { verifyLogin } from '@ghostlink/verify';
import { conservativePolicy, hexToBytes } from '@ghostlink/common';
// Imported outside a worker, the entry does nothing.
assert.deepEqual(Object.keys(await import('@ghostlink/prover-wasm/worker')), []);
const entry = import.meta.resolve('@ghostlink/prover-wasm/worker');
const build = ${JSON.stringify(join(root, "circuits", "build"))};
const real = existsSync(build + '/login_js/login.wasm') && existsSync(build + '/login_dev.zkey');
const files = { '/garbage.wasm': new Uint8Array([0, 97, 115, 109, 9, 9, 9, 9]), '/garbage.zkey': new Uint8Array([1, 2, 3]) };
if (real) Object.assign(files, { '/login.wasm': readFileSync(build + '/login_js/login.wasm'), '/login.zkey': readFileSync(build + '/login_dev.zkey') });
const server = createServer((req, res) => { const body = files[req.url]; res.writeHead(body ? 200 : 404).end(body); });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
const sha = (path) => createHash('sha256').update(files[path]).digest('hex');
const threads = [];
const createWorker = () => {
  const thread = new Worker(new URL('./worker-host.mjs', import.meta.url), { workerData: { entry } });
  const worker = { stopped: false,
    postMessage: (message) => thread.postMessage(message),
    addEventListener: (type, listener) => { if (type === 'message') thread.on('message', (data) => listener({ data })); if (type === 'error') thread.on('error', listener); },
    terminate: () => { worker.stopped = true; void thread.terminate(); } };
  threads.push(worker);
  return worker;
};
const garbage = { wasmUrl: base + '/garbage.wasm', zkeyUrl: base + '/garbage.zkey' };
// Pins are enforced inside the thread, and the error crosses back intact.
const pinned = createWorkerProver({ createWorker, login: { ...garbage, wasmSha256: '00'.repeat(32), zkeySha256: sha('/garbage.zkey') } });
await assert.rejects(pinned.prove('login', {}), { message: 'integrity check failed for ' + base + '/garbage.wasm' });
pinned.terminate();
// Correctly pinned but broken artifacts: real snarkjs fails in the thread, the page gets its error.
const broken = createWorkerProver({ createWorker, login: { ...garbage, wasmSha256: sha('/garbage.wasm'), zkeySha256: sha('/garbage.zkey') } });
await assert.rejects(broken.prove('login', {}), (e) => e instanceof Error && e.message.length > 0 && !/integrity/.test(e.message));
broken.terminate();
assert.equal(threads.length, 2);
if (real) {
  const vectors = JSON.parse(readFileSync(${JSON.stringify(join(root, "packages", "common", "fixtures", "vectors.json"))}, 'utf8'));
  const fixture = JSON.parse(readFileSync(${JSON.stringify(join(root, "circuits", "keys", "login_proof.json"))}, 'utf8'));
  const login = { wasmUrl: base + '/login.wasm', zkeyUrl: base + '/login.zkey', wasmSha256: sha('/login.wasm'), zkeySha256: sha('/login.zkey') };
  const input = { ...vectors.circuits.login.public, ...vectors.circuits.login.private };
  // A proof that cannot finish in 1 ms stops its thread; the next proof gets a new one.
  const prover = createWorkerProver({ createWorker, login });
  await assert.rejects(prover.prove('login', input, { timeoutMs: 1 }), { name: 'TimeoutError' });
  assert.equal(threads[2].stopped, true);
  const started = Date.now();
  const { proof, publicSignals } = await prover.prove('login', input);
  assert.deepEqual(publicSignals, fixture.publicSignals);
  const policy = { ...conservativePolicy(), oracleFeeds: vectors.policyWithFeeds.feeds.map((feed) => ({ mint: hexToBytes(feed.mint), feedId: hexToBytes(feed.feedId), decimals: feed.decimals })) };
  const roots = async () => ({ registry: [vectors.circuits.login.public.registry_root], census: [vectors.circuits.login.public.census_root] });
  assert.deepEqual(await verifyLogin({ proof, publicSignals, expectedDomain: vectors.identity.origin, roots, expect: { pocket: { policy, sessionKind: 0 } } }), { ok: true, appId: vectors.identity.appId });
  assert.equal(threads.length, 4);
  prover.terminate();
  console.log('Installed worker entry: real login proof in a worker thread (' + (Date.now() - started) + ' ms) verified by @ghostlink/verify; timeout stopped its thread.');
} else {
  console.log('circuits/build not present: skipped the real worker-thread proof (run scripts/build-circuits.sh to include it).');
}
server.close();
console.log('Installed worker entry: pinned-hash refusal and snarkjs errors cross a real thread; importing it outside a worker is inert.');
process.exit(0);
`);
  execFileSync(process.execPath, [join(consumer, "worker.mjs")], { cwd: consumer, stdio: "inherit" });
  // An edge-like runtime: browser/worker export conditions, no Node built-ins,
  // no Buffer, and no WebAssembly compiled from bytes (as on Vercel Edge and
  // Cloudflare Workers). The verify package must load and say why it cannot verify.
  writeFileSync(join(consumer, "edge.mjs"), `
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { builtinModules, registerHooks } from 'node:module';
const fixture = JSON.parse(readFileSync(${JSON.stringify(join(root, "circuits", "keys", "login_offchain_proof.json"))}, 'utf8'));
const vectors = JSON.parse(readFileSync(${JSON.stringify(join(root, "packages", "common", "fixtures", "vectors.json"))}, 'utf8'));
const vk = JSON.parse(readFileSync(${JSON.stringify(join(root, "packages", "verify", "keys", "login_vk.json"))}, 'utf8'));
const builtins = new Set(builtinModules);
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('node:') || builtins.has(specifier)) throw new Error('edge runtime: ' + context.parentURL + ' imports ' + specifier);
    const conditions = ['edge-light', 'worker', 'browser', 'import', 'module', 'default', ...(context.conditions.includes('require') ? ['require'] : [])];
    return next(specifier, { ...context, conditions });
  },
});
const NodeBuffer = globalThis.Buffer;
delete globalThis.Buffer;
const refuse = (name) => () => { throw new WebAssembly.CompileError('WebAssembly.' + name + '(): Wasm code generation disallowed by embedder'); };
WebAssembly.compile = async (...args) => refuse('compile')(...args);
WebAssembly.instantiate = async (...args) => refuse('instantiate')(...args);
WebAssembly.Module = refuse('Module');
const verify = await import('@ghostlink/verify');
assert.deepEqual(verify.bundledLoginVerificationKey(), vk);
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const key32 = new Uint8Array(NodeBuffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url'));
const nonce = new Uint8Array(randomBytes(32));
const signature = new Uint8Array(sign(null, verify.loginChallengeDigest(nonce), privateKey));
assert.equal(verify.verifyLoginChallenge({ key32, nonce, signature }), true);
const pub = vectors.circuits.login.public;
const result = await verify.verifyLogin({ proof: fixture.proof, publicSignals: fixture.publicSignals, expectedDomain: vectors.identity.origin,
  roots: async () => ({ registry: [pub.registry_root], census: [pub.census_root] }) });
assert.equal(result.ok, false);
assert.match(result.reason, /^proof verifier unavailable on this runtime \\(server configuration\\): .*disallowed by embedder/);
const { createProver, createWorkerProver } = await import('@ghostlink/prover-wasm');
assert.equal(typeof createProver, 'function');
await assert.rejects(createWorkerProver({ login: { wasmUrl: 'https://a.invalid/l.wasm', zkeyUrl: 'https://a.invalid/l.zkey' } }).prove('login', {}), /Web Workers are unavailable/);
console.log('Edge-like runtime: verify and prover-wasm load without Node built-ins; challenge check works; proof check reports server configuration.');
process.exit(0);
`);
  execFileSync(process.execPath, [join(consumer, "edge.mjs")], { cwd: consumer, stdio: "inherit" });
  if (includeBot) {
    writeFileSync(join(consumer, "bot.mjs"), `
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { BotKeyStore, BotOnboarding, createBotAuthorizationServer, verifyTelegramInitData } from '@ghostlink/bot';
import { createRpcPool } from '@ghostlink/service-kit/rpc';
const rpc = createRpcPool({ genesisHash: '11111111111111111111111111111111', endpoints: [{ url: 'https://example.invalid' }] });
assert.equal(rpc.connection.rpcEndpoint, 'https://ghostlink-rpc.invalid');
rpc.close();
await assert.rejects(rpc.connection.getSlot(), /closed/);
const key = randomBytes(32);
const path = join(process.cwd(), 'consumer.sqlite');
const store = new BotKeyStore(path, key);
const backup = join(process.cwd(), 'consumer.enc');
await store.backupTo(backup);
const restoredPath = BotKeyStore.restoreBackup(backup, join(process.cwd(), 'restored-consumer'), key);
const restored = new BotKeyStore(restoredPath, key);
restored.close();
const rotatedKey = randomBytes(32);
store.rotateKey(rotatedKey);
assert.throws(() => new BotKeyStore(path, key));
store.close();
const reopened = new BotKeyStore(path, rotatedKey);
assert.equal(JSON.stringify(reopened), '{}');
reopened.close(); key.fill(0); rotatedKey.fill(0);
assert.equal(typeof BotOnboarding, 'function');
assert.equal(typeof BotOnboarding.prototype.prepareIntent, 'function');
assert.equal(typeof BotOnboarding.prototype.orderStatus, 'function');
assert.equal(typeof BotOnboarding.prototype.cancelOrder, 'function');
assert.equal(typeof createBotAuthorizationServer, 'function');
assert.throws(() => verifyTelegramInitData('forged', '12345:' + 'a'.repeat(32)));
console.log('Installed bot package: dependencies, encrypted backup/restore, key rotation, restart and authentication boundary verified.');
`);
    execFileSync(process.execPath, [join(consumer, "bot.mjs")], { cwd: consumer, stdio: "inherit" });
    execFileSync(process.execPath, ["-e", "import('@ghostlink/bot').then(bot => { if (typeof bot.BotKeyStore !== 'function') process.exit(1); });"], { cwd: consumer, stdio: "inherit" });
  }
  writeFileSync(join(consumer, "check.cjs"), `
Promise.all([import('@ghostlink/sdk'), import('@ghostlink/verify'), import('@ghostlink/prover-wasm'), import('@ghostlink/react')])
  .then(([sdk, verify, prover, react]) => {
    if (typeof sdk.GhostLink !== 'function' || verify.bundledLoginVerificationKey().protocol !== 'groth16'
      || typeof prover.createWorkerProver !== 'function' || typeof react.GhostLinkProvider !== 'function') process.exit(1);
    console.log('CommonJS dynamic import verified, including the bundled verifying key');
  });
`);
  execFileSync(process.execPath, [join(consumer, "check.cjs")], { cwd: consumer, stdio: "inherit" });
  writeFileSync(join(consumer, "check.mts"), `
import { GhostLink, sessionPublicKey, OwnerConsentController, type OwnerConsentOptions, type OwnerConsentExpectations,
  type SessionAuthorizationParams, type SessionPublicKey, prepareFundingTransaction, type FundingApproval } from '@ghostlink/sdk';
import type { BotConsentStatus } from '@ghostlink/common';
const review = (options: OwnerConsentOptions, status: BotConsentStatus, expected: OwnerConsentExpectations) => new OwnerConsentController(options).review(status, expected);
void review;
const authorize = (client: GhostLink, params: SessionAuthorizationParams) => client.authorizeSession(params);
const key: SessionPublicKey = sessionPublicKey(0, new Uint8Array(32));
const deposit = (bytes: Uint8Array, approval: FundingApproval): Uint8Array => prepareFundingTransaction(bytes, approval);
void authorize; void key; void deposit;
import { verifyLogin, verifyLoginChallenge, type VerifyLoginParams, type LoginChallengeSignature } from '@ghostlink/verify';
import { createProver, type ProverConfig } from '@ghostlink/prover-wasm';
import { useGhostLink, type GhostLinkContextValue, type GhostLinkLoginFlow } from '@ghostlink/react';
const verified = (params: VerifyLoginParams, challenge: LoginChallengeSignature) => verifyLogin(params).then(r => r.ok && verifyLoginChallenge(challenge));
// A login-only prover plugs straight into the SDK client.
const loginOnly: ProverConfig = { login: { wasmUrl: '/login.wasm', zkeyUrl: '/login.zkey', wasmSha256: '00'.repeat(32), zkeySha256: '00'.repeat(32) } };
const client = () => GhostLink.init({ cluster: 'localnet', indexer: 'http://127.0.0.1:8787', prover: createProver(loginOnly) });
const signIn = (flow: GhostLinkLoginFlow) => { const context: GhostLinkContextValue = useGhostLink(); return context.ensureClient().then(() => context.login(flow)); };
void verified; void client; void signIn;
// The worker prover is a Prover too, and its entry resolves as a subpath.
import { createWorkerProver, type WorkerLike, type WorkerProver } from '@ghostlink/prover-wasm';
import type * as WorkerEntry from '@ghostlink/prover-wasm/worker';
type WorkerEntryModule = typeof WorkerEntry;
void (null as unknown as WorkerEntryModule);
const inWorker = (createWorker: () => WorkerLike): WorkerProver => createWorkerProver({ ...loginOnly, createWorker, timeoutMs: 60_000 });
const workerClient = (createWorker: () => WorkerLike) => GhostLink.init({ cluster: 'localnet', indexer: 'http://127.0.0.1:8787', prover: inWorker(createWorker) });
const cancellable = (p: WorkerProver, signal: AbortSignal) => p.prove('login', {}, { signal }).finally(() => p.terminate());
void workerClient; void cancellable;
${includeBot ? "import { BotOnboarding, type BotOnboardingOptions, type BotConsent, type BotIntentParams, type BotOrderStatus } from '@ghostlink/bot';\nconst initBot = (options: BotOnboardingOptions) => new BotOnboarding(options);\nconst prepare = (m: BotOnboarding, c: BotConsent, requestKey: string, params: BotIntentParams) => m.prepareIntent(c.id, c, { requestKey, params });\nconst status = (m: BotOnboarding, c: BotConsent, requestKey: string): BotOrderStatus => m.orderStatus(c.id, c, requestKey);\nvoid initBot; void prepare; void status;" : ""}
`);
  // Every ```ts example in these documents must compile against the installed archives, so documented
  // flows cannot drift from the API. A document's examples form one program in order (later ones use what
  // earlier ones built); their `import { ... } from "..."` lines are merged at the top.
  const snippetDocs = ["README.md", "packages/sdk/README.md", "packages/verify/README.md", "docs/INTEGRATIONS.md", "docs/OWNER-RECOVERY.md"];
  const snippetFiles = [];
  for (const doc of snippetDocs) {
    const blocks = [...readFileSync(join(root, doc), "utf8").replace(/\r\n/g, "\n").matchAll(/^```ts\n([\s\S]*?)^```$/gm)].map(m => m[1]);
    if (blocks.length === 0) continue;
    const imports = new Map();
    const bodies = blocks.map(block => block.replace(/^import\s+(type\s+)?\{([^}]*)\}\s*from\s*"([^"]+)";?[ \t]*$/gm, (_, typeOnly, names, from) => {
      const set = imports.get(from) ?? new Set();
      imports.set(from, set);
      for (const name of names.split(",").map(n => n.trim()).filter(Boolean)) set.add(typeOnly && !name.startsWith("type ") ? `type ${name}` : name);
      return "";
    }));
    if (bodies.some(body => /^\s*import\s/m.test(body))) throw new Error(`${doc}: write example imports as import { ... } from "..."`);
    const header = [...imports].map(([from, names]) =>
      `import { ${[...names].filter(n => !(n.startsWith("type ") && names.has(n.slice(5)))).join(", ")} } from "${from}";`);
    const file = `doc-${doc.replace(/[\\/.]/g, "-")}.mts`;
    writeFileSync(join(consumer, file), `${header.join("\n")}\n${bodies.join("\n")}\nexport {};\n`);
    snippetFiles.push(file);
  }
  if (snippetFiles.length < 4) throw new Error(`expected TypeScript examples in the README files, found ${snippetFiles.length} documents`);
  const require = createRequire(join(root, "packages", "sdk", "package.json"));
  // Both resolution modes integrators use: Node's (NodeNext) and bundlers' (Bundler, as in Next.js and Vite).
  for (const resolution of [["--module", "NodeNext", "--moduleResolution", "NodeNext"], ["--module", "ESNext", "--moduleResolution", "Bundler"]]) {
    execFileSync(process.execPath, [require.resolve("typescript/bin/tsc"), "--noEmit", "--strict", "--skipLibCheck", "--target", "ES2022", ...resolution, "check.mts", ...snippetFiles], { cwd: consumer, stdio: "inherit" });
  }
  console.log(`Documentation examples compiled: ${snippetFiles.join(", ")}`);
  // Best effort: a locked file on Windows must not fail a check that already passed.
  try { rmSync(consumer, { recursive: true, force: true, maxRetries: 3 }); } catch { console.warn(`Could not remove ${consumer}`); }
  console.log("Isolated consumer and type declarations verified");
}
console.log(`SDK archives and checksums: ${destination}`);
