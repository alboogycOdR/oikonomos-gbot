import { fileURLToPath } from "node:url";

export { buildApp, type BuildAppOptions } from "./app.js";
export { createDatabaseBackedDeps, createDatabaseBackedThreadContext, type ControlApiDeps } from "./ports.js";
export { getOpenApiDocument } from "./openapi.js";
export { redactApprovalNonceFromUrl } from "./redact.js";
export {
  buildBrokerHttpApp,
  buildDatabaseBrokerHttpApp,
  BROKER_PRE_TOOL_USE_PATH,
  type BrokerHttpResponse,
  type BuildBrokerHttpAppOptions,
} from "./brokerHttpRoute.js";
export {
  mintBrokerToken,
  verifyBrokerToken,
  BROKER_TOKEN_SIGNING_KEY_REF,
  resolveBrokerTokenSigningKey,
  BROKER_TOKEN_SIGNING_KEY_ENV,
  type BrokerTokenBinding,
  type VerifiedBrokerToken,
} from "./brokerToken.js";

import { buildApp } from "./app.js";
import { buildDatabaseBrokerHttpApp } from "./brokerHttpRoute.js";
import { createDatabaseBackedDeps, createDatabaseBackedThreadContext } from "./ports.js";

/**
 * Process entrypoint (not exercised by tests): read DATABASE_URL and PORT
 * from the environment, build the real DB-backed app, and listen.
 */
export async function start(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (connectionString === undefined || connectionString.trim().length === 0) {
    throw new Error("DATABASE_URL must be set to start control-api.");
  }
  const port = process.env.PORT !== undefined ? Number(process.env.PORT) : 3000;
  const brokerPort = process.env.BROKER_PORT !== undefined ? Number(process.env.BROKER_PORT) : 3001;
  if (!Number.isSafeInteger(port) || port <= 0 || !Number.isSafeInteger(brokerPort) || brokerPort <= 0 || brokerPort === port) {
    throw new Error("PORT and BROKER_PORT must be distinct positive integer ports.");
  }
  const deps = createDatabaseBackedDeps({ connectionString });
  const app = buildApp(deps, { threadContext: createDatabaseBackedThreadContext({ connectionString }) });
  const brokerApp = await buildDatabaseBrokerHttpApp({ connectionString });
  try {
    await Promise.all([
      app.listen({ port, host: "0.0.0.0" }),
      brokerApp.listen({ port: brokerPort, host: "0.0.0.0" }),
    ]);
  } catch (error) {
    await Promise.allSettled([app.close(), brokerApp.close()]);
    throw error;
  }
}

// Only run when this module is the process entrypoint, not when imported
// (by tests or by other packages) for its exports. `file://${argv[1]}`
// string comparison breaks on Windows (argv[1] is a raw path, not a URL);
// fileURLToPath is the portable comparison — same fix already proven in
// the worker service's own capability-registration CLI (TASK-114).
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  start().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
