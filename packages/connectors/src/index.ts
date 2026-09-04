export const workspaceName = "connectors";

export function ping(): string {
  return workspaceName;
}

export {
  connectorManifestSchema,
  riskTierSchema,
  riskTiers,
  type ConnectorManifest,
} from "./manifest/schema.js";
export { inspectUrlRef } from "./manifest/urlRef.js";
export { validateManifest, type ManifestIssue, type ValidateManifestResult } from "./manifest/validate.js";
export {
  defaultManifestsDir,
  scanManifests,
  UNOBSERVABLE_MISSING_DIR,
  UNOBSERVABLE_ZERO_MANIFESTS,
  type FileViolation,
  type ScanManifestsResult,
} from "./manifest/scan.js";
export { parseManifestsDir, runValidateCli, type CliIo } from "./manifest/cli.js";
export { InvalidManifestError, loadManifests } from "./manifest/load.js";
export {
  deregisterConnector,
  InvalidConnectorManifestError,
  registerConnector,
} from "./registration/index.js";
export {
  enumerateTools,
  serializeEnumerationReport,
  UNOBSERVABLE_ZERO_TOOLS,
  type EnumerationReport,
  type EnumerateToolsOptions,
  type MappedTool,
  type StaleTool,
  type ToolEnumerator,
} from "./enumeration/index.js";
export {
  createConnectorSessionPool,
  ConnectorSessionPoolError,
  type ConnectorSessionHandle,
  type ConnectorSessionMinter,
  type ConnectorSessionPool,
  type ConnectorSessionPoolErrorCode,
  type ConnectorSessionPoolOptions,
  type MintConnectorSessionInput,
} from "./sessions/index.js";
export {
  createGmailConnectorSessionMinter,
  createGmailOAuthTokenProvider,
  mcpConfigFromManifest,
  type CreateGmailConnectorSessionMinterOptions,
  type GmailOAuthTokenProviderOptions,
  type ManifestMcpInput,
  type McpConfigFromManifestOptions,
  type McpHttpServerConfig,
  type McpServerConfig,
  type McpServers,
  type OAuthTokenProvider,
  type SecretResolver,
} from "./mcp/index.js";

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;
  describe("@oikonomos/connectors", () => {
    it("ping returns the workspace name", () => {
      expect(ping()).toBe("connectors");
    });
  });
}
