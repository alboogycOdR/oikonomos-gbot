import type {
  ConnectorRegistrationRows,
  ConnectorRegistrationStore,
} from "@oikonomos/db";

import type { ManifestIssue } from "../manifest/validate.js";
import { validateManifest } from "../manifest/validate.js";

export class InvalidConnectorManifestError extends Error {
  public constructor(readonly issues: readonly ManifestIssue[]) {
    super("connector manifest is invalid");
    this.name = "InvalidConnectorManifestError";
  }
}

function rowsFromManifest(raw: string): ConnectorRegistrationRows {
  const validation = validateManifest(raw);
  if (!validation.ok) {
    throw new InvalidConnectorManifestError(validation.issues);
  }

  const { manifest } = validation;
  return {
    connectorId: manifest.connector_id,
    capabilities: manifest.tools.map((tool) => ({
      capabilityId: tool.capability_id,
      description: `MCP tool ${tool.tool_name}.`,
      defaultTier: tool.default_tier,
      enabled: tool.enabled ?? true,
    })),
    roleGrants: manifest.role_grants.flatMap((grant) =>
      manifest.tools.map((tool) => ({
        roleId: grant.role_id,
        capabilityId: tool.capability_id,
        maxTier: grant.max_tier,
        constraints: grant.constraints,
      })),
    ),
  };
}

/** Validates a raw manifest before atomically persisting its derived rows. */
export async function registerConnector(
  rawManifest: string,
  store: ConnectorRegistrationStore,
): Promise<void> {
  await store.register(rowsFromManifest(rawManifest));
}

/** Removes only rows owned by this connector's `mcp:<connector_id>` adapter. */
export async function deregisterConnector(
  connectorId: string,
  store: ConnectorRegistrationStore,
): Promise<void> {
  await store.deregister(connectorId);
}
