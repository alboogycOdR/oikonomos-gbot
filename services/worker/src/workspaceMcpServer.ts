import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import {
  createRoleWithDefaultCapabilities,
  createSecretRequest,
  insertAuditEvent,
  retireRole,
  RoleRetirementError,
  updateRoleName,
} from "@oikonomos/db";
import { sendToRole } from "@oikonomos/workspace";
import type { HandoffFactReference, HandoffKind } from "@oikonomos/workspace";
import { parkTaskRun } from "./runLifecycle.js";
import { parseRequestSecretInput } from "@oikonomos/broker";
import { resolveRoleIdentifier } from "./resolveRoleIdentifier.js";
import { createRoutineFromToolInput, createRoutineInputSchema, CREATE_ROUTINE_TOOL_DESCRIPTION, parseCreateRoutineInput } from "./routineTool.js";

export interface WorkspaceMcpServerIdentity {
  readonly connectionString: string;
  readonly tenantId: string;
  readonly fromRoleId: string;
  /** The worker, not model input, binds a secret request to its live run. */
  readonly runId?: string;
  /** The worker, not model input, binds create_routine's confirmation message to the real thread. */
  readonly threadId?: string;
}

interface JsonRpcRequest {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
}

const SEND_TO_ROLE_TOOL_NAME = "send_to_role";
const RENAME_SELF_TOOL_NAME = "rename_self";
const REQUEST_SECRET_TOOL_NAME = "request_secret";
const CREATE_ROUTINE_TOOL_NAME = "create_routine";
const CREATE_BOT_TOOL_NAME = "create_bot";
const RETIRE_BOT_TOOL_NAME = "retire_bot";

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
      { name: REQUEST_SECRET_TOOL_NAME, description: "Ask a human to provide a secret without placing its value in the transcript.", inputSchema: requestSecretInputSchema },
      { name: CREATE_ROUTINE_TOOL_NAME, description: CREATE_ROUTINE_TOOL_DESCRIPTION, inputSchema: createRoutineInputSchema },
      { name: CREATE_BOT_TOOL_NAME, description: "Create a new bot with the default capability floor. External-facing and human-approvable.", inputSchema: createBotInputSchema },
      { name: RETIRE_BOT_TOOL_NAME, description: "Retire another bot (soft deactivation, never itself, never cross-tenant). Irreversible-tier and human-approvable.", inputSchema: retireBotInputSchema },
    ] });
  }
  if (request.method !== "tools/call") {
    return errorResponse(request.id ?? null, -32601, "Method not found");
  }
  try {
    const call = parseToolCall(request.params);
    if (call.name === SEND_TO_ROLE_TOOL_NAME) {
      const input = toSendInput(call.arguments, identity);
      // The model knows a recipient only by its human-facing name, never its
      // real role_id (TASK-214 Gemini-parity finding, applies equally here).
      const resolvedToRoleId = await resolveRoleIdentifier({ connectionString: identity.connectionString }, identity.fromRoleId, input.toRoleId);
      const acknowledgement = await sendToRole({ connectionString: identity.connectionString }, { ...input, toRoleId: resolvedToRoleId });
      return resultResponse(request.id, { content: [{ type: "text", text: JSON.stringify(acknowledgement) }] });
    }
    if (call.name === REQUEST_SECRET_TOOL_NAME) {
      if (identity.runId === undefined || identity.runId.trim().length === 0) throw new Error("request_secret requires a worker-bound run ID.");
      const input = parseRequestSecretInput(call.arguments);
      const secretRequest = await createSecretRequest(
        { connectionString: identity.connectionString },
        { tenantId: identity.tenantId, roleId: identity.fromRoleId, runId: identity.runId, ...input },
      );
      await insertAuditEvent(
        { connectionString: identity.connectionString },
        { tenantId: identity.tenantId, runId: identity.runId, actor: `agent:${identity.fromRoleId}`, eventType: "secret.requested", payload: { requestId: secretRequest.requestId, label: secretRequest.label, purpose: secretRequest.purpose } },
      );
      // The same typed lifecycle accessor used by the real RunParkPort.
      await parkTaskRun({ connectionString: identity.connectionString }, identity.runId);
      return resultResponse(request.id, { content: [{ type: "text", text: JSON.stringify({ status: "pending", requestId: secretRequest.requestId }) }] });
    }
    if (call.name === CREATE_ROUTINE_TOOL_NAME) {
      const input = parseCreateRoutineInput(call.arguments);
      const result = await createRoutineFromToolInput(
        { connectionString: identity.connectionString, tenantId: identity.tenantId, roleId: identity.fromRoleId, threadId: identity.threadId },
        input,
      );
      return resultResponse(request.id, { content: [{ type: "text", text: JSON.stringify(result) }] });
    }
    if (call.name === CREATE_BOT_TOOL_NAME) {
      const input = toCreateBotInput(call.arguments);
      const role = await createRoleWithDefaultCapabilities(
        { connectionString: identity.connectionString },
        { tenantId: identity.tenantId, ...input },
      );
      if (identity.runId !== undefined && identity.runId.trim().length > 0) {
        await insertAuditEvent(
          { connectionString: identity.connectionString },
          { tenantId: identity.tenantId, runId: identity.runId, actor: `agent:${identity.fromRoleId}`, eventType: "bot.created", payload: { roleId: role.roleId, name: role.name } },
        );
      }
      return resultResponse(request.id, { content: [{ type: "text", text: JSON.stringify({ roleId: role.roleId, name: role.name, status: role.status }) }] });
    }
    if (call.name === RETIRE_BOT_TOOL_NAME) {
      const targetRoleId = toRetireBotInput(call.arguments);
      try {
        const role = await retireRole(
          { connectionString: identity.connectionString },
          { tenantId: identity.tenantId, callerRoleId: identity.fromRoleId, targetRoleId },
        );
        if (identity.runId !== undefined && identity.runId.trim().length > 0) {
          await insertAuditEvent(
            { connectionString: identity.connectionString },
            { tenantId: identity.tenantId, runId: identity.runId, actor: `agent:${identity.fromRoleId}`, eventType: "bot.retired", payload: { roleId: role.roleId, status: role.status } },
          );
        }
        return resultResponse(request.id, { content: [{ type: "text", text: JSON.stringify({ roleId: role.roleId, status: role.status }) }] });
      } catch (error) {
        if (error instanceof RoleRetirementError) {
          return resultResponse(request.id, { content: [{ type: "text", text: error.message }], isError: true });
        }
        throw error;
      }
    }
    const role = await updateRoleName({ connectionString: identity.connectionString }, identity.fromRoleId, toRenameInput(call.arguments));
    if (role === null) throw new Error("Calling role was not found.");
    return resultResponse(request.id, { content: [{ type: "text", text: JSON.stringify({ roleId: role.roleId, name: role.name }) }] });
  } catch (error) {
    return resultResponse(request.id, { content: [{ type: "text", text: error instanceof Error ? error.message : "Unable to send handoff." }], isError: true });
  }
}

