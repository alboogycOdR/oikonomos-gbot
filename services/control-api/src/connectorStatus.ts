import {
  defaultManifestsDir,
  envSecretResolver,
  loadManifests,
  type ConnectorManifest,
} from "@oikonomos/connectors";

export type ConnectorConfigurationStatus = true | false | "unknown";

export interface ConnectorStatusResolver {
  getStatus(systemId: string): Promise<ConnectorConfigurationStatus | undefined>;
}

export interface CreateConnectorStatusResolverOptions {
  /**
   * The control API can only describe worker configuration when deployment
   * deliberately gives both processes the same connector-secret environment.
   */
  sharedEnvironment?: boolean;
  manifestLoader?: () => Promise<readonly ConnectorManifest[]>;
}

function environmentIsShared(): boolean {
  return process.env.OIK_CONNECTOR_STATUS_ENVIRONMENT === "shared";
}

async function manifestIsConfigured(manifest: ConnectorManifest): Promise<boolean> {
  // Delegate to the worker's resolver rather than copying its ref-to-env-key
  // mapping. Its result is deliberately discarded: this is presence-only.
  try {
    await envSecretResolver(manifest.mcp_server.url_ref);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the operator configuration state for manifest-backed systems.
 *
 * Manifest loading is intentionally fail-closed to `unknown`: a control API
 * process that cannot inspect the manifest directory, or whose environment is
 * not explicitly shared with the worker, cannot truthfully report readiness.
 */
export function createConnectorStatusResolver(
  options: CreateConnectorStatusResolverOptions = {},
): ConnectorStatusResolver {
  const manifests = (options.manifestLoader ?? (() => loadManifests(defaultManifestsDir())))()
    .then((loaded) => new Map(loaded.map((manifest) => [manifest.connector_id, manifest])))
    .catch(() => undefined);

  return {
    async getStatus(systemId: string): Promise<ConnectorConfigurationStatus | undefined> {
      if (options.sharedEnvironment ?? environmentIsShared()) {
        const manifestMap = await manifests;
        if (manifestMap === undefined) return "unknown";
        const manifest = manifestMap?.get(systemId);
        if (manifest === undefined) return undefined;
        return manifestIsConfigured(manifest);
      }

      const manifestMap = await manifests;
      if (manifestMap === undefined) return "unknown";
      return manifestMap?.has(systemId) ? "unknown" : undefined;
    },
  };
}
