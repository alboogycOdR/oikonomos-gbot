import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { updateRoleName } from "@oikonomos/db";
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

const SEND_TO_ROLE_TOOL_NAME = "send_to_role";
const RENAME_SELF_TOOL_NAME = "rename_self";

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
    return resultResponse(request.id, { tools: [
      { name: SEND_TO_ROLE_TOOL_NAME, description: "Send an asynchronous role-to-role handoff.", inputSchema: sendToRoleInputSchema },
      { name: RENAME_SELF_TOOL_NAME, description: "Rename the calling bot's own display name.", inputSchema: renameSelfInputSchema },
    ] });
  }
  if (request.method !== "tools/call") {
    return errorResponse(request.id ?? null, -32601, "Method not found");
  }
  try {
    const call = parseToolCall(request.params);
    if (call.name === SEND_TO_ROLE_TOOL_NAME) {
      const acknowledgement = await sendToRole({ connectionString: identity.connectionString }, toSendInput(call.arguments, identity));
      return resultResponse(request.id, { content: [{ type: "text", text: JSON.stringify(acknowledgement) }] });
    }
    const role = await updateRoleName({ connectionString: identity.connectionString }, identity.fromRoleId, toRenameInput(call.arguments));
    if (role === null) throw new Error("Calling role was not found.");
    return resultResponse(request.id, { content: [{ type: "text", text: JSON.stringify({ roleId: role.roleId, name: role.name }) }] });
  } catch (error) {
    return resultResponse(request.id, { content: [{ type: "text", text: error instanceof Error ? error.message : "Unable to send handoff." }], isError: true });
  }
}

function parseToolCall(params: unknown): { name: typeof SEND_TO_ROLE_TOOL_NAME | typeof RENAME_SELF_TOOL_NAME; arguments: Record<string, unknown> } {
  if (typeof params !== "object" || params === null || Array.isArray(params)) throw new Error("tools/call requires params.");
  const call = params as { name?: unknown; arguments?: unknown };
  if ((call.name !== SEND_TO_ROLE_TOOL_NAME && call.name !== RENAME_SELF_TOOL_NAME) || typeof call.arguments !== "object" || call.arguments === null || Array.isArray(call.arguments)) throw new Error("Unknown workspace tool.");
  return { name: call.name, arguments: call.arguments as Record<string, unknown> };
}

function toSendInput(args: Record<string, unknown>, identity: WorkspaceMcpServerIdentity): {
  tenantId: string; fromRoleId: string; toRoleId: string; body: string; workspaceRefs?: readonly string[]; handoffKind?: HandoffKind; factRef?: HandoffFactReference;
} {
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

function toRenameInput(args: Record<string, unknown>): string {
  if (Object.keys(args).length !== 1 || typeof args.name !== "string") {
    throw new Error("rename_self requires exactly one string name argument.");
  }
  return args.name;
}

function resultResponse(id: unknown, result: unknown): Record<string, unknown> { return { jsonrpc: "2.0", id: id ?? null, result }; }
function errorResponse(id: unknown, code: number, message: string): Record<string, unknown> { return { jsonrpc: "2.0", id: id ?? null, error: { code, message } }; }

const sendToRoleInputSchema = {
  type: "object",
  required: ["toRoleId", "body"],
  additionalProperties: false,
  properties: {
    toRoleId: { type: "string" }, body: { type: "string" }, workspaceRefs: { type: "array", items: { type: "string" } },
    handoffKind: { type: "string", enum: ["research.complete", "draft.ready_for_review"] },
    factRef: { type: "object" },
  },
};

const renameSelfInputSchema = {
  type: "object",
  required: ["name"],
  additionalProperties: false,
  properties: { name: { type: "string", minLength: 1, maxLength: 100 } },
};

function readIdentity(argv: readonly string[]): WorkspaceMcpServerIdentity {
  const [connectionString, tenantId, fromRoleId] = argv;
  if ([connectionString, tenantId, fromRoleId].some((value) => typeof value !== "string" || value.trim().length === 0)) throw new Error("workspace MCP requires connection string, tenant ID, and sender role ID.");
  return { connectionString, tenantId, fromRoleId };
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) startWorkspaceMcpServer(readIdentity(process.argv.slice(2)));
