#!/usr/bin/env node
/**
 * Small helpers for scripts/selfhost.sh, with no dependencies:
 *
 *   field <file.json> <dotted.path>   prints a JSON field (exit 3 when absent)
 *   genesis <rpc url>                 prints the RPC's genesis hash (exit 1 when unreachable)
 *   probe <url>                       GETs a service endpoint and prints one line:
 *                                     "ready", "not ready: <failing checks>" or "no answer";
 *                                     exit 0 for HTTP 200, 1 for another status, 2 for no answer
 */
import { readFileSync } from "node:fs";

const [command, ...args] = process.argv.slice(2);

if (command === "field" && args.length === 2) {
  let value = JSON.parse(readFileSync(args[0], "utf8"));
  for (const key of args[1].split(".")) value = value?.[key];
  if (value === undefined || value === null) process.exit(3);
  console.log(typeof value === "object" ? JSON.stringify(value) : String(value));
} else if (command === "genesis" && args.length === 1) {
  try {
    const response = await fetch(args[0], { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getGenesisHash" }), signal: AbortSignal.timeout(10_000) });
    const body = await response.json();
    if (typeof body.result !== "string") process.exit(1);
    console.log(body.result);
  } catch { process.exit(1); }
} else if (command === "probe" && args.length === 1) {
  let response;
  try { response = await fetch(args[0], { signal: AbortSignal.timeout(5_000) }); } catch { console.log("no answer"); process.exit(2); }
  let body = {};
  try { body = await response.json(); } catch { /* the status alone decides */ }
  if (response.status === 200) { console.log("ready"); process.exit(0); }
  const failing = body && typeof body.checks === "object" && body.checks !== null
    ? Object.entries(body.checks).filter(([, ok]) => ok === false).map(([name]) => name) : [];
  console.log(failing.length ? `not ready: ${failing.join(", ")}` : `not ready (HTTP ${response.status})`);
  process.exit(1);
} else {
  console.error("usage: selfhost.mjs field <file> <path> | genesis <rpc url> | probe <url>");
  process.exit(2);
}
