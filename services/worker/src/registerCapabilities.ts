import { fileURLToPath } from "node:url";

import { BUILTIN_TOOLS } from "@oikonomos/broker";
import { defaultManifestsDir, loadManifests, type ConnectorManifest } from "@oikonomos/connectors";
import {
  createConnectorRegistrationStore,
  defaultPoolConfig,
  type ConnectorRegistrationRows,
  type ConnectorRegistrationStore,
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
 */
export async function registerCapabilities(options: RegisterCapabilitiesOptions): Promise<void> {
  const manifests = await loadManifests(options.manifestsDir ?? defaultManifestsDir());
  for (const manifest of manifests) {
    await options.store.register(rowsFromManifest(manifest));
  }
  for (const rows of rowsFromBuiltins()) await options.store.register(rows);
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (connectionString === undefined || connectionString.trim().length === 0) {
    throw new Error("DATABASE_URL is required to register capabilities.");
  }

  const pool = new Pool({ connectionString, ...defaultPoolConfig });
  try {
    await registerCapabilities({ store: createConnectorRegistrationStore(pool) });
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
