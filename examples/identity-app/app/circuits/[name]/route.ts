/**
 * Local development only: serves the circuit files built by
 * scripts/build-circuits.sh (circuits/build, or GHOSTLINK_CIRCUITS_DIR) so
 * they never need to be copied into the app or committed. Four fixed names,
 * nothing else; on any other cluster this route answers 404 and the
 * artifacts come from LOGIN_* and OWNER_* URLs instead.
 */
import { createReadStream, statSync } from "node:fs";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { SERVED_CIRCUITS, circuitsDir } from "../../../lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ name: string }> }): Promise<Response> {
  const { name } = await context.params;
  const relative = Object.hasOwn(SERVED_CIRCUITS, name) ? SERVED_CIRCUITS[name] : undefined;
  const dir = circuitsDir();
  if (!relative || !dir) return new Response("not found", { status: 404 });
  const path = resolve(/*turbopackIgnore: true*/ dir, relative);
  let size: number;
  try { size = statSync(path).size; } catch { return new Response("not found", { status: 404 }); }
  const body = Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>;
  return new Response(body, {
    headers: {
      "content-type": name.endsWith(".wasm") ? "application/wasm" : "application/octet-stream",
      "content-length": String(size),
      "cache-control": "no-store",
    },
  });
}
