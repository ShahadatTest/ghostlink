/** Ends this site's session (the form on the signed-in page posts here). */
import { siteConfig } from "../../../../lib/config";
import { sameOrigin } from "../../../../lib/sign-in";
import { SESSION_COOKIE, sessionCookieId, store } from "../../../../lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const config = siteConfig();
  if (!sameOrigin(request.headers.get("origin"), config)) return Response.json({ code: "cross_origin" }, { status: 403 });
  store().endSession(sessionCookieId(request.headers.get("cookie")));
  return new Response(null, {
    status: 303,
    headers: { location: `${config.siteOrigin}/`, "set-cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` },
  });
}
