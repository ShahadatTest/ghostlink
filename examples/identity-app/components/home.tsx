"use client";
/**
 * The identity app's own page: register the identity once, snapshot
 * holdings for token-gated sites, and manage the pocket the identity has at
 * any site (revoke its session, sweep its funds home).
 */
import { useEffect, useState } from "react";
import { IndexerRequestError, WitnessPendingError, webDomainStore } from "@ghostlink/sdk";
import { pk, toBase58 } from "@ghostlink/common";
import { NATIVE_MINT, snapshotFor } from "../lib/approve";
import { lookupPocket, revokePocket, sweepPocket, type PocketView } from "../lib/owner";
import { s } from "../lib/styles";
import { useIdentity } from "./identity";
import { Button, Frame, WalletPanel } from "./ui";

const VISITED = "identity-app:visited-origins";

export function Home() {
  const { config, wallet, identity } = useIdentity();
  return (
    <Frame title="Your identity">
      <p>Sites that offer this sign-in open this app in a small window. You approve each sign-in here, and each site
        gets its own ID for you. Your identity never leaves this app.</p>
      {config.pinsFromServedFiles && (
        <p style={s.note}>Development setup: proving files are served from this machine and pinned to their own hashes.</p>
      )}
      <WalletPanel />
      {wallet && identity && <Registration />}
      {wallet && identity && <Snapshot />}
      {wallet && identity && <Pockets />}
    </Frame>
  );
}

function Registration() {
  const { client, wallet, identity, run } = useIdentity();
  const [status, setStatus] = useState<string>("Not checked yet.");
  const check = () => run("Checking the registry…", async () => {
    const gl = await client();
    try {
      await gl.witness({ identity: identity!, wallet: wallet!.publicKey });
      setStatus("Registered. Sites can ask you to sign in.");
    } catch (e) {
      if (e instanceof WitnessPendingError) setStatus("Registered. It can be used in about a minute.");
      else if (e instanceof IndexerRequestError && e.status === 404) setStatus("Not registered (or registered moments ago and not indexed yet).");
      else throw e;
    }
  });
  // Check once on mount; the button checks again.
  useEffect(() => { void check(); }, []);
  const register = () => run("Registering: the wallet signs the registration message once; the relayer pays…", async () => {
    const gl = await client();
    await gl.register({ identity: identity!, wallet: wallet!.publicKey, signMessage: wallet!.signer.signMessage });
    setStatus("Registered. It can be used in about a minute.");
  });
  return (
    <section style={s.section} aria-labelledby="reg-heading">
      <h2 id="reg-heading" style={s.h2}>Registration</h2>
      <p>{status}</p>
      <p style={s.muted}>The relayer pays the fee, but registers only wallets that hold a little SOL.
        A wallet can register exactly one identity, once. Registration publishes a commitment to your
        identity next to your wallet address; it reveals nothing about which sites you use.</p>
      <div style={s.row}>
        <Button onClick={() => void register()}>Register this identity</Button>
        <Button secondary onClick={() => void check()}>Check again</Button>
      </div>
    </section>
  );
}

function Snapshot() {
  const { client, wallet, run } = useIdentity();
  const [mint, setMint] = useState(NATIVE_MINT);
  const [done, setDone] = useState<string | null>(null);
  const take = () => run("Taking a snapshot; the relayer pays the fee…", async () => {
    const gl = await client();
    const mintBytes = pk(mint.trim());
    if (mintBytes.length !== 32) throw new Error("not a mint address");
    await gl.snapshot(snapshotFor(wallet!.publicKey, mintBytes));
    setDone(`Snapshot of ${mint === NATIVE_MINT ? "SOL" : mint} recorded. Sites can check it in about a minute.`);
  });
  return (
    <section style={s.section} aria-labelledby="snap-heading">
      <h2 id="snap-heading" style={s.h2}>Holdings snapshots</h2>
      <p style={s.muted}>Some sites ask you to prove you hold a token. A snapshot records your wallet&apos;s balance of
        one token now; proofs then show &quot;at least this much&quot; without your address or exact balance.</p>
      <label style={s.label} htmlFor="mint">Token mint</label>
      <input id="mint" style={s.input} value={mint} onChange={(e) => setMint(e.target.value)} spellCheck={false} autoComplete="off" />
      <p style={s.muted}>{NATIVE_MINT} means native SOL.</p>
      <div style={s.row}>
        <Button onClick={() => void take()}>Take snapshot</Button>
      </div>
      {done && <p role="status">{done}</p>}
    </section>
  );
}

