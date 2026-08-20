/**
 * MCP mount config accepted by composeHarness (OIK-048 / TASK-052).
 *
 * Secret values (url, headers) arrive already resolved from the caller.
 * This package never reads env and never echoes those values in errors.
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

/** Shape passed to the Agent SDK `options.mcpServers` map. */
export type SdkMcpStdioServerConfig = {
  readonly type: "stdio";
  readonly command: string;
  readonly args?: readonly string[];
};

export type SdkMcpHttpServerConfig = {
  readonly type: "http";
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
};

export type SdkMcpServerConfig = SdkMcpStdioServerConfig | SdkMcpHttpServerConfig;

export type SdkMcpServers = Readonly<Record<string, SdkMcpServerConfig>>;
