import { sha256 } from "@noble/hashes/sha256";
import bs58 from "bs58";
import { CENSUS_PROGRAM_ID, POCKET_PROGRAM_ID, REGISTRY_PROGRAM_ID } from "./constants.js";
import { hashToField, type FieldElement } from "./field.js";
import { policyHash, type Policy } from "./intent.js";

/** Program identity binding; RPC genesis verification is a separate release gate. */
export interface SessionDeployment {
  pocketProgram: Uint8Array;
  registryProgram: Uint8Array;
  censusProgram: Uint8Array;
}

/** Fresh arrays on each call so caller mutation cannot change the defaults. */
export function developmentSessionDeployment(): SessionDeployment {
  return {
    pocketProgram: bs58.decode(POCKET_PROGRAM_ID),
    registryProgram: bs58.decode(REGISTRY_PROGRAM_ID),
    censusProgram: bs58.decode(CENSUS_PROGRAM_ID),
  };
}

const U64_MAX = (1n << 64n) - 1n;

/**
 * V2 login public signal 11. Zero is reserved for off-chain login only.
 * Pocket authorization binds the exact canonical policy, key kind,
 * deployment and the pocket's revocation epoch (`PocketV3.authorization_epoch`,
 * zero before the pocket exists) using SHA-256 reduced into BN254, like
 * owner action hashes. Every revoke raises the epoch, so a proof made before
 * it can never open a session afterwards. Home, session key/expiry and
 * domain are bound by the other login signals.
 */
export function pocketAuthorizationContext(
  policy: Policy,
  sessionKind: number,
  deployment: SessionDeployment = developmentSessionDeployment(),
  authorizationEpoch = 0n,
): FieldElement {
  if (sessionKind !== 0 && sessionKind !== 1) throw new Error("invalid session kind");
  if (typeof authorizationEpoch !== "bigint" || authorizationEpoch < 0n || authorizationEpoch > U64_MAX) {
    throw new Error("authorization epoch must be a u64");
  }
  const ids = [deployment.pocketProgram, deployment.registryProgram, deployment.censusProgram];
  for (const id of ids) {
    if (!(id instanceof Uint8Array) || id.length !== 32) throw new Error("deployment program must be 32 bytes");
  }
  const tag = new TextEncoder().encode("ghostlink:open-session:v3");
  const bytes = new Uint8Array(tag.length + 32 * 4 + 1 + 8);
  bytes.set(tag);
  ids.forEach((id, i) => bytes.set(id, tag.length + i * 32));
  bytes.set(policyHash(policy), tag.length + 96);
  bytes[tag.length + 128] = sessionKind;
  let epoch = authorizationEpoch;
  for (let i = 0; i < 8; i++) {
    bytes[tag.length + 129 + i] = Number(epoch & 0xffn);
    epoch >>= 8n;
  }
  return hashToField(sha256(bytes));
}

/** Offset of `authorization_epoch` in PocketV3 data: right after the fixed session fields. */
export const POCKET_AUTHORIZATION_EPOCH_OFFSET = 8 + 32 + 32 + 32 + 1 + 33 + 8;
const POCKET_DISCRIMINATOR = sha256(new TextEncoder().encode("account:PocketV3")).subarray(0, 8);

/**
 * Reads a pocket's revocation epoch from its account data, for the owner
 * software that proves a session authorization. Check that the account is
 * owned by the pocket program first; a missing pocket has epoch zero.
 */
export function pocketAuthorizationEpoch(data: Uint8Array): bigint {
  if (!(data instanceof Uint8Array) || data.length < POCKET_AUTHORIZATION_EPOCH_OFFSET + 8 ||
    !POCKET_DISCRIMINATOR.every((b, i) => data[i] === b)) {
    throw new Error("not a PocketV3 account");
  }
  let epoch = 0n;
  for (let i = 7; i >= 0; i--) epoch = (epoch << 8n) | BigInt(data[POCKET_AUTHORIZATION_EPOCH_OFFSET + i]!);
  return epoch;
}
