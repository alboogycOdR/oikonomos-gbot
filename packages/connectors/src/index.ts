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
export {
  deregisterConnector,
  InvalidConnectorManifestError,
  registerConnector,
} from "./registration/index.js";

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;
  describe("@oikonomos/connectors", () => {
    it("ping returns the workspace name", () => {
      expect(ping()).toBe("connectors");
    });
  });
}
