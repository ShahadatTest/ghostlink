"use client";
/**
 * The consent screen a site opens in a popup. The site that is asking is
 * the origin the browser reported for the request (`request.origin`),
 * never anything the request says about itself; that origin is what the
 * user sees and what the proof is made for.
 */
import { useEffect, useRef, useState } from "react";
import { listenForHandoffRequest, rememberDomain, webDomainStore, type HandoffLoginRequest } from "@ghostlink/sdk";
import { toBase58 } from "@ghostlink/common";
import { NATIVE_MINT, approveLogin, explainFailure, snapshotFor } from "../lib/approve";
import { dimmed, s } from "../lib/styles";
import { useIdentity } from "./identity";
import { Button, Frame, WalletPanel } from "./ui";

type Phase =
  | { kind: "starting" }
  | { kind: "no-opener" }
  | { kind: "waiting" }
  | { kind: "request" }
  | { kind: "failed"; code: string; message: string; canSnapshot: boolean }
  | { kind: "approved"; appId: string }
  | { kind: "declined" }
  | { kind: "gave-up" };

/** A slot is about 400 ms: show durations the way a person reads them. */
function slotsToText(slots: bigint): string {
  const minutes = Number(slots) * 0.4 / 60;
  if (minutes < 90) return `about ${Math.max(1, Math.round(minutes))} minutes`;
  return `about ${Math.round(minutes / 60)} hours`;
}

/** How long the Approve button stays inactive after the request appears (against click-through tricks). */
const ARM_DELAY_MS = 1_000;

