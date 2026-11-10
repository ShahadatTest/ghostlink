import type { DeploymentManifest } from "@ghostlink/common";

/** One circuit's proving artifacts, as the browser fetches them. */
export interface ArtifactConfig {
  wasmUrl: string;
  zkeyUrl: string;
  wasmSha256?: string;
  zkeySha256?: string;
}

/**
 * Everything the browser side needs, read from the environment on the
 * server at request time (lib/config.ts) and passed to client components
 * as plain JSON. Nothing here is secret.
 */
export interface PublicConfig {
  /** Shown in the title and on every screen. */
  appName: string;
  /** The host wallets show in the identity sign-in message; null means this page's own host. */
  identityDomain: string | null;
  deployment: DeploymentManifest;
  indexer: string;
  relayer: string;
  rpc: string;
  login: ArtifactConfig | null;
  owner: ArtifactConfig | null;
  /** True when the pins were computed from the locally served files (local development only). */
  pinsFromServedFiles: boolean;
  /** The longest login session this app grants, in slots (decimal). */
  maxSessionSlots: string;
  /** The in-browser development wallet (localnet only). */
  devWallet: boolean;
  /** Configuration problems to show instead of failing later. */
  problems: string[];
}
