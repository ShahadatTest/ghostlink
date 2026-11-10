"use client";
/** Small shared pieces: the page frame, buttons that stay focusable while busy, and the wallet panel. */
import { useState, type ReactNode } from "react";
import { dimmed, s } from "../lib/styles";
import { requestLocalAirdrop } from "../lib/wallets";
import { useIdentity } from "./identity";

export function Frame({ title, children }: { title?: string; children: ReactNode }) {
  const { config, busy, error, setError } = useIdentity();
  return (
    <main style={s.main}>
      <header style={s.header}>
        <p style={s.appName}>{config.appName}</p>
        <span style={s.muted}>{config.deployment.cluster}</span>
      </header>
      {title && <h1 style={s.h1}>{title}</h1>}
      {config.problems.length > 0 && (
        <div role="alert" style={s.error}>
          <strong>This app is not fully configured.</strong>
          <ul style={s.list}>{config.problems.map((p) => <li key={p}>{p}</li>)}</ul>
        </div>
      )}
      {children}
      <p role="status" aria-live="polite" style={s.status}>{busy ?? ""}</p>
      {error && (
        <div role="alert" style={s.error}>
          <p style={{ margin: 0 }}>{error}</p>
          <button type="button" style={{ ...s.secondary, marginTop: 8 }} onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}
    </main>
  );
}

export function Button({ children, onClick, secondary, off }: { children: ReactNode; onClick: () => void; secondary?: boolean; off?: boolean }) {
  const { busy } = useIdentity();
  const disabled = Boolean(off || busy);
  return (
    <button type="button" aria-disabled={disabled} style={dimmed(secondary ? s.secondary : s.button, disabled)}
      onClick={() => { if (!disabled) onClick(); }}>
      {children}
    </button>
  );
}

/** Choose a wallet, then derive the identity from it. */
export function WalletPanel() {
  const { config, wallets, wallet, identity, identityDomain, connect, unlock, lock, run } = useIdentity();
  const [funded, setFunded] = useState(false);
  if (!wallet) {
    return (
      <section style={s.section} aria-labelledby="wallet-heading">
        <h2 id="wallet-heading" style={s.h2}>Connect a wallet</h2>
        <p style={s.muted}>Your wallet only signs messages here. It is never asked to sign a transaction.</p>
        <div style={s.row}>
          {wallets.map((w) => <Button key={w.name} onClick={() => void connect(w)}>{w.name}</Button>)}
          {config.devWallet && <Button secondary onClick={() => void connect("development")}>Development wallet</Button>}
        </div>
        {wallets.length === 0 && (
          <p style={s.muted}>No Solana wallet found in this browser. Install one that supports the Wallet Standard
            {config.devWallet ? ", or use the development wallet." : "."}</p>
        )}
      </section>
    );
  }
  return (
    <section style={s.section} aria-labelledby="wallet-heading">
      <h2 id="wallet-heading" style={s.h2}>Wallet</h2>
      <p style={s.muted}>{wallet.name}</p>
      <p style={s.code}>{wallet.address}</p>
      {config.deployment.cluster === "localnet" && (
        <div style={s.row}>
          <Button secondary onClick={() => void run("Requesting 2 test SOL from the local validator…", async () => {
            await requestLocalAirdrop(config.rpc, wallet.address);
            setFunded(true);
          })}>Get 2 test SOL</Button>
          {funded && <span role="status">2 test SOL received.</span>}
        </div>
      )}
      {identity ? (
        <>
          <p>Identity unlocked for this page. It is kept in memory only.</p>
          <div style={s.row}><Button secondary onClick={lock}>Lock</Button></div>
        </>
      ) : (
        <>
          <p>To use your identity, the wallet signs a fixed sign-in message for <strong>{identityDomain}</strong> twice.
            The identity is computed from that signature on this device and never leaves it.</p>
          <div style={s.row}><Button onClick={() => void unlock()}>Unlock identity</Button></div>
        </>
      )}
    </section>
  );
}
