/**
 * Reads the deployment manifest named by GHOSTLINK_DEPLOYMENT without
 * loading it at import. `./deployment.js` loads it once for the process;
 * the startup diagnostics in `./startup.js` call this first, so a service
 * can report a bad manifest before anything else is loaded.
 *
 * Unset, a process uses the built-in localnet deployment, which refuses
 * public genesis hashes.
 */
import { readFileSync } from "node:fs";
import { DeploymentError, LOCALNET_DEPLOYMENT, parseDeployment, type DeploymentManifest } from "@ghostlink/common";

export const DEPLOYMENT_ENV = "GHOSTLINK_DEPLOYMENT";
const MAX_MANIFEST_BYTES = 16_384;

/** Reads the manifest named by GHOSTLINK_DEPLOYMENT, or the built-in localnet deployment when it is unset. */
export function loadDeploymentConfig(env: Record<string, string | undefined> = process.env): Readonly<DeploymentManifest> {
  const path = env[DEPLOYMENT_ENV];
  if (path === undefined) return LOCALNET_DEPLOYMENT;
  if (path.trim() === "") throw new DeploymentError(`${DEPLOYMENT_ENV} is set but empty; unset it for the built-in localnet deployment`);
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { throw new DeploymentError(`${DEPLOYMENT_ENV}: cannot read ${path}`); }
  if (Buffer.byteLength(text) > MAX_MANIFEST_BYTES) throw new DeploymentError(`${DEPLOYMENT_ENV}: ${path} is too large for a deployment manifest`);
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new DeploymentError(`${DEPLOYMENT_ENV}: ${path} is not JSON`); }
  try { return parseDeployment(raw); } catch (error) {
    throw new DeploymentError(`${DEPLOYMENT_ENV}: ${path}: ${(error as Error).message}`);
  }
}
