"use client";
/**
 * The whole browser side: the button opens the identity app, and once the
 * user approves, this fetches a nonce, signs it with the session key the
 * proof binds, and posts everything to the verification route.
 */
import { useRouter } from "next/navigation";
import { ContinueWithGhostLink } from "@ghostlink/react";
import { hexToBytes } from "@ghostlink/common";
import type { HandoffLogin } from "@ghostlink/sdk";
import type { ButtonConfig } from "../lib/config";
import { button } from "../lib/styles";

async function post(path: string, body?: unknown) {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
  const json = await response.json() as Record<string, string>;
  if (!response.ok) throw new Error(`Sign-in refused by this site (${json.code ?? response.status}).`);
  return json;
}

export function SignIn({ config }: { config: ButtonConfig }) {
  const router = useRouter();
  const onSignIn = async (login: HandoffLogin) => {
    const { challengeId, nonce } = await post("/api/ghostlink/nonce");
    await post("/api/ghostlink/verify", { challengeId, ...await login.signChallenge(hexToBytes(nonce!)) });
    router.push("/signed-in");
  };
  return (
    <ContinueWithGhostLink
      identityOrigin={config.identityOrigin}
      sessionSlots={BigInt(config.sessionSlots)}
      claim={config.gate ? { mint: config.gate.mint, threshold: BigInt(config.gate.threshold), maxAgeSlots: BigInt(config.gate.maxAgeSlots) } : undefined}
      onSignIn={onSignIn}
      style={button}
    />
  );
}

