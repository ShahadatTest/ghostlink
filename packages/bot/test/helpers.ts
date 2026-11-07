import { createHmac } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { CENSUS_PROGRAM_ID, POCKET_PROGRAM_ID, REGISTRY_PROGRAM_ID, domainHash, fieldToBytes32, hexToBytes, pocketPda } from "@ghostlink/common";
import { policyFromDto } from "@ghostlink/sdk";
import { encodePocketAccount } from "@ghostlink/service-kit";
import type { BotConsent, BotDeployment } from "../src/index.js";

export const TOKEN = "12345:" + "a".repeat(32); // synthetic test token, no Telegram account
export const NOW = 1_800_000_000;
export const USER = { botId: "12345", userId: "42" };
export const deployment: BotDeployment = { cluster: "localnet", genesisHash: new PublicKey(new Uint8Array(32).fill(9)).toBase58(),
  pocketProgram: POCKET_PROGRAM_ID, registryProgram: REGISTRY_PROGRAM_ID, censusProgram: CENSUS_PROGRAM_ID };

export function initData(userId = 42, authDate = NOW, extra: Record<string, string> = {}, token = TOKEN) {
  const values = { auth_date: String(authDate), query_id: "test-query", user: JSON.stringify({ id: userId, first_name: "Fixture", is_bot: false }), ...extra };
  const check = Object.keys(values).sort().map(k => `${k}=${values[k as keyof typeof values]}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", secret).update(check).digest("hex");
  return new URLSearchParams({ ...values, hash }).toString();
}

export function pocketAccount(c: BotConsent, nonceBase = 0n, used: bigint[] = []) {
  const key = new Uint8Array(33); key.set(hexToBytes(c.sessionKeyHex));
  const bitmap = new Uint8Array(256);
  for (const n of used) { const bit = Number(n % 2048n); bitmap[Math.floor(bit / 8)]! |= 1 << (bit % 8); }
  const data = encodePocketAccount({ appId: fieldToBytes32(BigInt(c.appId)), domainHash: fieldToBytes32(domainHash(c.appOrigin)),
    home: new PublicKey(c.home), sessionKey: key, sessionExpirySlot: BigInt(c.sessionExpirySlot), policy: policyFromDto(c.policy),
    nonceBitmap: bitmap, bump: pocketPda(BigInt(c.appId), new PublicKey(c.deployment.pocketProgram).toBytes()).bump,
    maxSessionExpirySlot: BigInt(c.sessionExpirySlot), nonceBase });
  return { data, owner: new PublicKey(c.deployment.pocketProgram), executable: false, lamports: 1, rentEpoch: 0 };
}
