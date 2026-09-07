import { fileURLToPath } from "node:url";

import { BUILTIN_TOOLS } from "@oikonomos/broker";
import { defaultManifestsDir, loadManifests, type ConnectorManifest } from "@oikonomos/connectors";
import {
  createConnectorRegistrationStore,
  defaultPoolConfig,
  type ConnectorRegistrationRows,
  type ConnectorRegistrationStore,
  type SkippedRoleGrant,
} from "@oikonomos/db";
import { Pool } from "pg";

function rowsFromManifest(manifest: ConnectorManifest): ConnectorRegistrationRows {
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

function rowsFromBuiltins(): readonly ConnectorRegistrationRows[] {
  const rowsByAdapter = new Map<string, Map<string, ConnectorRegistrationRows["capabilities"][number]>>();
  for (const tool of BUILTIN_TOOLS) {
    const capabilities = rowsByAdapter.get(tool.adapter) ?? new Map<string, ConnectorRegistrationRows["capabilities"][number]>();
    rowsByAdapter.set(tool.adapter, capabilities);
    capabilities.set(tool.capabilityId, {
      capabilityId: tool.capabilityId,
      description: `Agent SDK tool ${tool.toolName}.`,
      defaultTier: tool.defaultTier,
      enabled: tool.enabled,
    });
  }
  return [...rowsByAdapter.entries()].map(([adapter, capabilities]) => ({
    // The store requires an identifier even when adapter ownership is explicit.
    connectorId: adapter === "sdk:builtin" ? "builtins" : adapter.slice("mcp:".length),
    adapter,
    capabilities: [...capabilities.values()],
    // Declarations are capabilities, not a grant source. Existing grants remain untouched.
    roleGrants: [],
  }));
}

export interface RegisterCapabilitiesOptions {
  readonly store: ConnectorRegistrationStore;
  readonly manifestsDir?: string;
}

/**
 * Explicit operator/CI registration step required after declaration changes.
 * It is deliberately not imported by a worker process entrypoint.
 *
 * TASK-206: one manifest's role_grants referencing a not-yet-created role
 * no longer aborts registration for every other manifest — `store.register`
 * skips just that grant (still committing the manifest's own capabilities
 * and its other valid grants) and reports it here rather than throwing.
 */
export async function registerCapabilities(
  options: RegisterCapabilitiesOptions,
): Promise<{ readonly skippedRoleGrants: readonly SkippedRoleGrant[] }> {
  const manifests = await loadManifests(options.manifestsDir ?? defaultManifestsDir());
  const skippedRoleGrants: SkippedRoleGrant[] = [];
  for (const manifest of manifests) {
    const result = await options.store.register(rowsFromManifest(manifest));
    skippedRoleGrants.push(...result.skippedRoleGrants);
  }
  for (const rows of rowsFromBuiltins()) {
    const result = await options.store.register(rows);
    skippedRoleGrants.push(...result.skippedRoleGrants);
  }
  return { skippedRoleGrants };
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (connectionString === undefined || connectionString.trim().length === 0) {
    throw new Error("DATABASE_URL is required to register capabilities.");
  }

  const pool = new Pool({ connectionString, ...defaultPoolConfig });
  try {
    const { skippedRoleGrants } = await registerCapabilities({ store: createConnectorRegistrationStore(pool) });
    for (const skipped of skippedRoleGrants) {
      console.warn(`skipped role_grants for capability '${skipped.capabilityId}': ${skipped.reason}`);
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
