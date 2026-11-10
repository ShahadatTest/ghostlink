/**
 * Owner actions on the pocket this identity has at one site: look it up,
 * revoke its session, sweep its funds home. Each proof is made here, for
 * that site's origin, with the owner circuit; the relayer submits it.
 */
import { appId as deriveAppId, domainHash, pk, toBase58 } from "@ghostlink/common";
import {
  appIdToBase58, associatedTokenAddress, recoverPockets,
  type DerivedIdentity, type GhostLink, type PocketState,
} from "@ghostlink/sdk";

export interface PocketView {
  origin: string;
  /** The user's ID at that site, base58. */
  appId: string;
  address: string;
  state: PocketState | null;
}

export async function lookupPocket(client: GhostLink, identity: DerivedIdentity, origin: string): Promise<PocketView> {
  const forSite = client.forOrigin(origin);
  const [pocket] = recoverPockets(identity.sField, [forSite.origin()], client.deployment);
  return {
    origin: forSite.origin(),
    appId: appIdToBase58(deriveAppId(identity.sField, domainHash(forSite.origin()))),
    address: toBase58(pocket!.pocketAddress),
    state: await forSite.pocketState(pocket!.pocketAddress),
  };
}

export interface OwnerActionParams {
  client: GhostLink;
  identity: DerivedIdentity;
  wallet: Uint8Array;
  origin: string;
}

/** Ends the pocket's session now and invalidates every earlier session authorization. */
export async function revokePocket(params: OwnerActionParams): Promise<string> {
  const { client, identity, wallet, origin } = params;
  const witness = await client.witness({ identity, wallet });
  const forSite = client.forOrigin(origin);
  const receipt = await forSite.submitOwnerAction(await forSite.proveOwnerAction({ identity, witness, action: "revoke" }));
  return receipt.signature ?? "";
}

/**
 * Returns the pocket's surplus SOL and the full balance of each named
 * token's pocket account to the home stored on chain. At most two mints
 * per sweep fit a transaction; sweep again for more.
 */
export async function sweepPocket(params: OwnerActionParams & { mints: readonly string[] }): Promise<string> {
  const { client, identity, wallet, origin } = params;
  if (params.mints.length > 2) throw new Error("sweep at most two token mints at a time");
  const witness = await client.witness({ identity, wallet });
  const forSite = client.forOrigin(origin);
  const authorization = await forSite.proveOwnerAction({ identity, witness, action: "sweep" });
  const tokenPairs = params.mints.map((m) => {
    const mint = pk(m);
    if (mint.length !== 32) throw new Error(`not a mint address: ${m}`);
    return { source: associatedTokenAddress(authorization.pocket, mint), mint };
  });
  const receipt = await forSite.submitOwnerAction(authorization, { tokenPairs });
  return receipt.signature ?? "";
}
