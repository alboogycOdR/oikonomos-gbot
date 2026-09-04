import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { sendToRole } from "@oikonomos/workspace";
import type { HandoffFactReference, HandoffKind } from "@oikonomos/workspace";

export interface WorkspaceMcpServerIdentity {
  readonly connectionString: string;
  readonly tenantId: string;
  readonly fromRoleId: string;
}

interface JsonRpcRequest {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
}

const TOOL_NAME = "send_to_role";

/**
 * Narrow stdio MCP bridge for the existing mailbox implementation. Identity
 * comes only from worker-supplied process arguments, never model-controlled
 * tool input, so a sender cannot impersonate another role.
 */
export function startWorkspaceMcpServer(identity: WorkspaceMcpServerIdentity): void {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (line) => {
    void handleLine(line, identity).catch((error: unknown) => {
      process.stderr.write(`workspace MCP request failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    });
  });
}

async function handleLine(line: string, identity: WorkspaceMcpServerIdentity): Promise<void> {
  const response = await handleWorkspaceMcpRequest(line, identity);
  if (response !== undefined) process.stdout.write(`${JSON.stringify(response)}\n`);
}

/** Process one request separately from stdio so the real bridge is testable. */
export async function handleWorkspaceMcpRequest(
  line: string,
  identity: WorkspaceMcpServerIdentity,
): Promise<Record<string, unknown> | undefined> {
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(line) as JsonRpcRequest;
  } catch {
    return errorResponse(null, -32700, "Parse error");
  }
  if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    return errorResponse(request.id ?? null, -32600, "Invalid Request");
  }
  if (request.method === "notifications/initialized") return;
  if (request.method === "initialize") {
    return resultResponse(request.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "oikonomos-workspace", version: "1.0.0" } });
  }
  if (request.method === "tools/list") {
    return resultResponse(request.id, { tools: [{ name: TOOL_NAME, description: "Send an asynchronous role-to-role handoff.", inputSchema: toolInputSchema }] });
  }
  if (request.method !== "tools/call") {
    return errorResponse(request.id ?? null, -32601, "Method not found");
  }
  try {
    const acknowledgement = await sendToRole({ connectionString: identity.connectionString }, toSendInput(request.params, identity));
    return resultResponse(request.id, { content: [{ type: "text", text: JSON.stringify(acknowledgement) }] });
  } catch (error) {
    return resultResponse(request.id, { content: [{ type: "text", text: error instanceof Error ? error.message : "Unable to send handoff." }], isError: true });
  }
}

function toSendInput(params: unknown, identity: WorkspaceMcpServerIdentity): {
  tenantId: string; fromRoleId: string; toRoleId: string; body: string; workspaceRefs?: readonly string[]; handoffKind?: HandoffKind; factRef?: HandoffFactReference;
} {
  if (typeof params !== "object" || params === null || Array.isArray(params)) throw new Error("tools/call requires params.");
  const call = params as { name?: unknown; arguments?: unknown };
  if (call.name !== TOOL_NAME || typeof call.arguments !== "object" || call.arguments === null || Array.isArray(call.arguments)) throw new Error("Unknown workspace tool.");
  const args = call.arguments as Record<string, unknown>;
  if (typeof args.toRoleId !== "string" || typeof args.body !== "string") throw new Error("send_to_role requires string toRoleId and body.");
  if (args.workspaceRefs !== undefined && (!Array.isArray(args.workspaceRefs) || !args.workspaceRefs.every((value) => typeof value === "string"))) throw new Error("workspaceRefs must be an array of strings.");
  return {
    tenantId: identity.tenantId,
    fromRoleId: identity.fromRoleId,
    toRoleId: args.toRoleId,
    body: args.body,
    ...(args.workspaceRefs === undefined ? {} : { workspaceRefs: args.workspaceRefs }),
    ...(args.handoffKind === undefined ? {} : { handoffKind: args.handoffKind as HandoffKind }),
    ...(args.factRef === undefined ? {} : { factRef: args.factRef as HandoffFactReference }),
  };
}

function resultResponse(id: unknown, result: unknown): Record<string, unknown> { return { jsonrpc: "2.0", id: id ?? null, result }; }
function errorResponse(id: unknown, code: number, message: string): Record<string, unknown> { return { jsonrpc: "2.0", id: id ?? null, error: { code, message } }; }

const toolInputSchema = {
  type: "object",
  required: ["toRoleId", "body"],
  additionalProperties: false,
  properties: {
    toRoleId: { type: "string" }, body: { type: "string" }, workspaceRefs: { type: "array", items: { type: "string" } },
    handoffKind: { type: "string", enum: ["research.complete", "draft.ready_for_review"] },
    factRef: { type: "object" },
  },
};

function readIdentity(argv: readonly string[]): WorkspaceMcpServerIdentity {
  const [connectionString, tenantId, fromRoleId] = argv;
  if ([connectionString, tenantId, fromRoleId].some((value) => typeof value !== "string" || value.trim().length === 0)) throw new Error("workspace MCP requires connection string, tenant ID, and sender role ID.");
  return { connectionString, tenantId, fromRoleId };
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) startWorkspaceMcpServer(readIdentity(process.argv.slice(2)));
