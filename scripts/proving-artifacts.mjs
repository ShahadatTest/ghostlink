#!/usr/bin/env node
/**
 * Development proving artifacts without circom.
 *
 * The .wasm witness generators and .zkey proving keys are too large for Git
 * and are never committed. The ones that match the committed verifying keys
 * (circuits/keys/*_vk.json) are published as assets of a GitHub release and
 * pinned by SHA-256 in circuits/keys/proving-artifacts.json.
 *
 *   node scripts/proving-artifacts.mjs fetch [--dir <dir>] [--from <dir-or-url>]
 *       Download the four files into <dir> (default circuits/build, the
 *       layout scripts/build-circuits.sh produces) and check each against
 *       its pin. Files already present and correct are kept. --from reads
 *       them from another directory or base URL instead of the release.
 *   node scripts/proving-artifacts.mjs verify [--dir <dir>]
 *       Check the files in <dir> against the pins; exit 1 on any mismatch.
 *   node scripts/proving-artifacts.mjs list
 *       Print each file's URL, size and SHA-256.
 *
 * These are single-party development keys: whoever generated them could
 * forge proofs. Never use them to protect real funds (docs/CEREMONY.md).
 * A fresh `scripts/build-circuits.sh` makes different keys, which no longer
 * match these pins or the committed verifying keys.
 *
 * No dependencies: plain Node 22.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PINS = join(ROOT, "circuits", "keys", "proving-artifacts.json");
const MAX_BYTES = 64 * 1024 * 1024;

function fail(message) {
  console.error(`proving-artifacts: ${message}`);
  process.exit(1);
}

function loadPins() {
  const pins = JSON.parse(readFileSync(PINS, "utf8"));
  const names = Object.keys(pins.files ?? {});
  if (typeof pins.baseUrl !== "string" || !pins.baseUrl.startsWith("https://") || names.length === 0) fail(`${PINS} is malformed`);
  for (const name of names) {
    const f = pins.files[name];
    if (!/^[A-Za-z0-9_.-]+$/.test(name) || typeof f.path !== "string" || !/^[A-Za-z0-9_./-]+$/.test(f.path) || f.path.includes("..") ||
      !Number.isSafeInteger(f.bytes) || f.bytes < 1 || f.bytes > MAX_BYTES || !/^[0-9a-f]{64}$/.test(f.sha256)) {
      fail(`${PINS}: entry ${name} is malformed`);
    }
  }
  return pins;
}

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

function option(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  if (i + 1 >= args.length) fail(`${name} needs a value`);
  return args[i + 1];
}

/** "ok", "missing" or a reason the file does not match its pin. */
function check(path, pin) {
  if (!existsSync(path)) return "missing";
  const bytes = readFileSync(path);
  if (bytes.length !== pin.bytes) return `is ${bytes.length} bytes, expected ${pin.bytes}`;
  const digest = sha256(bytes);
  return digest === pin.sha256 ? "ok" : `has SHA-256 ${digest}, expected ${pin.sha256}`;
}

async function read(source, name, pin) {
  if (!/^https?:\/\//.test(source)) {
    // A local directory, in either layout: flat (release assets) or circuits/build.
    for (const candidate of [join(source, name), join(source, pin.path)]) {
      if (existsSync(candidate)) return readFileSync(candidate);
    }
    fail(`${name} not found in ${source}`);
  }
  const url = `${source.replace(/\/+$/, "")}/${name}`;
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(300_000) });
  if (!response.ok) fail(`${url}: HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_BYTES) fail(`${url}: larger than expected`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_BYTES) fail(`${url}: larger than expected`);
  return bytes;
}

async function cmdFetch(args) {
  const pins = loadPins();
  const dir = resolve(option(args, "--dir") ?? join(ROOT, "circuits", "build"));
  const source = option(args, "--from") ?? pins.baseUrl;
  for (const [name, pin] of Object.entries(pins.files)) {
    const target = join(dir, pin.path);
    const state = check(target, pin);
    if (state === "ok") { console.log(`${name}: already present and verified`); continue; }
    if (state !== "missing") console.log(`${name}: existing file ${state}; replacing it`);
    const bytes = await read(source, name, pin);
    if (bytes.length !== pin.bytes || sha256(bytes) !== pin.sha256) {
      fail(`${name} from ${source} does not match its pin (${bytes.length} bytes, SHA-256 ${sha256(bytes)}); nothing was written`);
    }
    mkdirSync(dirname(target), { recursive: true });
    const temporary = `${target}.download`;
    writeFileSync(temporary, bytes);
    renameSync(temporary, target);
    console.log(`${name}: downloaded and verified (${pin.bytes} bytes)`);
  }
  console.log(`Development proving artifacts are in ${dir}. They match the committed verifying keys. Not for real funds.`);
}

function cmdVerify(args) {
  const pins = loadPins();
  const dir = resolve(option(args, "--dir") ?? join(ROOT, "circuits", "build"));
  let bad = 0;
  for (const [name, pin] of Object.entries(pins.files)) {
    const state = check(join(dir, pin.path), pin);
    console.log(`${name}: ${state === "ok" ? "verified" : state}`);
    if (state !== "ok") bad++;
  }
  if (bad) {
    console.error(`${bad} file(s) do not match circuits/keys/proving-artifacts.json. Run "node scripts/proving-artifacts.mjs fetch", ` +
      "or, if you built your own keys with scripts/build-circuits.sh, expect this: they are different keys.");
    process.exit(1);
  }
}

function cmdList() {
  const pins = loadPins();
  for (const [name, pin] of Object.entries(pins.files)) console.log(`${pins.baseUrl}/${name}  ${pin.bytes} bytes  sha256 ${pin.sha256}`);
}

const [command, ...rest] = process.argv.slice(2);
try {
  if (command === "fetch") await cmdFetch(rest);
  else if (command === "verify") cmdVerify(rest);
  else if (command === "list") cmdList();
  else {
    console.error("usage: node scripts/proving-artifacts.mjs fetch [--dir <dir>] [--from <dir-or-url>] | verify [--dir <dir>] | list");
    process.exit(2);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
