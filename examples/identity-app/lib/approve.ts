/**
 * What happens when the user approves a site's sign-in request: gather the
 * witness, prove for the requesting origin on this device, answer. The
 * same function the consent screen calls is what scripts/handoff-e2e.ts in
 * the starter site drives against a local validator.
 *
 * Only `request.approve` sends anything to the site, and it sends the proof,
 * its public signals and the expiry. The identity, the wallet address and
 * the witness stay here.
 */
import {
  IndexerRequestError, WitnessPendingError,
  type DerivedIdentity, type GhostLink, type HandoffLoginRequest, type SnapshotParams,
} from "@ghostlink/sdk";
import { bytesToHex, pk } from "@ghostlink/common";

/** The mint ID census snapshots of native SOL use. */
export const NATIVE_MINT = "So11111111111111111111111111111111111111112";

export interface ApproveParams {
  client: GhostLink;
  identity: DerivedIdentity;
  wallet: Uint8Array;
  request: HandoffLoginRequest;
  /** The longest session this app grants; a request for more gets this. */
  maxSessionSlots: bigint;
  /** Wait for a registration or snapshot that is not provable yet, instead of failing. */
  wait?: { timeoutMs: number; pollMs?: number; signal?: AbortSignal };
  onStep?: (step: "witness" | "proving" | "sending") => void;
}

/** Proves the request for `request.origin` and sends it there. Resolves with the user's ID for that site (base58). */
export async function approveLogin(params: ApproveParams): Promise<string> {
  const { client, identity, wallet, request } = params;
  params.onStep?.("witness");
  const witness = await client.witness({ identity, wallet, mint: request.claim?.mint, wait: params.wait });
  const currentSlot = await client.currentSlot();
  const slots = request.sessionSlots < params.maxSessionSlots ? request.sessionSlots : params.maxSessionSlots;
  params.onStep?.("proving");
  const authorization = await client.forOrigin(request.origin).authorizeLogin({
    identity, witness, claim: request.claim, currentSlot, session: request.session, expirySlot: currentSlot + slots,
  });
  params.onStep?.("sending");
  request.approve({ proof: authorization.proof, expirySlot: authorization.expirySlot });
  return authorization.appIdBase58;
}

/** The snapshot that would satisfy a claim on `mint`: native SOL is the wallet itself. */
export function snapshotFor(wallet: Uint8Array, mint: Uint8Array): SnapshotParams {
  return bytesToHex(mint) === bytesToHex(pk(NATIVE_MINT)) ? { wallet, holding: wallet } : { wallet, mint };
}

/** A failure as the user should read it, and the code the site receives if they give up. */
export function explainFailure(error: unknown): { code: "not_registered" | "pending" | "claim_unmet" | "unavailable" | "internal"; message: string; canSnapshot: boolean } {
  const text = error instanceof Error ? error.message : String(error);
  if (error instanceof WitnessPendingError) {
    return { code: "pending", canSnapshot: false,
      message: "Your registration or snapshot is recorded but not provable yet (about a minute after it confirms). Try again shortly." };
  }
  if (error instanceof IndexerRequestError && error.status === 404) {
    return error.path.startsWith("/census")
      ? { code: "claim_unmet", canSnapshot: true, message: "There is no snapshot of this token for your wallet yet." }
      : { code: "not_registered", canSnapshot: false, message: "This wallet has no identity registered yet. Register it on the home page first." };
  }
  if (/does not satisfy the holdings claim/.test(text)) {
    return { code: "claim_unmet", canSnapshot: true,
      message: "Your latest snapshot of this token is too old or below what the site asks for." };
  }
  if (/registered with a different identity/.test(text)) {
    return { code: "not_registered", canSnapshot: false,
      message: "This wallet is registered with a different identity (another identity domain, cluster or second factor)." };
  }
  if (error instanceof TypeError || /HTTP 5\d\d|fetch|network/i.test(text)) {
    return { code: "unavailable", canSnapshot: false, message: `A service did not answer: ${text}` };
  }
  return { code: "internal", canSnapshot: false, message: text };
}
