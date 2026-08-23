/**
 * MCP server config produced from a connector manifest (OIK-048 / TASK-053).
 *
 * Shape matches TASK-052 `McpServerConfig` so composeHarness can consume it
 * without this package depending on harness-factory. Secret values arrive
 * here as already-resolved strings from SecretResolver; they must never be
 * echoed in errors, logs, or reports (N4).
 */

export type McpTransport = "stdio" | "http";

export interface McpStdioServerConfig {
  readonly transport: "stdio";
  readonly command: string;
  readonly args?: readonly string[];
}

export interface McpHttpServerConfig {
  readonly transport: "http";
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

export type McpServers = Readonly<Record<string, McpServerConfig>>;

/**
 * Injected secret port. The default implementation reads process env;
 * tests supply a fake so fixtures never hold a resolved value (N4).
 */
export interface SecretResolver {
  resolve(ref: string): Promise<string>;
}

/** Slice of a manifest this module actually reads. Wider than the zod type so N5 is testable. */
export interface ManifestMcpInput {
  readonly account_ownership: string;
  readonly mcp_server: {
    readonly name: string;
    readonly transport: string;
    readonly url_ref: string;
  };
}

export interface McpConfigFromManifestOptions {
  readonly resolve: SecretResolver["resolve"] | SecretResolver;
}
