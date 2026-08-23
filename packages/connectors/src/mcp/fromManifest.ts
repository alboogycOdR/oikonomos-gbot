import { McpManifestConfigError } from "./errors.js";
import type {
  ManifestMcpInput,
  McpConfigFromManifestOptions,
  McpHttpServerConfig,
  McpServerConfig,
  SecretResolver,
} from "./types.js";

const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function bindResolve(
  resolve: McpConfigFromManifestOptions["resolve"],
): SecretResolver["resolve"] {
  if (typeof resolve === "function") {
    return resolve;
  }
  return (ref) => resolve.resolve(ref);
}

function httpTransportFromManifest(transport: string): boolean {
  return transport === "remote" || transport === "http";
}

async function resolvedUrl(
  ref: string,
  resolve: SecretResolver["resolve"],
): Promise<string> {
  let value: unknown;
  try {
    value = await resolve(ref);
  } catch (err) {
    if (err instanceof McpManifestConfigError) {
      throw err;
    }
    throw new McpManifestConfigError(`secret ref is unset: ${ref}`, "SECRET_UNSET", {
      ref,
      field: "mcp_server.url_ref",
    });
  }

  if (typeof value !== "string") {
    throw new McpManifestConfigError(`secret ref is unset: ${ref}`, "SECRET_UNSET", {
      ref,
      field: "mcp_server.url_ref",
    });
  }
  if (value.length === 0) {
    throw new McpManifestConfigError(`secret ref resolved empty: ${ref}`, "SECRET_EMPTY", {
      ref,
      field: "mcp_server.url_ref",
    });
  }
  return value;
}

/**
 * Turn a manifest `mcp_server` block into the McpServerConfig TASK-052 consumes.
 *
 * Handover §4.4 uses `transport: remote` with `url_ref`; TASK-052 speaks
 * `transport: "http"` with an already-resolved `url`. This function is that
 * mapping. It does not re-check that `url_ref` is a `secret://` reference
 * (TASK-043 already rejects literals). Ownership is re-asserted (N5).
 */
export async function mcpConfigFromManifest(
  manifest: ManifestMcpInput,
  options: McpConfigFromManifestOptions,
): Promise<McpServerConfig> {
  if (manifest.account_ownership !== "basileia") {
    throw new McpManifestConfigError(
      "account_ownership must be basileia",
      "OWNERSHIP_NOT_BASILEIA",
      { field: "account_ownership" },
    );
  }

  const server = manifest.mcp_server;
  if (!SERVER_NAME.test(server.name)) {
    throw new McpManifestConfigError(
      "mcp_server.name must match [A-Za-z0-9][A-Za-z0-9_-]*",
      "INVALID_SERVER_NAME",
      { field: "mcp_server.name" },
    );
  }

  if (!httpTransportFromManifest(server.transport)) {
    throw new McpManifestConfigError(
      `mcp_server.transport "${server.transport}" is not mappable to http (expected remote|http)`,
      "UNSUPPORTED_TRANSPORT",
      { field: "mcp_server.transport" },
    );
  }

  const ref = server.url_ref;
  const url = await resolvedUrl(ref, bindResolve(options.resolve));

  const config: McpHttpServerConfig = Object.freeze({
    transport: "http",
    url,
  });
  return config;
}