export function Handoff() {
  const { config, client, wallet, identity, run } = useIdentity();
  const [phase, setPhase] = useState<Phase>({ kind: "starting" });
  const [request, setRequest] = useState<HandoffLoginRequest | null>(null);
  const [armed, setArmed] = useState(false);
  const [step, setStep] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    // Once per page: React's development double-mount must not start a second responder.
    if (started.current) return;
    started.current = true;
    const responder = listenForHandoffRequest({ onRequest: (r) => { setRequest(r); setPhase({ kind: "request" }); } });
    setPhase(responder.opened ? { kind: "waiting" } : { kind: "no-opener" });
  }, []);

  // Arm Approve only after the request has been visible, in a focused window, for a moment:
  // a page that opens this window under the user's pointer cannot turn a click meant for it into consent.
  useEffect(() => {
    if (phase.kind !== "request") return;
    setArmed(false);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(timer);
      if (document.visibilityState === "visible" && document.hasFocus()) timer = setTimeout(() => setArmed(true), ARM_DELAY_MS);
      else setArmed(false);
    };
    arm();
    window.addEventListener("focus", arm);
    window.addEventListener("blur", arm);
    document.addEventListener("visibilitychange", arm);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", arm);
      window.removeEventListener("blur", arm);
      document.removeEventListener("visibilitychange", arm);
    };
  }, [phase.kind]);

  const approve = async () => {
    if (!request || !wallet || !identity || !request.open) return;
    const gl = await run("Starting…", client);
    if (!gl) return;
    try {
      const appId = await approveLogin({
        client: gl, identity, wallet: wallet.publicKey, request, maxSessionSlots: BigInt(config.maxSessionSlots),
        onStep: (st) => setStep(st === "witness" ? "Checking your registration…" : st === "proving" ? "Proving on this device…" : "Sending to the site…"),
      });
      rememberDomain(webDomainStore("identity-app:visited-origins"), request.origin);
      setPhase({ kind: "approved", appId });
    } catch (error) {
      setPhase({ kind: "failed", ...explainFailure(error) });
    } finally {
      setStep(null);
    }
  };

  const snapshot = async () => {
    if (!request?.claim || !wallet) return;
    const gl = await run("Starting…", client);
    if (!gl) return;
    const done = await run("Taking a snapshot of your balance (about a minute until it can be proved)…", async () => {
      await gl.snapshot(snapshotFor(wallet.publicKey, request.claim!.mint));
      await gl.witness({ identity: identity!, wallet: wallet.publicKey, mint: request.claim!.mint, wait: { timeoutMs: 240_000 } });
      return true;
    });
    if (done) setPhase({ kind: "request" });
  };

  if (phase.kind === "starting") return <Frame><p>Loading…</p></Frame>;
  if (phase.kind === "no-opener") {
    return (
      <Frame title="Nothing to approve">
        <p>This page answers sign-in requests from other sites. Open it with a site&apos;s sign-in button.</p>
        <p><a href="/">Go to {config.appName}</a></p>
      </Frame>
    );
  }
  if (phase.kind === "waiting" || !request) {
    return <Frame title="Waiting for the site"><p>Waiting for the site that opened this window to send its request…</p></Frame>;
  }
  const site = new URL(request.origin);
  if (phase.kind === "approved") {
    return (
      <Frame title="Signed in">
        <p>You are signed in to <strong>{site.host}</strong>. This window closes by itself; if it stays open, close it.</p>
        <p style={s.muted}>Your ID there: <span style={s.code}>{phase.appId}</span></p>
      </Frame>
    );
  }
  if (phase.kind === "declined" || phase.kind === "gave-up") {
    return (
      <Frame title={phase.kind === "declined" ? "Declined" : "Not signed in"}>
        <p>{site.host} was told {phase.kind === "declined" ? "that you declined" : "that the sign-in did not complete"}. You can close this window.</p>
      </Frame>
    );
  }

  const claim = request.claim;
  const ready = Boolean(wallet && identity) && config.problems.length === 0;
  const canApprove = ready && armed && request.open;
  const granted = request.sessionSlots < BigInt(config.maxSessionSlots) ? request.sessionSlots : BigInt(config.maxSessionSlots);
  return (
    <Frame title="Sign-in request">
      <p>This site asks you to sign in:</p>
      <strong style={s.origin}>{request.origin}</strong>
      {site.protocol === "http:" && <p style={s.note}>This site uses an unencrypted local address. Expect this only while developing.</p>}
      <p style={s.muted}>Check the address. Only approve if it is the site you were using.</p>

      <section style={s.section} aria-labelledby="shares-heading">
        <h2 id="shares-heading" style={s.h2}>The site will receive</h2>
        <ul style={s.list}>
          <li>An ID that only this site sees. It is the same each time you sign in here, and different on every other site.</li>
          {claim && <li>Proof that your wallet held at least <strong>{claim.threshold.toString()}</strong> base units of
            token <span style={s.code}>{toBase58(claim.mint) === NATIVE_MINT ? "SOL" : toBase58(claim.mint)}</span> in
            a snapshot taken within {slotsToText(claim.maxAgeSlots)} before this sign-in.</li>}
          <li>A sign-in that lasts {slotsToText(granted)}.</li>
        </ul>
        <p style={s.muted}>It will not receive your wallet address or anything that links your accounts on different sites.</p>
      </section>

      {phase.kind !== "failed" && <WalletPanel />}

      {phase.kind === "failed" && (
        <div role="alert" style={s.error}>
          <p style={{ marginTop: 0 }}>{phase.message}</p>
          <div style={s.row}>
            <Button onClick={() => setPhase({ kind: "request" })}>Try again</Button>
            {phase.canSnapshot && claim && <Button secondary onClick={() => void snapshot()}>Take a new snapshot</Button>}
            <Button secondary onClick={() => { request.fail(phase.code, phase.message); setPhase({ kind: "gave-up" }); }}>Give up</Button>
          </div>
        </div>
      )}

      {phase.kind === "request" && (
        <div style={s.row}>
          <button type="button" aria-disabled={!canApprove} style={dimmed(s.button, !canApprove)}
            onClick={() => { if (canApprove) void approve(); }}>
            Approve and sign in to {site.host}
          </button>
          <Button secondary onClick={() => { request.refuse(); setPhase({ kind: "declined" }); }}>Decline</Button>
        </div>
      )}
      <p role="status" aria-live="polite" style={s.status}>{step ?? (ready && !armed && phase.kind === "request" ? "Approve becomes available in a moment." : "")}</p>
    </Frame>
  );
}
