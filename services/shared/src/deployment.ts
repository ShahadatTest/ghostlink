/**
 * The deployment this process serves, read once at startup.
 *
 * Every service, the bot backend and the e2e harness take their deployment
 * manifest (docs/DEPLOYMENTS.md) from the file named by GHOSTLINK_DEPLOYMENT
 * (see `./deployment-config.js`). The instruction builders, PDAs and event
 * decoder of this package all use `DEPLOYMENT`, so it cannot change while
 * the process runs.
 */
import type { DeploymentManifest } from "@ghostlink/common";
import { loadDeploymentConfig } from "./deployment-config.js";

export { DEPLOYMENT_ENV, loadDeploymentConfig } from "./deployment-config.js";

/** Fixed for the life of the process. */
export const DEPLOYMENT: Readonly<DeploymentManifest> = loadDeploymentConfig();
