import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256 } from "@noble/hashes/sha256";
import * as sdk from "../src/index.js";
import { PasskeyFactorError, createPasskeyFactor, passkeyFactor } from "../src/index.js";

afterEach(() => vi.unstubAllGlobals());

const withPrf = (first: Uint8Array) => ({ getClientExtensionResults: () => ({ prf: { results: { first: first.slice().buffer } } }) });
const ids = (list?: { id: BufferSource }[]) => (list ?? []).map((c) => new Uint8Array(c.id as ArrayBuffer));

/** A mocked browser WebAuthn whose `create` fails the test unless a case supplies one. */
function webAuthn(get: (options: CredentialRequestOptions) => Promise<unknown>,
  create: (options: CredentialCreationOptions) => Promise<unknown> = async () => { throw new Error("create must not be called"); }) {
  const credentials = { get: vi.fn(get), create: vi.fn(create) };
  vi.stubGlobal("PublicKeyCredential", class {});
  vi.stubGlobal("navigator", { credentials });
  return credentials;
}

describe("passkey factor", () => {
  it("never creates a replacement passkey when reading one is cancelled, times out or finds none", async () => {
    // WebAuthn reports cancel, timeout and "no credential" as one NotAllowedError on purpose; abort is AbortError.
    for (const name of ["NotAllowedError", "AbortError"]) {
      const credentials = webAuthn(async () => { throw new DOMException("The operation either timed out or was not allowed.", name); });
      const error = await passkeyFactor("ghostlink.test").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PasskeyFactorError);
      expect(error).toMatchObject({ name: "PasskeyFactorError", code: "not-allowed", message: expect.stringMatching(/Never create a new passkey/) });
      expect(credentials.get).toHaveBeenCalledOnce();
      expect(credentials.create).not.toHaveBeenCalled();
    }
    const credentials = webAuthn(async () => null);
    await expect(passkeyFactor()).rejects.toMatchObject({ code: "not-allowed" });
    expect(credentials.create).not.toHaveBeenCalled();
    // The get-or-create helper that created on any refusal is gone from the public API.
    expect(sdk).not.toHaveProperty("obtainPasskeyFactor");
  });

  it("reads exactly the saved credential and reports missing PRF or WebAuthn as typed errors", async () => {
    const id = new Uint8Array([7, 8, 9]), first = new Uint8Array(32).fill(4);
    const credentials = webAuthn(async (options) => {
      expect(ids(options.publicKey!.allowCredentials)).toEqual([id]);
      return withPrf(first);
    });
    expect(await passkeyFactor("ghostlink.test", id)).toEqual(sha256(first));
    expect(credentials.create).not.toHaveBeenCalled();
    webAuthn(async () => ({ getClientExtensionResults: () => ({}) }));
    await expect(passkeyFactor("ghostlink.test", id)).rejects.toMatchObject({ code: "no-prf" });
    vi.stubGlobal("navigator", {});
    await expect(passkeyFactor()).rejects.toMatchObject({ code: "unavailable" });
  });

  it("creates only on an explicit call, with a fresh user handle and saved credentials excluded", async () => {
    const saved = new Uint8Array([1, 2, 3]), newId = new Uint8Array([4, 5, 6]), first = new Uint8Array(32).fill(6);
    const handles: Uint8Array[] = [];
    const credentials = webAuthn(async () => { throw new Error("get must not be called"); }, async (options) => {
      expect(ids(options.publicKey!.excludeCredentials)).toEqual([saved]);
      handles.push(new Uint8Array(options.publicKey!.user.id as ArrayBuffer));
      return { rawId: newId.slice().buffer, ...withPrf(first) };
    });
    expect(await createPasskeyFactor({ userName: "user", excludeCredentialIds: [saved] }))
      .toEqual({ factor: sha256(first), credentialId: newId });
    await createPasskeyFactor({ userName: "user", excludeCredentialIds: [saved] });
    // Distinct random handles: a mistaken second creation cannot overwrite the first passkey.
    expect(handles.map((h) => h.length)).toEqual([32, 32]);
    expect(handles[0]).not.toEqual(handles[1]);
    expect(credentials.get).not.toHaveBeenCalled();
    credentials.create.mockRejectedValueOnce(new DOMException("credential excluded", "InvalidStateError"));
    await expect(createPasskeyFactor({ userName: "user", excludeCredentialIds: [saved] })).rejects.toMatchObject({ code: "exists" });
    credentials.create.mockRejectedValueOnce(new DOMException("cancelled", "NotAllowedError"));
    await expect(createPasskeyFactor({ userName: "user" })).rejects.toMatchObject({ code: "not-allowed" });
    await expect(createPasskeyFactor({ userName: "user", userId: new Uint8Array(65) })).rejects.toThrow(/1-64 bytes/);
    expect(credentials.get).not.toHaveBeenCalled();
  });
});
