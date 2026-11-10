import type { PolicyDto } from "./api.js";
import type { Cluster } from "./constants.js";

/** The deployment identity a bot consent binds; see `checkBotDeployment`. */
export interface BotDeployment {
  cluster: Cluster;
  genesisHash: string;
  pocketProgram: string;
  registryProgram: string;
  censusProgram: string;
}

/** Public consent fields only. No bot seed, owner identity or witness. */
export interface BotConsent {
  version: 1;
  id: string;
  botId: string;
  userId: string;
  appOrigin: string;
  deployment: BotDeployment;
  appId: string;
  pocket: string;
  home: string;
  policy: PolicyDto;
  sessionKeyHex: string;
  sessionExpirySlot: string;
  createdAt: number;
  expiresAt: number;
}

export type BotConsentState = "pending" | "confirmed" | "cancelled" | "expired";
export interface BotConsentStatus {
  consent: BotConsent;
  state: BotConsentState;
  confirmedSlot?: number;
  observedSlot?: number;
}
