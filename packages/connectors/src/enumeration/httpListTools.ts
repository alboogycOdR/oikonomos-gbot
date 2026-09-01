import type { McpHttpServerConfig } from "../mcp/types.js";
import { assertToolSegment, assertValidServerName, qualifyMcpToolName } from "./mcpNames.js";
import type { ToolEnumerator } from "./types.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const PROTOCOL_VERSION = "2025-03-26";
const CLIENT_INFO = Object.freeze({ name: "oikonomos-connectors", version: "0.0.0" });

export interface HttpMcpEnumeratorOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

interface JsonRpcSuccess {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code?: unknown; readonly message?: unknown };
}

/**
 * Real `listTools()` adapter over a mounted HTTP MCP server (WBS OIK-049).
 *
 * Speaks JSON-RPC `initialize` + `tools/list` (streamable HTTP). Secret
 * values (url, headers) are never interpolated into errors or logs (N4).
 * The adapter does not read `process.env` — callers pass an already-resolved
 * `McpHttpServerConfig` from TASK-053.
 */
export function createHttpMcpToolEnumerator(
  serverName: string,
  config: McpHttpServerConfig,
  options: HttpMcpEnumeratorOptions = {},
): ToolEnumerator {
  assertValidServerName(serverName);
  if (config.transport !== "http") {
    throw new Error("mcp transport is not http");
  }
  if (typeof config.url !== "string" || config.url.length === 0) {
    throw new Error("mcp http url is missing");
  }

  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const headers = config.headers;

  return {
    async listTools() {
      const names = await listToolsHttp(config.url, headers, fetchImpl, timeoutMs);
      return names.map((name) => {
        const qualified = qualifyMcpToolName(serverName, name);
        if (qualified.includes("*") || qualified.includes("?")) {
          throw new Error("listTools failed: invalid tool name");
        }
        return qualified;
      });
    },
  };
}

async function listToolsHttp(
  url: string,
  headers: Readonly<Record<string, string>> | undefined,
  fetchImpl: typeof globalThis.fetch,
  timeoutMs: number,
): Promise<readonly string[]> {
  const session: { id: string | undefined } = { id: undefined };

  try {
    await rpc(url, headers, fetchImpl, timeoutMs, session, "initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    });
  } catch (error) {
    if (isHttpStatusError(error) && (error.status === 404 || error.status === 405)) {
      // Some test mounts only implement tools/list.
    } else {
      throw toOpaqueError(error);
    }
  }

  try {
    await rpc(url, headers, fetchImpl, timeoutMs, session, "notifications/initialized", {}, true);
  } catch (error) {
    if (isHttpStatusError(error) && (error.status === 404 || error.status === 405)) {
      // Optional notification.
    } else if (isHttpStatusError(error)) {
      throw toOpaqueError(error);
    }
    // Empty/malformed notification bodies are ignored; tools/list is the check.
  }

  const names: string[] = [];
  let cursor: string | undefined;
  do {
    const params: Record<string, unknown> = {};
    if (cursor !== undefined) {
      params.cursor = cursor;
    }
    let result: unknown;
    try {
      result = await rpc(url, headers, fetchImpl, timeoutMs, session, "tools/list", params);
    } catch (error) {
      throw toOpaqueError(error);
    }
    const page = parseToolsPage(result);
    for (const name of page.names) {
      names.push(name);
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined);

  return names;
}

class HttpStatusError extends Error {
  constructor(readonly status: number) {
    super("http_status");
    this.name = "HttpStatusError";
  }
}

function isHttpStatusError(error: unknown): error is HttpStatusError {
  return error instanceof HttpStatusError;
}

function toOpaqueError(error: unknown): Error {
  if (isHttpStatusError(error)) {
    return new Error(`listTools failed: HTTP ${error.status}`);
  }
  if (error instanceof Error && error.message.startsWith("listTools failed:")) {
    return error;
  }
  if (error instanceof Error && (error.name === "AbortError" || error.message.includes("aborted"))) {
    return new Error("listTools failed: timeout");
  }
  return new Error("listTools failed: transport error");
}

async function rpc(
  url: string,
  extraHeaders: Readonly<Record<string, string>> | undefined,
  fetchImpl: typeof globalThis.fetch,
  timeoutMs: number,
  session: { id: string | undefined },
  method: string,
  params: Record<string, unknown>,
  notification = false,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const id = notification ? undefined : nextRpcId();
  const body: Record<string, unknown> = {
    jsonrpc: "2.0",
    method,
    params,
  };
  if (id !== undefined) {
    body.id = id;
  }

  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": PROTOCOL_VERSION,
  };
  if (extraHeaders !== undefined) {
    for (const [key, value] of Object.entries(extraHeaders)) {
      if (key.length > 0) {
        headers[key] = value;
      }
    }
  }
  if (session.id !== undefined) {
    headers["mcp-session-id"] = session.id;
  }

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    throw toOpaqueError(error);
  } finally {
    clearTimeout(timer);
  }

  const sessionHeader = response.headers.get("mcp-session-id");
  if (sessionHeader !== null && sessionHeader.length > 0) {
    session.id = sessionHeader;
  }

  if (response.status === 202 && notification) {
    return undefined;
  }
  if (!response.ok) {
    throw new HttpStatusError(response.status);
  }

  let payload: unknown;
  try {
    payload = await readPayload(response);
  } catch {
    if (notification) {
      return undefined;
    }
    throw new Error("listTools failed: malformed response");
  }

  if (notification) {
    return undefined;
  }
  return unwrapJsonRpc(payload);
}

function unwrapJsonRpc(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("listTools failed: malformed response");
  }
  const body = payload as JsonRpcSuccess;
  if (body.error !== undefined && body.error !== null) {
    throw new Error("listTools failed: jsonrpc error");
  }
  return body.result;
}

async function readPayload(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();
  if (text.length === 0) {
    return undefined;
  }
  if (contentType.includes("text/event-stream")) {
    return parseSseJsonRpc(text);
  }
  return JSON.parse(text) as unknown;
}

function parseSseJsonRpc(text: string): unknown {
  const events: string[] = [];
  let data: string[] = [];
  const flush = (): void => {
    if (data.length > 0) {
      events.push(data.join("\n"));
      data = [];
    }
  };
  for (const line of text.split(/\r?\n/)) {
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith("data:")) {
      data.push(line.slice(5).trimStart());
    }
  }
  flush();
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event === undefined) {
      continue;
    }
    try {
      return JSON.parse(event) as unknown;
    } catch {
      // try older events
    }
  }
  throw new Error("malformed");
}

function parseToolsPage(result: unknown): { names: readonly string[]; nextCursor: string | undefined } {
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new Error("listTools failed: malformed response");
  }
  const record = result as { tools?: unknown; nextCursor?: unknown };
  if (!Array.isArray(record.tools)) {
    throw new Error("listTools failed: malformed response");
  }
  const names: string[] = [];
  for (const tool of record.tools) {
    if (typeof tool !== "object" || tool === null || Array.isArray(tool)) {
      throw new Error("listTools failed: malformed response");
    }
    const name = (tool as { name?: unknown }).name;
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new Error("listTools failed: invalid tool name");
    }
    const trimmed = name.trim();
    if (trimmed.startsWith("mcp__")) {
      names.push(trimmed);
      continue;
    }
    assertToolSegment(trimmed);
    names.push(trimmed);
  }
  const cursor = record.nextCursor;
  const nextCursor = typeof cursor === "string" && cursor.length > 0 ? cursor : undefined;
  return { names, nextCursor };
}

let rpcId = 0;
function nextRpcId(): number {
  rpcId += 1;
  return rpcId;
}
