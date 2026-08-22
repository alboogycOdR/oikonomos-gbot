export { buildApp, type BuildAppOptions } from "./app.js";
export { createDatabaseBackedDeps, type ControlApiDeps } from "./ports.js";
export { getOpenApiDocument } from "./openapi.js";
export { redactApprovalNonceFromUrl } from "./redact.js";

import { buildApp } from "./app.js";
import { createDatabaseBackedDeps } from "./ports.js";

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
  const deps = createDatabaseBackedDeps({ connectionString });
  const app = buildApp(deps);
  await app.listen({ port, host: "0.0.0.0" });
}

// Only run when this module is the process entrypoint, not when imported
// (by tests or by other packages) for its exports.
if (import.meta.url === `file://${process.argv[1]}`) {
  start().catch((error: unknown) => {
    // eslint-disable-next-line no-console -- process bootstrap, no logger yet
    console.error(error);
    process.exitCode = 1;
  });
}
