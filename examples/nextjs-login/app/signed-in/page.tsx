import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, store } from "../../lib/store";
import { code, main, muted, secondary } from "../../lib/styles";

export const dynamic = "force-dynamic";

export default async function SignedIn() {
  const session = store().session((await cookies()).get(SESSION_COOKIE)?.value);
  if (!session) redirect("/");
  return (
    <main style={main}>
      <h1>You are signed in</h1>
      <p>Your ID on this site:</p>
      <p style={code}><strong>{session.appId}</strong></p>
      <p style={muted}>Sign out and in again: the ID stays the same. Another site using the same identity app sees a different
        ID for you, and neither site can link the two.</p>
      {session.gate && <p>Verified: you hold at least {session.gate.threshold} base units of <span style={code}>{session.gate.mint}</span>.</p>}
      <form method="post" action="/api/ghostlink/sign-out">
        <button type="submit" style={secondary}>Sign out</button>
      </form>
    </main>
  );
}
