import type {
  McpServers,
  SdkMcpHttpServerConfig,
  SdkMcpServerConfig,
  SdkMcpServers,
  SdkMcpStdioServerConfig,
} from "./types.js";

export type McpConfigErrorCode =
  | "INVALID_MCP_SERVERS"
  | "INVALID_SERVER_NAME"
  | "INVALID_TRANSPORT"
  | "INVALID_STDIO"
  | "INVALID_HTTP"
  | "INVALID_ARGS"
  | "INVALID_HEADERS";

export class McpConfigError extends Error {
  readonly code: McpConfigErrorCode;
  readonly serverName: string | undefined;

  constructor(message: string, code: McpConfigErrorCode, serverName?: string) {
    super(message);
    this.name = "McpConfigError";
    this.code = code;
    this.serverName = serverName;
  }
}

const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Validate caller-supplied mcpServers and map them to the SDK option shape.
 * Errors name the server key and the field, never a url/header/command value (N4).
 */
export function resolveMcpServers(mcpServers: unknown): SdkMcpServers | undefined {
  if (mcpServers === undefined) {
    return undefined;
  }
  if (typeof mcpServers !== "object" || mcpServers === null || Array.isArray(mcpServers)) {
    throw new McpConfigError(
      "mcpServers must be a record of server name to config",
      "INVALID_MCP_SERVERS",
    );
  }

  const entries = Object.entries(mcpServers as Record<string, unknown>);
  const resolved: Record<string, SdkMcpServerConfig> = {};
  for (const [name, config] of entries) {
    resolved[name] = resolveOne(name, config);
  }
  return Object.freeze(resolved) as SdkMcpServers;
}

function resolveOne(name: string, config: unknown): SdkMcpServerConfig {
  if (!SERVER_NAME.test(name)) {
    throw new McpConfigError(
      "mcpServers keys must be non-empty names matching [A-Za-z0-9][A-Za-z0-9_-]*",
      "INVALID_SERVER_NAME",
    );
  }
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new McpConfigError(
      `mcpServers.${name}: config must be an object`,
      "INVALID_TRANSPORT",
      name,
    );
  }

  const record = config as {
    transport?: unknown;
    command?: unknown;
    args?: unknown;
    url?: unknown;
    headers?: unknown;
  };
  const transport = record.transport;
  if (transport === "stdio") {
    return freezeStdio(name, record);
  }
  if (transport === "http") {
    return freezeHttp(name, record);
  }
  throw new McpConfigError(
    `mcpServers.${name}: transport must be "stdio" or "http"`,
    "INVALID_TRANSPORT",
    name,
  );
}

function freezeStdio(
  name: string,
  record: { command?: unknown; args?: unknown },
): SdkMcpStdioServerConfig {
  if (typeof record.command !== "string" || record.command.length === 0) {
    throw new McpConfigError(
      `mcpServers.${name}: stdio transport requires a non-empty command`,
      "INVALID_STDIO",
      name,
    );
  }
  const mapped: SdkMcpStdioServerConfig = Object.freeze({
    type: "stdio",
    command: record.command,
    ...(record.args !== undefined ? { args: freezeArgs(name, record.args) } : {}),
  });
  return mapped;
}

function freezeHttp(
  name: string,
  record: { url?: unknown; headers?: unknown },
): SdkMcpHttpServerConfig {
  if (typeof record.url !== "string" || record.url.length === 0) {
    throw new McpConfigError(
      `mcpServers.${name}: http transport requires a non-empty url`,
      "INVALID_HTTP",
      name,
    );
  }
  const mapped: SdkMcpHttpServerConfig = Object.freeze({
    type: "http",
    url: record.url,
    ...(record.headers !== undefined ? { headers: freezeHeaders(name, record.headers) } : {}),
  });
  return mapped;
}

function freezeArgs(name: string, args: unknown): readonly string[] {
  if (!Array.isArray(args) || !args.every((entry) => typeof entry === "string")) {
    throw new McpConfigError(
      `mcpServers.${name}: stdio args must be an array of strings`,
      "INVALID_ARGS",
      name,
    );
  }
  return Object.freeze([...args]);
}

function freezeHeaders(name: string, headers: unknown): Readonly<Record<string, string>> {
  if (typeof headers !== "object" || headers === null || Array.isArray(headers)) {
    throw new McpConfigError(
      `mcpServers.${name}: headers must be a string record`,
      "INVALID_HEADERS",
      name,
    );
  }
  const copy: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (typeof key !== "string" || key.length === 0 || typeof value !== "string") {
      throw new McpConfigError(
        `mcpServers.${name}: headers must be a string record`,
        "INVALID_HEADERS",
        name,
      );
    }
    copy[key] = value;
  }
  return Object.freeze(copy);
}

/** Type predicate for the public ComposeOptions field. */
export function isMcpServers(value: unknown): value is McpServers {
  try {
    resolveMcpServers(value);
    return value !== undefined;
  } catch {
    return false;
  }
}
