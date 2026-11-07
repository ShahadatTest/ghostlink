/**
 * A device-held second factor for the identity secret, from the WebAuthn
 * PRF extension: the passkey evaluates a pseudo-random function over a
 * fixed salt, and only an authenticator holding that passkey (or a
 * platform it syncs to) can reproduce the output. Mixed into the secret
 * (identity.ts), it means a phished wallet signature alone is useless.
 *
 * The passkey is therefore part of the identity: another passkey gives
 * another factor, so another secret, and the registry accepts one
 * registration per wallet. This module never creates a passkey by itself.
 * `passkeyFactor` only reads an existing one and throws a
 * `PasskeyFactorError` when the prompt is cancelled, times out or finds
 * no passkey (WebAuthn reports all three as the same NotAllowedError on
 * purpose, so a "none yet" answer cannot be told apart from a cancel).
 * `createPasskeyFactor` is a separate call for a wallet that has no
 * registration yet: most platforms let a new discoverable credential
 * with the same user handle replace the old one, which would make a
 * registered identity unrecoverable.
 *
 * Browser-only. Not every authenticator supports PRF; callers feature-
 * detect with `prfAvailable()` and fall back to signature-only with a
 * clear warning. The SDK persists nothing: the credential ID returned by
 * `createPasskeyFactor` is public, and an app that saves it can ask for
 * exactly that passkey and exclude it from later creations.
 */
import { sha256 } from "@noble/hashes/sha256";

const PRF_SALT = sha256(new TextEncoder().encode("ghostlink:identity-factor:v1"));

export interface PasskeyFactorOptions {
  /** Relying-party id (the site's host); defaults to the current host. */
  rpId?: string;
  /** Shown by the platform when creating the passkey. */
  userName: string;
  /**
   * WebAuthn user handle, 1–64 bytes. Prefer omitting it: each creation
   * then gets a fresh random handle, so a mistaken second creation adds a
   * passkey instead of replacing the one an identity depends on. A stable
   * handle (such as the wallet address) lets the platform overwrite it.
   */
  userId?: Uint8Array;
  /**
   * IDs of GhostLink passkeys this app saved earlier, sent as
   * `excludeCredentials`: an authenticator holding one refuses to create
   * another (`PasskeyFactorError` with code "exists").
   */
  excludeCredentialIds?: Uint8Array[];
}

export interface CreatedPasskeyFactor {
  /** 32 bytes for `deriveIdentity(..., { secondFactor })`. Secret: never store or send it. */
  factor: Uint8Array;
  /** The new credential's ID. Public; save it for `passkeyFactor` and `excludeCredentialIds`. */
  credentialId: Uint8Array;
}

/**
 * - "unavailable": no WebAuthn in this environment.
 * - "not-allowed": cancelled, timed out, or no matching passkey on offer.
 * - "no-prf": the authenticator or passkey does not support PRF.
 * - "exists": creation refused because an excluded credential is present.
 */
export type PasskeyFactorErrorCode = "unavailable" | "not-allowed" | "no-prf" | "exists";

export class PasskeyFactorError extends Error {
  constructor(readonly code: PasskeyFactorErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PasskeyFactorError";
  }
}

type PrfResults = { prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } } };

function available(): boolean {
  return typeof navigator !== "undefined" && !!navigator.credentials && typeof PublicKeyCredential !== "undefined";
}

/** True when this browser exposes WebAuthn at all; PRF itself is only known after a call. */
export function prfAvailable(): boolean {
  return available();
}

function webAuthn(): CredentialsContainer {
  if (!available()) throw new PasskeyFactorError("unavailable", "WebAuthn is not available in this environment");
  return navigator.credentials;
}

// Uint8Array.from copies Node Buffers too; Buffer.slice().buffer would expose its shared pool.
function buffer(u: Uint8Array): ArrayBuffer {
  return Uint8Array.from(u).buffer as ArrayBuffer;
}

