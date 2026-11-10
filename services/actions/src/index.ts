/** Hosted deposit builder: approved chain, bounded HTTP RPC and private operations. No signing keys. */
import "./preflight.js"; // First: reports a bad GHOSTLINK_DEPLOYMENT before service-kit loads it.
import type { Server } from "node:http";
import {
  StartupError, checkDeploymentGenesis, describeStartupFailure, distinctPorts, listen, openRpc, portVariable, probeRpc, requireGenesis,
} from "@ghostlink/service-kit/startup";
import { buildServer } from "./server.js";
import { operatorServer } from "./operations.js";
import { DEPLOYMENT } from "@ghostlink/service-kit";

async function main() {
  const env = process.env;
  const genesisHash = requireGenesis(env, "ACTIONS_GENESIS_HASH");
  checkDeploymentGenesis("ACTIONS_GENESIS_HASH", DEPLOYMENT, genesisHash);
  // A legacy cluster label must agree with the deployment manifest; it never selects one.
  if (env.CLUSTER && env.CLUSTER !== DEPLOYMENT.cluster) throw new StartupError(`CLUSTER is ${JSON.stringify(env.CLUSTER)} but the deployment manifest is ${DEPLOYMENT.cluster}; unset CLUSTER`);
  const port = portVariable(env, "PORT", 8790), operationsPort = portVariable(env, "OPERATIONS_PORT", 18790);
  distinctPorts({ PORT: port, OPERATIONS_PORT: operationsPort });
  const baseUrl = env.BASE_URL ?? `http://localhost:${port}`;
  try { new URL(baseUrl); } catch { throw new StartupError("BASE_URL must be an absolute URL (the public origin of this Actions service)"); }
  const rpc = openRpc(env, genesisHash);
  let server: ReturnType<typeof buildServer> | undefined, operator: Server | undefined;
  try {
    await probeRpc(rpc, "ACTIONS_GENESIS_HASH");
    server = buildServer({ connection: rpc.connection, genesisHash, baseUrl,
      maxInFlight: Number(env.ACTIONS_MAX_IN_FLIGHT ?? 8), trustProxy: env.TRUST_PROXY === "1" });
    operator = operatorServer(server.operations, rpc.status);
    await listen(operator, operationsPort, "OPERATIONS_PORT", "127.0.0.1");
    await listen(server, port, "PORT");
    let stopping = false;
    const shutdown = () => {
      if (stopping) return;
      stopping = true; server!.operations.drain();
      let closed = false; server!.close(() => { closed = true; });
      const deadline = setTimeout(() => { server!.closeAllConnections(); operator!.closeAllConnections(); rpc.close(); process.exit(1); }, 30_000);
      deadline.unref();
      const wait = setInterval(() => {
        if (!closed || !server!.operations.idle) return;
        clearInterval(wait); clearTimeout(deadline); server!.operations.stop(); operator!.close(); rpc.close();
      }, 50);
    };
    process.once("SIGTERM", shutdown); process.once("SIGINT", shutdown);
    console.log(`ghostlink actions on :${port}`);
  } catch (error) { server?.operations.stop(); server?.close(); operator?.close(); rpc.close(); throw error; }
}
void main().catch(error => {
  console.error(describeStartupFailure("Actions startup failed", error, "Actions startup failed; check approved configuration and dependencies"));
  process.exitCode = 1;
});
