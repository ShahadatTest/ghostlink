import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import { DeploymentError } from "@ghostlink/common";
import {
  StartupError, describeStartupFailure, distinctPorts, integerVariable, lamportsVariable, openState, readKeypair, readStorageKey,
  requireGenesis, requirePin,
} from "../src/startup.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function file(name: string, contents: string | Uint8Array): string {
  const dir = mkdtempSync(join(tmpdir(), "ghostlink-startup-")); dirs.push(dir);
  const path = join(dir, name); writeFileSync(path, contents); return path;
}
const message = (fn: () => unknown) => { try { fn(); } catch (error) { return error; } throw new Error("expected a failure"); };

describe("startup diagnostics", () => {
  it("prints classified reasons and the generic line for anything else", () => {
    expect(describeStartupFailure("x startup failed", new StartupError("PORT is wrong"), "generic")).toBe("x startup failed: PORT is wrong");
    expect(describeStartupFailure("x startup failed", new DeploymentError("bad manifest"), "generic")).toBe("x startup failed: bad manifest");
    expect(describeStartupFailure("x startup failed", new Error("S3CRET"), "generic")).toBe("generic");
    expect(describeStartupFailure("x startup failed", new SyntaxError("S3CRET"), "generic")).toBe("generic");
  });

  it("names variables without echoing their values", () => {
    expect(() => requireGenesis({}, "G")).toThrow(/^G is required/);
    expect(() => requireGenesis({ G: "S3CRET" }, "G")).toThrow(new StartupError("G must be a base58 32-byte genesis hash"));
    expect(() => requirePin({ P: "S3CRET" }, "P", "stateId")).toThrow(/^P must be 64 lowercase hex characters \(the "stateId" value/);
    expect(integerVariable({}, "N", 7, 1, 9)).toBe(7);
    expect(() => integerVariable({ N: "S3CRET" }, "N", 7, 1, 9)).toThrow(new StartupError("N must be an integer from 1 to 9"));
    expect(() => lamportsVariable({ L: "-1" }, "L", "0")).toThrow(/^L must be a whole number of lamports$/);
    expect(() => distinctPorts({ A: 1, B: 2, C: 1 })).toThrow(new StartupError("A and C must differ (both are 1)"));
  });

  it("never quotes a damaged keypair or key file", () => {
    const damaged = file("payer.json", "[1,2,S3CRET");
    const error = message(() => readKeypair("KEYPAIR", damaged)) as Error;
    expect(error).toBeInstanceOf(StartupError);
    expect(error.message).toMatch(/^KEYPAIR: .*payer\.json is not a valid Solana keypair file/);
    expect(error.message).not.toContain("S3CRET");
    const secret = Keypair.generate().secretKey, mismatched = Array.from(secret); mismatched[63] ^= 1;
    const wrong = message(() => readKeypair("KEYPAIR", file("w.json", JSON.stringify(mismatched)))) as Error;
    expect(wrong.message).not.toContain(String(secret[0]) + "," + String(secret[1]) + "," + String(secret[2]));
    expect(readKeypair("KEYPAIR", file("ok.json", JSON.stringify(Array.from(secret)))).secretKey).toEqual(secret);
    expect(() => readStorageKey("KEY", file("key", "S3CRET"))).toThrow(/^KEY: .* must hold exactly 32 raw key bytes .*its contents are not shown$/);
    expect(() => readKeypair("KEYPAIR", join(tmpdir(), "ghostlink-absent-keypair.json"))).toThrow(/^KEYPAIR: .* does not exist$/);
  });

  it("shows fixed state reasons and withholds anything that can quote data", () => {
    const path = file("state.sqlite", "");
    expect(() => openState("STATE", join(tmpdir(), "ghostlink-absent.sqlite"), "check X", () => 1)).toThrow(/^STATE: .* does not exist; create state/);
    expect(() => openState("STATE", path, "check X", () => { throw new Error("journal identity mismatch"); }))
      .toThrow(/^STATE: .* was refused \(journal identity mismatch\); check X$/);
    const parse = message(() => openState("STATE", path, "check X", () => JSON.parse("{\"S3CRET\": ")) ) as Error;
    expect(parse.message).toMatch(/was refused \(details withheld\); check X$/);
    expect(parse.message).not.toContain("S3CRET");
    const quoted = message(() => openState("STATE", path, "check X", () => { throw new Error("value \"S3CRET\" rejected"); })) as Error;
    expect(quoted.message).toMatch(/details withheld/);
    expect(openState("STATE", path, "check X", () => 42)).toBe(42);
  });
});
