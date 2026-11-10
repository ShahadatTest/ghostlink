/**
 * Wallet discovery and connection through the Wallet Standard, with no
 * dependency: the app announces `wallet-standard:app-ready` and accepts
 * `wallet-standard:register-wallet` events, as the standard's reference
 * `getWallets()` does. Only message signing is used: the identity is
 * derived from a signature, and registration is a signed message the
 * relayer submits. This app never asks a wallet to sign a transaction.
 */
import { ed25519 } from "@noble/curves/ed25519";
import { toBase58 } from "@ghostlink/common";
import type { IdentitySigner, SolanaSignInInput, SolanaSignInOutput } from "@ghostlink/sdk";

interface StandardAccount {
  address: string;
  publicKey: Uint8Array;
  chains: readonly string[];
  features: readonly string[];
}

/** The parts of a Wallet Standard wallet this app reads. */
export interface StandardWallet {
  name: string;
  icon: string;
  chains: readonly string[];
  accounts: readonly StandardAccount[];
  features: Record<string, unknown>;
}

interface ConnectFeature { connect(input?: { silent?: boolean }): Promise<{ accounts: readonly StandardAccount[] }> }
interface SignMessageFeature { signMessage(...inputs: { account: StandardAccount; message: Uint8Array }[]): Promise<readonly { signature: Uint8Array }[]> }
interface SignInFeature { signIn(...inputs: SolanaSignInInput[]): Promise<readonly SolanaSignInOutput[]> }

/** A connected wallet: its address and the one capability this app needs. */
export interface ConnectedWallet {
  name: string;
  address: string;
  publicKey: Uint8Array;
  signer: IdentitySigner;
  /** True for the in-browser development wallet. */
  development: boolean;
}

/** True when the wallet can connect and sign messages. */
export function usable(wallet: StandardWallet): boolean {
  return "standard:connect" in wallet.features && "solana:signMessage" in wallet.features;
}

/** Calls `onChange` with every registered wallet now and whenever one registers. Returns a stop function. */
export function watchWallets(onChange: (wallets: StandardWallet[]) => void): () => void {
  const wallets = new Set<StandardWallet>();
  const api = {
    register(...added: StandardWallet[]) {
      for (const w of added) wallets.add(w);
      onChange([...wallets]);
      return () => {
        for (const w of added) wallets.delete(w);
        onChange([...wallets]);
      };
    },
  };
  const onRegister = (event: Event) => {
    const callback = (event as CustomEvent<unknown>).detail;
    if (typeof callback === "function") callback(api);
  };
  window.addEventListener("wallet-standard:register-wallet", onRegister);
  window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: api }));
  return () => window.removeEventListener("wallet-standard:register-wallet", onRegister);
}

/** Connects a Wallet Standard wallet and wraps its signing for `deriveIdentity` and registration. */
export async function connectWallet(wallet: StandardWallet): Promise<ConnectedWallet> {
  const { accounts } = await (wallet.features["standard:connect"] as ConnectFeature).connect();
  const account = accounts.find((a) => a.publicKey?.length === 32);
  if (!account) throw new Error(`${wallet.name} returned no Solana account`);
  const signMessage = async (message: Uint8Array) => {
    const [output] = await (wallet.features["solana:signMessage"] as SignMessageFeature).signMessage({ account, message });
    if (!output) throw new Error(`${wallet.name} returned no signature`);
    return output.signature;
  };
  const signIn = wallet.features["solana:signIn"] as SignInFeature | undefined;
  return {
    name: wallet.name,
    address: account.address,
    publicKey: Uint8Array.from(account.publicKey),
    signer: { signMessage, ...(signIn ? { signIn: (input: SolanaSignInInput) => signIn.signIn(input) } : {}) },
    development: false,
  };
}

const DEV_KEY = "identity-app:development-wallet-seed";

/**
 * A wallet for trying the app on a local validator without a browser
 * extension. Its key is random, kept in this browser's localStorage in the
 * clear, and only ever used on a local validator: never enable it elsewhere.
 */
export function developmentWallet(): ConnectedWallet {
  let seed: Uint8Array | undefined;
  try {
    const stored = localStorage.getItem(DEV_KEY);
    if (stored && /^[0-9a-f]{64}$/.test(stored)) seed = Uint8Array.from(stored.match(/../g)!.map((h) => parseInt(h, 16)));
  } catch { /* storage blocked: a new key for this page only */ }
  if (!seed) {
    seed = crypto.getRandomValues(new Uint8Array(32));
    try { localStorage.setItem(DEV_KEY, Array.from(seed, (b) => b.toString(16).padStart(2, "0")).join("")); } catch { /* see above */ }
  }
  const key = seed;
  const publicKey = ed25519.getPublicKey(key);
  return {
    name: "Development wallet (this browser, local validator only)",
    address: toBase58(publicKey),
    publicKey,
    signer: { signMessage: async (message) => ed25519.sign(message, key) },
    development: true,
  };
}

/** Asks a local validator for test SOL. Localnet only; public RPCs refuse or rate-limit this. */
export async function requestLocalAirdrop(rpc: string, address: string, lamports = 2_000_000_000): Promise<void> {
  const call = async (method: string, params: unknown[]) => {
    const response = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const body = await response.json() as { result?: unknown; error?: { message?: string } };
    if (body.error) throw new Error(`${method}: ${body.error.message ?? "RPC error"}`);
    return body.result;
  };
  const signature = await call("requestAirdrop", [address, lamports]) as string;
  for (let i = 0; i < 30; i++) {
    const statuses = await call("getSignatureStatuses", [[signature]]) as { value: ({ confirmationStatus?: string } | null)[] };
    const status = statuses.value[0]?.confirmationStatus;
    if (status === "confirmed" || status === "finalized") return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("the airdrop did not confirm in time");
}
