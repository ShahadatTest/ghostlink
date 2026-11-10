import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import bs58 from "bs58";
import {
  CENSUS_PROGRAM_ID, DeploymentError, LOCALNET_DEPLOYMENT, POCKET_PROGRAM_ID, PUBLIC_GENESIS_HASHES, REGISTRY_PROGRAM_ID,
  assertDeploymentGenesis, botDeployment, checkBotDeployment, conservativePolicy, developmentSessionDeployment,
  parseDeployment, pocketAuthorizationContext, pocketPda, registryTreePda, sessionDeployment, usesBuiltinProgramIds,
  verifyingKeyDigest, type DeploymentManifest,
} from "../src/index.js";

const DEVNET = PUBLIC_GENESIS_HASHES.devnet, MAINNET = PUBLIC_GENESIS_HASHES["mainnet-beta"];
const LOCAL_GENESIS = bs58.encode(new Uint8Array(32).fill(7));
const address = (byte: number) => bs58.encode(new Uint8Array(32).fill(byte));
const own = { registryProgram: address(1), censusProgram: address(2), pocketProgram: address(3) };
const keys = { ...LOCALNET_DEPLOYMENT.verifyingKeys };
const manifest = (fields: Partial<Record<keyof DeploymentManifest, unknown>> = {}): Record<string, unknown> =>
  ({ version: 1, cluster: "devnet", genesisHash: DEVNET, ...own, verifyingKeys: keys, ...fields });
const refused = (raw: unknown, message: RegExp) => {
  expect(() => parseDeployment(raw)).toThrow(DeploymentError);
  expect(() => parseDeployment(raw)).toThrow(message);
};