type WorkspaceToolName =
  | typeof SEND_TO_ROLE_TOOL_NAME
  | typeof RENAME_SELF_TOOL_NAME
  | typeof REQUEST_SECRET_TOOL_NAME
  | typeof CREATE_ROUTINE_TOOL_NAME
  | typeof CREATE_BOT_TOOL_NAME
  | typeof RETIRE_BOT_TOOL_NAME;

function parseToolCall(params: unknown): {
  name: WorkspaceToolName;
  arguments: Record<string, unknown>;
} {
  if (typeof params !== "object" || params === null || Array.isArray(params)) throw new Error("tools/call requires params.");
  const call = params as { name?: unknown; arguments?: unknown };
  const knownName = call.name === SEND_TO_ROLE_TOOL_NAME || call.name === RENAME_SELF_TOOL_NAME
    || call.name === REQUEST_SECRET_TOOL_NAME || call.name === CREATE_ROUTINE_TOOL_NAME
    || call.name === CREATE_BOT_TOOL_NAME || call.name === RETIRE_BOT_TOOL_NAME;
  if (!knownName || typeof call.arguments !== "object" || call.arguments === null || Array.isArray(call.arguments)) throw new Error("Unknown workspace tool.");
  return { name: call.name as WorkspaceToolName, arguments: call.arguments as Record<string, unknown> };
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

function toCreateBotInput(args: Record<string, unknown>): { name: string; title: string; description?: string } {
  if (typeof args.name !== "string" || args.name.trim().length === 0) throw new Error("create_bot requires a non-empty string name.");
  if (typeof args.title !== "string" || args.title.trim().length === 0) throw new Error("create_bot requires a non-empty string title.");
  if (args.description !== undefined && typeof args.description !== "string") throw new Error("create_bot's description must be a string.");
  return {
    name: args.name,
    title: args.title,
    ...(args.description === undefined ? {} : { description: args.description }),
  };
}

function toRetireBotInput(args: Record<string, unknown>): string {
  if (Object.keys(args).length !== 1 || typeof args.roleId !== "string" || args.roleId.trim().length === 0) {
    throw new Error("retire_bot requires exactly one non-empty string roleId argument.");
  }
  return args.roleId;
}

function resultResponse(id: unknown, result: unknown): Record<string, unknown> { return { jsonrpc: "2.0", id: id ?? null, result }; }
function errorResponse(id: unknown, code: number, message: string): Record<string, unknown> { return { jsonrpc: "2.0", id: id ?? null, error: { code, message } }; }

const sendToRoleInputSchema = {
  type: "object",
  required: ["toRoleId", "body"],
  additionalProperties: false,
  properties: {
    toRoleId: { type: "string", description: "The recipient bot's name (e.g. \"jipolt\") or its role ID." }, body: { type: "string" }, workspaceRefs: { type: "array", items: { type: "string" } },
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

const requestSecretInputSchema = {
  type: "object", required: ["label", "purpose"], additionalProperties: false,
  properties: {
    label: { type: "string", minLength: 1, maxLength: 200 },
    purpose: { type: "string", minLength: 1, maxLength: 2000 },
  },
};

const createBotInputSchema = {
  type: "object",
  required: ["name", "title"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 100 },
    title: { type: "string", minLength: 1, maxLength: 200 },
    description: { type: "string", maxLength: 2000 },
  },
};

const retireBotInputSchema = {
  type: "object",
  required: ["roleId"],
  additionalProperties: false,
  properties: { roleId: { type: "string", minLength: 1 } },
};

function readIdentity(argv: readonly string[]): WorkspaceMcpServerIdentity {
  const [connectionString, tenantId, fromRoleId, runId, threadId] = argv;
  if ([connectionString, tenantId, fromRoleId, runId].some((value) => typeof value !== "string" || value.trim().length === 0)) throw new Error("workspace MCP requires connection string, tenant ID, sender role ID, and run ID.");
  return {
    connectionString, tenantId, fromRoleId, runId,
    ...(typeof threadId === "string" && threadId.trim().length > 0 ? { threadId } : {}),
  };
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) startWorkspaceMcpServer(readIdentity(process.argv.slice(2)));
