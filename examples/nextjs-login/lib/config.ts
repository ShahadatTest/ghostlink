/**
 * Server configuration from environment variables (example.env lists them).
 * Read on every request, so tests and one build can use different values.
 */
import { handoffOrigin } from "@ghostlink/sdk";

export interface Gate {
  /** Base58 mint address; So11111111111111111111111111111111111111112 is native SOL. */
  mint: string;
  threshold: bigint;
  /** How old a snapshot the button asks the identity app to prove. */
  maxAgeSlots: bigint;
  /** How old a snapshot this server accepts: a little wider than maxAgeSlots, for proving and transport. */
  windowSlots: bigint;
}

export interface SiteConfig {
  /** This site's own origin, exactly as browsers report it. Proofs must be bound to it. */
  siteOrigin: string;
  /** The identity app's origin, where the sign-in popup opens. */
  identityOrigin: string;
  /** Roots come from here (your indexer), never from the browser. */
  indexer: string;
  /** The current slot comes from here (your RPC), never from the browser. */
  rpc: string;
  /** Session length the button asks for, and the longest this server accepts. */
  sessionSlots: bigint;
  maxSessionSlots: bigint;
  gate: Gate | null;
}

const env = (name: string): string | undefined => process.env[name]?.trim() || undefined;

function slots(name: string, fallback: string): bigint {
  const value = env(name) ?? fallback;
  if (!/^[1-9][0-9]{0,8}$/.test(value)) throw new Error(`${name} must be a positive whole number of slots`);
  return BigInt(value);
}

function origin(name: string, fallback: string): string {
  const value = env(name) ?? fallback;
  const exact = handoffOrigin(value);
  if (!exact) throw new Error(`${name} must be an exact origin such as https://app.example.com (no path or trailing slash)`);
  return exact;
}

export function siteConfig(): SiteConfig {
  const siteOrigin = origin("SITE_ORIGIN", "http://localhost:3000");
  const identityOrigin = origin("IDENTITY_ORIGIN", "http://localhost:3001");
  if (siteOrigin === identityOrigin) throw new Error("IDENTITY_ORIGIN must differ from SITE_ORIGIN");
  const sessionSlots = slots("LOGIN_SESSION_SLOTS", "9000");
  let gate: Gate | null = null;
  const mint = env("GATE_MINT");
  if (mint) {
    const threshold = env("GATE_THRESHOLD") ?? "1";
    if (!/^(0|[1-9][0-9]{0,19})$/.test(threshold)) throw new Error("GATE_THRESHOLD must be a whole number of base units");
    const maxAgeSlots = slots("GATE_MAX_AGE_SLOTS", "9000");
    gate = { mint, threshold: BigInt(threshold), maxAgeSlots, windowSlots: maxAgeSlots + 1_000n };
  }
  return {
    siteOrigin,
    identityOrigin,
    indexer: env("GHOSTLINK_INDEXER_URL") ?? "http://127.0.0.1:8787",
    rpc: env("GHOSTLINK_RPC_URL") ?? "http://127.0.0.1:8899",
    sessionSlots,
    maxSessionSlots: sessionSlots,
    gate,
  };
}

/** What the browser needs to render the button: public values only. */
export function buttonConfig(config: SiteConfig) {
  return {
    identityOrigin: config.identityOrigin,
    sessionSlots: config.sessionSlots.toString(),
    gate: config.gate && { mint: config.gate.mint, threshold: config.gate.threshold.toString(), maxAgeSlots: config.gate.maxAgeSlots.toString() },
  };
}
export type ButtonConfig = ReturnType<typeof buttonConfig>;
