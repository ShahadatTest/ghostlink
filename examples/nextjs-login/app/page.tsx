import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SignIn } from "../components/sign-in";
import { buttonConfig, siteConfig } from "../lib/config";
import { SESSION_COOKIE, store } from "../lib/store";
import { main, muted } from "../lib/styles";

export const dynamic = "force-dynamic";

export default async function Home() {
  if (store().session((await cookies()).get(SESSION_COOKIE)?.value)) redirect("/signed-in");
  const config = siteConfig();
  const gate = config.gate;
  return (
    <main style={main}>
      <h1>Starter site</h1>
      <p>Sign in without an account or a password. A window from your identity app opens; approve there and you are back here, signed in.</p>
      {gate && <p style={muted}>Members only: you will be asked to prove you hold at least {gate.threshold.toString()} base units of {gate.mint}.</p>}
      <SignIn config={buttonConfig(config)} />
      <p style={muted}>This site learns an ID that is yours on this site only. It never sees your wallet address.</p>
    </main>
  );
}