describe("deployment manifest", () => {
  it("describes the committed programs as the built-in localnet deployment", () => {
    expect(LOCALNET_DEPLOYMENT).toEqual({ version: 1, cluster: "localnet", registryProgram: REGISTRY_PROGRAM_ID,
      censusProgram: CENSUS_PROGRAM_ID, pocketProgram: POCKET_PROGRAM_ID, verifyingKeys: keys });
    expect(Object.isFrozen(LOCALNET_DEPLOYMENT) && Object.isFrozen(LOCALNET_DEPLOYMENT.verifyingKeys)).toBe(true);
    expect(parseDeployment(LOCALNET_DEPLOYMENT)).toEqual(LOCALNET_DEPLOYMENT);
    expect(usesBuiltinProgramIds(LOCALNET_DEPLOYMENT)).toBe(true);
    expect(sessionDeployment(LOCALNET_DEPLOYMENT)).toEqual(developmentSessionDeployment());
  });

  it("pins the built-in verifying key digests to the committed keys", () => {
    for (const [name, path] of [["login", "../../../circuits/keys/login_vk.json"], ["owner", "../../../circuits/keys/owner_vk.json"],
      ["login", "../../verify/keys/login_vk.json"]] as const) {
      const vk = JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
      expect(verifyingKeyDigest(vk)).toBe(LOCALNET_DEPLOYMENT.verifyingKeys[name]);
      // Formatting and key order do not change the digest; content does.
      const reordered = Object.fromEntries(Object.entries(vk).reverse());
      expect(verifyingKeyDigest(JSON.parse(JSON.stringify(reordered, null, 4)))).toBe(LOCALNET_DEPLOYMENT.verifyingKeys[name]);
      expect(verifyingKeyDigest({ ...vk, nPublic: vk.nPublic + 1 })).not.toBe(LOCALNET_DEPLOYMENT.verifyingKeys[name]);
    }
    expect(() => verifyingKeyDigest("not a key")).toThrow(/JSON object/);
  });

  it("accepts a public deployment with its own program IDs and the cluster's genesis", () => {
    const d = parseDeployment(manifest());
    expect(d).toEqual(manifest());
    expect(Object.isFrozen(d)).toBe(true);
    expect(parseDeployment(manifest({ cluster: "mainnet-beta", genesisHash: MAINNET })).cluster).toBe("mainnet-beta");
    expect(parseDeployment(manifest({ cluster: "localnet", genesisHash: undefined })).genesisHash).toBeUndefined();
    expect(parseDeployment(manifest({ cluster: "localnet", genesisHash: LOCAL_GENESIS })).genesisHash).toBe(LOCAL_GENESIS);
  });

  it("refuses the built-in program IDs on public clusters, naming each one", () => {
    refused(manifest({ pocketProgram: POCKET_PROGRAM_ID }), /pocketProgram uses a built-in program ID.*preserved V1/);
    refused(manifest({ cluster: "mainnet-beta", genesisHash: MAINNET, registryProgram: REGISTRY_PROGRAM_ID, censusProgram: CENSUS_PROGRAM_ID }),
      /registryProgram, censusProgram uses a built-in program ID/);
    refused({ ...LOCALNET_DEPLOYMENT, cluster: "devnet", genesisHash: DEVNET }, /built-in program ID/);
  });

  it("refuses malformed manifests with specific messages", () => {
    for (const raw of [null, [], "x", 1, new (class {})()]) refused(raw, /must be a JSON object/);
    refused({ ...manifest(), programs: [] }, /unknown field "programs"/);
    refused({ ...manifest(), pocketProgram: undefined }, /pocketProgram must be a canonical/);
    const { censusProgram: _, ...missing } = manifest();
    refused(missing, /missing censusProgram/);
    refused(manifest({ version: 2 }), /version must be 1/);
    refused(manifest({ cluster: "testnet" }), /cluster must be localnet, devnet or mainnet-beta/);
    refused(manifest({ registryProgram: "not base58!" }), /registryProgram must be a canonical base58/);
    refused(manifest({ censusProgram: bs58.encode(new Uint8Array(31)) }), /censusProgram must be a canonical base58/);
    refused(manifest({ pocketProgram: own.registryProgram }), /three different addresses/);
    refused(manifest({ genesisHash: undefined }), /devnet deployment must name the devnet genesis/);
    refused(manifest({ genesisHash: MAINNET }), /not the devnet genesis hash/);
    refused(manifest({ genesisHash: LOCAL_GENESIS }), /not the devnet genesis hash/);
    refused(manifest({ cluster: "localnet", genesisHash: DEVNET }), /localnet deployment cannot name the devnet genesis/);
    refused(manifest({ genesisHash: 5 }), /genesisHash must be a canonical/);
    refused(manifest({ verifyingKeys: { login: keys.login } }), /verifyingKeys must be/);
    refused(manifest({ verifyingKeys: { ...keys, owner: keys.owner.toUpperCase() } }), /verifyingKeys must be/);
    refused(manifest({ verifyingKeys: { ...keys, extra: keys.owner } }), /verifyingKeys must be/);
  });

  it("checks the deployment against the RPC's actual genesis", () => {
    const devnet = parseDeployment(manifest()), local = parseDeployment(manifest({ cluster: "localnet", genesisHash: undefined }));
    expect(() => assertDeploymentGenesis(devnet, DEVNET)).not.toThrow();
    expect(() => assertDeploymentGenesis(devnet, MAINNET)).toThrow(/does not match the deployment genesis/);
    expect(() => assertDeploymentGenesis(devnet, LOCAL_GENESIS)).toThrow(/does not match the deployment genesis/);
    expect(() => assertDeploymentGenesis(local, LOCAL_GENESIS)).not.toThrow();
    expect(() => assertDeploymentGenesis(LOCALNET_DEPLOYMENT, LOCAL_GENESIS)).not.toThrow();
    for (const genesis of [DEVNET, MAINNET]) {
      expect(() => assertDeploymentGenesis(LOCALNET_DEPLOYMENT, genesis)).toThrow(/localnet deployment refuses the (devnet|mainnet-beta) genesis/);
      expect(() => assertDeploymentGenesis(local, genesis)).toThrow(DeploymentError);
    }
    const pinned = parseDeployment(manifest({ cluster: "localnet", genesisHash: LOCAL_GENESIS }));
    expect(() => assertDeploymentGenesis(pinned, address(9))).toThrow(/does not match/);
    expect(() => assertDeploymentGenesis(devnet, "garbage")).toThrow(/RPC genesis hash must be/);
    // An unchecked object cannot smuggle the built-in IDs past the rule.
    expect(() => assertDeploymentGenesis({ ...LOCALNET_DEPLOYMENT, cluster: "devnet", genesisHash: DEVNET }, DEVNET)).toThrow(/built-in/);
  });

  it("projects a manifest onto the bot consent deployment under the same rule", () => {
    const devnet = parseDeployment(manifest());
    expect(botDeployment(devnet, DEVNET)).toEqual({ cluster: "devnet", genesisHash: DEVNET, ...own });
    expect(botDeployment(LOCALNET_DEPLOYMENT, LOCAL_GENESIS)).toEqual({ cluster: "localnet", genesisHash: LOCAL_GENESIS,
      pocketProgram: POCKET_PROGRAM_ID, registryProgram: REGISTRY_PROGRAM_ID, censusProgram: CENSUS_PROGRAM_ID });
    expect(() => botDeployment(LOCALNET_DEPLOYMENT, DEVNET)).toThrow(/refuses the devnet genesis/);
    const bot = { cluster: "devnet", genesisHash: DEVNET, ...own };
    expect(checkBotDeployment(bot)).toEqual(bot);
    expect(() => checkBotDeployment({ ...bot, pocketProgram: POCKET_PROGRAM_ID })).toThrow(/built-in program ID/);
    expect(() => checkBotDeployment({ ...bot, cluster: "localnet" })).toThrow(/localnet deployment cannot name the devnet genesis/);
    expect(() => checkBotDeployment({ ...bot, genesisHash: undefined })).toThrow(/genesisHash must be/);
    expect(() => checkBotDeployment({ ...bot, extra: 1 })).toThrow(/exactly cluster/);
  });

  it("derives PDAs and the authorization context from the manifest's programs", () => {
    const d = parseDeployment(manifest()), ids = sessionDeployment(d), policy = conservativePolicy();
    expect(ids.pocketProgram).toEqual(bs58.decode(own.pocketProgram));
    expect(pocketPda(5n, ids.pocketProgram).address).not.toEqual(pocketPda(5n).address);
    expect(registryTreePda(ids.registryProgram).address).not.toEqual(registryTreePda().address);
    const builtin = pocketAuthorizationContext(policy, 0), custom = pocketAuthorizationContext(policy, 0, ids);
    expect(custom).not.toBe(builtin);
    expect(pocketAuthorizationContext(policy, 0, sessionDeployment(LOCALNET_DEPLOYMENT))).toBe(builtin);
  });
});
