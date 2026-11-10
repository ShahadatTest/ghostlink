"use client";
/**
 * The identity session of one page: the GhostLink client, the connected
 * wallet and the derived identity. The identity (whose secret derives every
 * site's ID) lives in React state only. It is never stored, never sent and
 * forgotten when the page closes or the user locks it, so every page load
 * asks the wallet to sign the identity message again.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { GhostLink, deriveIdentity, jsonRpcChainReader, type DerivedIdentity } from "@ghostlink/sdk";
import { createWorkerProver } from "@ghostlink/prover-wasm";
import type { PublicConfig } from "../lib/public-config";
import { connectWallet, developmentWallet, usable, watchWallets, type ConnectedWallet, type StandardWallet } from "../lib/wallets";

export interface IdentityContextValue {
  config: PublicConfig;
  /** Null until created on first use, or when the configuration is unusable. */
  client: () => Promise<GhostLink>;
  wallets: StandardWallet[];
  wallet: ConnectedWallet | null;
  identity: DerivedIdentity | null;
  /** The host shown in the identity message wallets sign. */
  identityDomain: string;
  busy: string | null;
  error: string | null;
  setError: (message: string | null) => void;
  connect: (wallet: StandardWallet | "development") => Promise<void>;
  unlock: () => Promise<DerivedIdentity | null>;
  lock: () => void;
  /** Runs `task` with a busy label, keeping its error visible. Resolves undefined on failure. */
  run: <T>(label: string, task: () => Promise<T>) => Promise<T | undefined>;
}

const Ctx = createContext<IdentityContextValue | null>(null);

export function useIdentity(): IdentityContextValue {
  const value = useContext(Ctx);
  if (!value) throw new Error("useIdentity must be used inside <IdentityProvider>");
  return value;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function IdentityProvider({ config, children }: { config: PublicConfig; children: ReactNode }) {
  const [wallets, setWallets] = useState<StandardWallet[]>([]);
  const [wallet, setWallet] = useState<ConnectedWallet | null>(null);
  const [identity, setIdentity] = useState<DerivedIdentity | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [host, setHost] = useState("");
  const clientRef = useRef<Promise<GhostLink> | null>(null);

  useEffect(() => {
    setHost(window.location.host);
    return watchWallets((all) => setWallets(all.filter(usable)));
  }, []);

  const client = useCallback(() => {
    clientRef.current ??= GhostLink.init({
      cluster: config.deployment.cluster,
      deployment: config.deployment,
      indexer: config.indexer,
      relayer: config.relayer,
      chain: jsonRpcChainReader(config.rpc),
      // Proofs run in a Web Worker on this device, from artifacts pinned by SHA-256.
      prover: config.login ? createWorkerProver({ login: config.login, ...(config.owner ? { owner: config.owner } : {}), timeoutMs: 180_000 }) : undefined,
    }).catch((e: unknown) => { clientRef.current = null; throw e; });
    return clientRef.current;
  }, [config]);

  const run = useCallback(async <T,>(label: string, task: () => Promise<T>): Promise<T | undefined> => {
    setBusy(label);
    setError(null);
    try {
      return await task();
    } catch (e) {
      setError(message(e));
      return undefined;
    } finally {
      setBusy(null);
    }
  }, []);

  const connect = useCallback(async (choice: StandardWallet | "development") => {
    await run("Connecting the wallet…", async () => {
      const connected = choice === "development" ? developmentWallet() : await connectWallet(choice);
      setIdentity(null);
      setWallet(connected);
    });
  }, [run]);

  const identityDomain = config.identityDomain ?? host;

  const unlock = useCallback(async () => {
    if (!wallet) return null;
    const derived = await run("Waiting for the wallet to sign the identity message (twice)…", () =>
      deriveIdentity(wallet.signer, { cluster: config.deployment.cluster, domain: identityDomain, address: wallet.address }));
    if (derived) setIdentity(derived);
    return derived ?? null;
  }, [wallet, run, config.deployment.cluster, identityDomain]);

  const lock = useCallback(() => {
    // Overwrite the secret's bytes too; other references (a finished proof's input) were already dropped.
    identity?.secret.fill(0);
    setIdentity(null);
  }, [identity]);

  const value = useMemo<IdentityContextValue>(() => ({
    config, client, wallets, wallet, identity, identityDomain, busy, error, setError, connect, unlock, lock, run,
  }), [config, client, wallets, wallet, identity, identityDomain, busy, error, connect, unlock, lock, run]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