function Pockets() {
  const { config, client, wallet, identity, run } = useIdentity();
  const [origins, setOrigins] = useState<string[]>([]);
  const [origin, setOrigin] = useState("");
  const [view, setView] = useState<PocketView | null>(null);
  const [mints, setMints] = useState("");
  const [result, setResult] = useState<string | null>(null);
  useEffect(() => { setOrigins(webDomainStore(VISITED).load()); }, []);

  const look = (o = origin) => run("Looking up the pocket…", async () => {
    setResult(null);
    setView(await lookupPocket(await client(), identity!, o.trim()));
  });
  const act = (kind: "revoke" | "sweep") => {
    if (!view) return;
    const text = kind === "revoke"
      ? `End the session at ${view.origin} now? Any app or bot using it stops at once.`
      : `Send every balance in this pocket to its recovery home ${view.state ? toBase58(view.state.home) : ""}?`;
    if (!window.confirm(text)) return;
    void run(kind === "revoke" ? "Proving the revoke on this device…" : "Proving the sweep on this device…", async () => {
      const params = { client: await client(), identity: identity!, wallet: wallet!.publicKey, origin: view.origin };
      const signature = kind === "revoke" ? await revokePocket(params)
        : await sweepPocket({ ...params, mints: mints.split(/[\s,]+/).filter(Boolean) });
      setResult(`Confirmed: ${signature}`);
      await look(view.origin);
    });
  };

  return (
    <section style={s.section} aria-labelledby="pocket-heading">
      <h2 id="pocket-heading" style={s.h2}>Your pocket at a site</h2>
      <p style={s.muted}>A site or bot you approved may hold a spending pocket for you. Look it up by the site&apos;s address.</p>
      <label style={s.label} htmlFor="origin">Site address</label>
      <input id="origin" style={s.input} list="visited" placeholder="https://app.example.com" value={origin}
        onChange={(e) => setOrigin(e.target.value)} spellCheck={false} autoComplete="off" />
      <datalist id="visited">{origins.map((o) => <option key={o} value={o} />)}</datalist>
      {origins.length > 0 && <p style={s.muted}>Sites you signed in to from this browser are suggested.</p>}
      <div style={s.row}><Button onClick={() => void look()} off={!origin.trim()}>Look up</Button></div>
      {view && (
        <div>
          <dl style={s.dl}>
            <dt>Site</dt><dd style={s.code}>{view.origin}</dd>
            <dt>Your ID there</dt><dd style={s.code}>{view.appId}</dd>
            <dt>Pocket</dt><dd style={s.code}>{view.address}</dd>
            {view.state ? <>
              <dt>Recovery home</dt><dd style={s.code}>{toBase58(view.state.home)}</dd>
              <dt>Session</dt><dd>{view.state.sessionExpirySlot === 0n ? "none (revoked or never opened)" : `expires at slot ${view.state.sessionExpirySlot}`}</dd>
              <dt>Daily limit</dt><dd>{(Number(view.state.policy.dailyCapUsdE6) / 1e6).toFixed(2)} USD</dd>
              <dt>Pending change</dt><dd>{view.state.pending ? `executes after slot ${view.state.pending.executableAfterSlot}` : "none"}</dd>
            </> : <><dt>State</dt><dd>No pocket exists for this site.</dd></>}
          </dl>
          {view.state && (
            config.owner ? (
              <>
                <label style={s.label} htmlFor="mints">Token mints to sweep (up to two, optional)</label>
                <input id="mints" style={s.input} value={mints} onChange={(e) => setMints(e.target.value)} spellCheck={false} autoComplete="off" />
                <div style={s.row}>
                  <Button onClick={() => act("revoke")}>Revoke session</Button>
                  <Button secondary onClick={() => act("sweep")}>Sweep funds home</Button>
                </div>
              </>
            ) : <p style={s.note}>Owner actions need the owner circuit: set OWNER_WASM_URL and OWNER_ZKEY_URL.</p>
          )}
          {result && <p role="status" style={s.code}>{result}</p>}
        </div>
      )}
    </section>
  );
}
