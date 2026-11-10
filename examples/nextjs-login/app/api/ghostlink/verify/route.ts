/**
 * Step 2: verify the sign-in and start a session. Runs on the Node.js
 * runtime: @ghostlink/verify checks the Groth16 proof with snarkjs, which
 * edge runtimes cannot run.
 */
import { siteConfig } from "../../../../lib/config";
import { sameOrigin, verifySignIn } from "../../../../lib/sign-in";
import { SESSION_COOKIE, store } from "../../../../lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A sign-in body is a few kilobytes; refuse anything much larger before parsing it. */
const MAX_BODY_BYTES = 16_384;

export async function POST(request: Request): Promise<Response> {
  const config = siteConfig();
  if (!sameOrigin(request.headers.get("origin"), config)) return Response.json({ code: "cross_origin" }, { status: 403 });
  const text = await request.text();
  let body: unknown;
  try {
    if (text.length > MAX_BODY_BYTES) throw new Error("too large");
    body = JSON.parse(text);
  } catch {
    return Response.json({ code: "malformed_request" }, { status: 400 });
  }
  const result = await verifySignIn({ body, config, store: store() });
  if (!result.ok) {
    // The code is safe to show; it says which check failed, nothing about the user.
    return Response.json({ code: result.code }, { status: result.status });
  }
  const secure = config.siteOrigin.startsWith("https:") ? "; Secure" : "";
  return Response.json({ appId: result.appId }, {
    headers: {
      "set-cookie": `${SESSION_COOKIE}=${result.sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${result.maxAgeSeconds}${secure}`,
      "cache-control": "no-store",
    },
  });
}
