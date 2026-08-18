import { pathToFileURL } from "node:url";

import { runSuite, type ConnectorEvalManifest } from "./index.ts";
import type { AgentSdkQueryFn } from "@oikonomos/harness-factory";

const [connectorId, manifestModule, queryModule] = process.argv.slice(2);
if (!connectorId || !manifestModule || !queryModule) {
  console.error("usage: pnpm --filter @oikonomos/evals-golden run <connector-id> <manifest-module> <query-module>");
  process.exitCode = 2;
} else {
  const manifest = (await import(pathToFileURL(manifestModule).href)).default as ConnectorEvalManifest;
  const queryFn = (await import(pathToFileURL(queryModule).href)).default as AgentSdkQueryFn;
  const report = await runSuite(connectorId, { manifest, queryFn });
  console.log(JSON.stringify(report));
  process.exitCode = report.passed ? 0 : 1;
}
