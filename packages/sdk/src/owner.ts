/**
 * Owner actions: getting funds home and changing what a bot may do.
 *
 * Every action is authorized by an owner proof made on the owner's device
 * from the identity secret and the registry witness. The proof binds the
 * pocket, the action, the pocket's current `owner_action_nonce` and, for a
 * change, the exact change, so it is good for exactly one action. Making
 * one is `GhostLink.proveOwnerAction`; this module holds the plain data
 * types and the wire request.
 */
import {
  bytesToHex, fieldToBytes32, toBase58,
  type FieldElement, type OwnerActionRequest, type ProofBytes,
} from "@ghostlink/common";
import type { PocketChange } from "./chain.js";

export type OwnerActionKind = "sweep" | "revoke" | "propose" | "cancel";

/**
 * One proved owner action. Public data: it can authorize only this action
 * on this pocket at this nonce, and anyone may submit it. Submit it once;
 * after a lost reply check the chain (the nonce moved or not) instead of
 * proving again.
 */
export interface OwnerAuthorization {
  action: OwnerActionKind;
  /** The pocket address (32 bytes). */
  pocket: Uint8Array;
  appId: FieldElement;
  /** The nonce the proof binds; the action consumes it. */
  ownerActionNonce: bigint;
  /** Sweep only: the pocket's recovery home read from the chain. Funds go only there. */
  home?: Uint8Array;
  /** Propose and cancel: the change, and its Borsh encoding the proof binds. */
  change?: PocketChange;
  changeBorsh?: Uint8Array;
  /** The registry root the proof was made against; the program checks it is in the root ring. */
  registryRoot: FieldElement;
  proof: ProofBytes;
}

/** A sweep's token accounts: the pocket-owned `source`, and optionally where in home it goes. */
export interface SweepTokenPair {
  source: Uint8Array;
  /** Omit to let the relayer pick or create a clean home-owned account (docs/OWNER-RECOVERY.md). */
  destination?: Uint8Array;
  mint?: Uint8Array;
}

/**
 * The relayer's `POST /owner-action` body for a proved action. For a sweep
 * pass every pocket-owned token account to empty (at most two per request
 * are tested to fit a transaction); surplus SOL is always returned.
 */
export function ownerActionRequest(authorization: OwnerAuthorization, options: { tokenPairs?: readonly SweepTokenPair[] } = {}): OwnerActionRequest {
  const a = authorization;
  if (a.action !== "sweep" && options.tokenPairs?.length) throw new Error("token pairs belong to a sweep");
  const request: OwnerActionRequest = {
    pocket: toBase58(a.pocket),
    action: a.action,
    proofAHex: bytesToHex(a.proof.a),
    proofBHex: bytesToHex(a.proof.b),
    proofCHex: bytesToHex(a.proof.c),
    registryRootHex: bytesToHex(fieldToBytes32(a.registryRoot)),
  };
  if (a.action === "sweep") {
    if (!(a.home instanceof Uint8Array) || a.home.length !== 32) throw new Error("a sweep authorization carries the pocket's home");
    request.home = toBase58(a.home);
    request.tokenPairs = (options.tokenPairs ?? []).map((p) => ({
      source: toBase58(p.source),
      ...(p.destination ? { destination: toBase58(p.destination) } : {}),
      ...(p.mint ? { mint: toBase58(p.mint) } : {}),
    }));
  }
  if (a.action === "propose") {
    if (!(a.changeBorsh instanceof Uint8Array)) throw new Error("a propose authorization carries its change");
    request.changeHex = bytesToHex(a.changeBorsh);
  }
  return request;
}