function refused(e: unknown, message: string): unknown {
  const name = (e as { name?: unknown } | null)?.name;
  return name === "NotAllowedError" || name === "AbortError" ? new PasskeyFactorError("not-allowed", message, { cause: e }) : e;
}

const NOT_READ = "No passkey factor was read: the prompt was cancelled or timed out, or no matching GhostLink " +
  "passkey is on offer (WebAuthn does not say which). Retry, or use the device or passkey provider that holds " +
  "the original passkey. Never create a new passkey for a registered wallet: it derives a different identity.";

/**
 * Reads the factor from an existing GhostLink passkey. Never creates one.
 * Pass the `credentialId` saved at creation to ask for exactly that
 * passkey; without it the platform offers every discoverable GhostLink
 * passkey for `rpId`. Throws `PasskeyFactorError` ("not-allowed") on
 * cancel, timeout or no match, and ("no-prf") when the passkey lacks PRF.
 */
export async function passkeyFactor(rpId?: string, credentialId?: Uint8Array): Promise<Uint8Array> {
  const credentials = webAuthn();
  if (credentialId !== undefined && (!(credentialId instanceof Uint8Array) || credentialId.length === 0)) {
    throw new Error("credentialId must be non-empty bytes");
  }
  let cred: PublicKeyCredential | null;
  try {
    cred = (await credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rpId,
        allowCredentials: credentialId ? [{ type: "public-key", id: buffer(credentialId) }] : [],
        userVerification: "required",
        extensions: { prf: { eval: { first: buffer(PRF_SALT) } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
  } catch (e) {
    throw refused(e, NOT_READ);
  }
  if (!cred) throw new PasskeyFactorError("not-allowed", NOT_READ);
  const out = (cred.getClientExtensionResults() as PrfResults).prf?.results?.first;
  if (!out) throw new PasskeyFactorError("no-prf", "this passkey does not support the PRF extension");
  return sha256(new Uint8Array(out));
}

/**
 * Creates a discoverable GhostLink passkey with PRF enabled and returns
 * its first evaluation and credential ID. Call it only for a brand-new
 * identity (the wallet has no registry binding yet), never as a fallback
 * after `passkeyFactor` fails. Some platforms only evaluate PRF on `get`,
 * so this falls back to one restricted to the credential just created.
 */
export async function createPasskeyFactor(options: PasskeyFactorOptions): Promise<CreatedPasskeyFactor> {
  const credentials = webAuthn();
  const userId = options.userId ? Uint8Array.from(options.userId) : crypto.getRandomValues(new Uint8Array(32));
  if (userId.length < 1 || userId.length > 64) throw new Error("userId must be 1-64 bytes");
  let cred: PublicKeyCredential | null;
  try {
    cred = (await credentials.create({
      publicKey: {
        rp: { name: "GhostLink", id: options.rpId },
        user: { id: buffer(userId), name: options.userName, displayName: options.userName },
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 },
        ],
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
        excludeCredentials: (options.excludeCredentialIds ?? []).map((id) => ({ type: "public-key" as const, id: buffer(id) })),
        extensions: { prf: { eval: { first: buffer(PRF_SALT) } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
  } catch (e) {
    if ((e as { name?: unknown } | null)?.name === "InvalidStateError") {
      throw new PasskeyFactorError("exists", "this authenticator already holds a saved GhostLink passkey; read it with passkeyFactor", { cause: e });
    }
    throw refused(e, "passkey creation was cancelled or timed out");
  }
  if (!cred) throw new PasskeyFactorError("not-allowed", "passkey creation was cancelled");
  const credentialId = new Uint8Array(cred.rawId);
  const results = cred.getClientExtensionResults() as PrfResults;
  if (results.prf?.enabled === false) throw new PasskeyFactorError("no-prf", "this authenticator does not support the PRF extension");
  const first = results.prf?.results?.first;
  // A discoverable get() could select an older credential and derive a
  // different permanent identity from the passkey just created.
  const factor = first ? sha256(new Uint8Array(first)) : await passkeyFactor(options.rpId, credentialId);
  return { factor, credentialId };
}
