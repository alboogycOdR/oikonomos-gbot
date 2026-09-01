import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

/** MCP's documented maximum JSON request size for this local transport. */
const MAX_BODY_BYTES = 1024 * 1024;

export interface McpToolAnnotations {
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly [key: string]: unknown;
}

/** A connector tool and its manifest-declared MCP presentation metadata. */
export interface McpBridgeTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
  /** Passed through verbatim; this bridge never infers annotations from names or descriptions. */
  readonly annotations?: McpToolAnnotations;
  execute(input: Record<string, unknown>): Promise<unknown>;
}

export interface McpBridgeBrokerRequest {
  readonly toolName: string;
  readonly toolUseId: string;
  readonly input: Record<string, unknown>;
}

export type McpBridgeBrokerDecision =
  | { readonly decision: "allow"; readonly updatedInput?: Record<string, unknown> }
  | { readonly decision: "deny"; readonly modelGuidance: string };

/** Injected to keep the bridge transport-only and avoid a broker import cycle. */
export interface McpBridgeBrokerPort {
  decide(request: McpBridgeBrokerRequest): Promise<McpBridgeBrokerDecision>;
}

export interface McpBridgeOptions {
  readonly tools: readonly McpBridgeTool[];
  readonly broker: McpBridgeBrokerPort;
}

export interface McpBridge {
  /** Capability-bearing loopback URL suitable for a CLI MCP configuration. */
  readonly url: string;
  close(): Promise<void>;
}

interface JsonRpcRequest {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function result(id: unknown, value: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, result: value };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function mcpError(guidance: string): { readonly isError: true; readonly content: readonly [{ readonly type: "text"; readonly text: string }] } {
  return { isError: true, content: [{ type: "text", text: guidance }] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBody(request: IncomingMessage): Promise<string | "too_large"> {
  const contentLength = request.headers["content-length"];
  if (contentLength !== undefined && Number(contentLength) > MAX_BODY_BYTES) return "too_large";

  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) return "too_large";
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function snapshotTools(tools: readonly McpBridgeTool[]): ReadonlyMap<string, McpBridgeTool> {
  const snapshot = new Map<string, McpBridgeTool>();
  for (const tool of tools) {
    if (typeof tool.name !== "string" || tool.name.length === 0 || typeof tool.execute !== "function") {
      throw new Error("MCP bridge tools require a non-empty name and execute function");
    }
    if (snapshot.has(tool.name)) throw new Error(`MCP bridge tool names must be unique: ${tool.name}`);
    snapshot.set(tool.name, tool);
  }
  return snapshot;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string" || address.address !== "127.0.0.1") {
    throw new Error("MCP bridge did not bind a loopback TCP address");
  }
  return address.port;
}

/** Mount an ephemeral, capability-path-protected loopback MCP server for one run. */
export async function mountMcpBridge(options: McpBridgeOptions): Promise<McpBridge> {
  const tools = snapshotTools(options.tools);
  const capability = randomUUID();
  const expectedPath = `/mcp/${capability}`;
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== expectedPath) {
      response.writeHead(404).end();
      return;
    }
    const body = await readBody(request);
    if (body === "too_large") {
      response.writeHead(413).end();
      request.resume();
      return;
    }
    let message: JsonRpcRequest;
    try {
      const parsed: unknown = JSON.parse(body);
      if (!isRecord(parsed)) throw new Error("not an object");
      message = parsed;
    } catch {
      sendJson(response, 400, rpcError(null, -32700, "Parse error"));
      return;
    }
    if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      sendJson(response, 400, rpcError(message.id, -32600, "Invalid Request"));
      return;
    }
    if (message.method === "tools/list") {
      sendJson(response, 200, result(message.id, {
        tools: [...tools.values()].map((tool) => ({
          name: tool.name,
          ...(tool.description === undefined ? {} : { description: tool.description }),
          ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
          ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
        })),
      }));
      return;
    }
    if (message.method !== "tools/call" || !isRecord(message.params) || typeof message.params.name !== "string") {
      sendJson(response, 200, rpcError(message.id, -32601, "Method not found"));
      return;
    }
    const tool = tools.get(message.params.name);
    if (tool === undefined) {
      sendJson(response, 200, result(message.id, mcpError("This tool is not available in this run. Do not retry it; use a listed tool or ask the operator.")));
      return;
    }
    const input = isRecord(message.params.arguments) ? message.params.arguments : {};
    const toolUseId = typeof message.params._meta === "object" && message.params._meta !== null
      && typeof (message.params._meta as Record<string, unknown>).toolUseId === "string"
      ? (message.params._meta as Record<string, string>).toolUseId
      : randomUUID();
    let decision: McpBridgeBrokerDecision;
    try {
      decision = await options.broker.decide({ toolName: tool.name, toolUseId, input });
    } catch {
      sendJson(response, 200, result(message.id, mcpError("The broker could not decide this call, so it did not run. Do not retry it; ask the operator.")));
      return;
    }
    if (decision.decision === "deny") {
      sendJson(response, 200, result(message.id, mcpError(decision.modelGuidance)));
      return;
    }
    try {
      const output = await tool.execute(decision.updatedInput ?? input);
      sendJson(response, 200, result(message.id, { content: [{ type: "text", text: JSON.stringify(output) }] }));
    } catch {
      sendJson(response, 200, result(message.id, mcpError("The tool failed without completing. Do not retry blindly; inspect the request or ask the operator.")));
    }
  });
  const port = await listen(server);
  let closed = false;
  return {
    url: `http://127.0.0.1:${port}${expectedPath}`,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    },
  };
}

/** Run work with a mounted bridge and close it even if the work throws. */
export async function withMcpBridge<T>(
  options: McpBridgeOptions,
  run: (bridge: McpBridge) => Promise<T>,
): Promise<T> {
  const bridge = await mountMcpBridge(options);
  try {
    return await run(bridge);
  } finally {
    await bridge.close();
  }
}
