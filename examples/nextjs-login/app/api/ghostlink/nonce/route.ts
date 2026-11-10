/** Step 1: a single-use nonce for one sign-in attempt. */
import { siteConfig } from "../../../../lib/config";
import { issueChallenge, sameOrigin } from "../../../../lib/sign-in";
import { store } from "../../../../lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const config = siteConfig();
  if (!sameOrigin(request.headers.get("origin"), config)) return Response.json({ code: "cross_origin" }, { status: 403 });
  try {
    return Response.json(issueChallenge(store()), { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ code: "busy" }, { status: 503 });
  }
}
