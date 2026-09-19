import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { createProjectTools, PROJECT_TOOL_NAMES, type ProjectToolIdentity, type ProjectToolName } from "./projectTools.js";

const stringSchema = { type: "string", minLength: 1 };
const schemas: Record<ProjectToolName, Record<string, unknown>> = {
  list_board: schema(["projectId"], { projectId: stringSchema }),
  create_task: schema(["projectId", "title"], { projectId: stringSchema, title: stringSchema, description: stringSchema, ownerRoleId: stringSchema, doneCriterion: stringSchema }),
  update_task: schema(["taskId", "state"], { taskId: stringSchema, state: { type: "string", enum: ["todo", "doing", "blocked", "review", "done", "cancelled"] }, blockedReason: stringSchema }),
  assign_task: schema(["taskId", "ownerRoleId"], { taskId: stringSchema, ownerRoleId: stringSchema }),
  register_artifact: schema(["projectId", "kind", "ref", "label"], { projectId: stringSchema, taskId: stringSchema, kind: { type: "string", enum: ["workspace_file", "attachment", "run_receipt"] }, ref: stringSchema, sha256: stringSchema, byteSize: { type: "integer", minimum: 0 }, label: stringSchema }),
  record_decision: schema(["projectId", "kind", "summary"], { projectId: stringSchema, taskId: stringSchema, kind: { type: "string", enum: ["approval", "human_decision", "manager_decision", "review_finding"] }, approvalId: stringSchema, summary: stringSchema }),
};
function schema(required: readonly string[], properties: Record<string, unknown>) { return { type: "object", required, additionalProperties: false, properties }; }

export function startProjectMcpServer(identity: ProjectToolIdentity): void {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (line) => { void handleProjectMcpRequest(line, identity).then((response) => { if (response !== undefined) process.stdout.write(`${JSON.stringify(response)}\n`); }).catch((error: unknown) => process.stderr.write(`project MCP request failed: ${error instanceof Error ? error.message : "unknown error"}\n`)); });
}

/** Separate from stdio for direct, deterministic server tests. */
export async function handleProjectMcpRequest(line: string, identity: ProjectToolIdentity): Promise<Record<string, unknown> | undefined> {
  let request: { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  try { request = JSON.parse(line) as typeof request; } catch { return error(null, -32700, "Parse error"); }
  if (request.jsonrpc !== "2.0" || typeof request.method !== "string") return error(request.id ?? null, -32600, "Invalid Request");
  if (request.method === "notifications/initialized") return;
  if (request.method === "initialize") return result(request.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "oikonomos-project", version: "1.0.0" } });
  if (request.method === "tools/list") return result(request.id, { tools: PROJECT_TOOL_NAMES.map((name) => ({ name, description: `Project ${name.replaceAll("_", " ")}.`, inputSchema: schemas[name] })) });
  if (request.method !== "tools/call") return error(request.id ?? null, -32601, "Method not found");
  try {
    if (typeof request.params !== "object" || request.params === null || Array.isArray(request.params)) throw new Error("tools/call requires params.");
    const call = request.params as { name?: unknown; arguments?: unknown };
    if (typeof call.name !== "string" || !PROJECT_TOOL_NAMES.includes(call.name as ProjectToolName) || typeof call.arguments !== "object" || call.arguments === null || Array.isArray(call.arguments)) throw new Error("Unknown project tool.");
    const output = await createProjectTools(identity)[call.name as ProjectToolName](call.arguments as Record<string, unknown>);
    return result(request.id, { content: [{ type: "text", text: JSON.stringify(output) }] });
  } catch (cause) { return result(request.id, { content: [{ type: "text", text: cause instanceof Error ? cause.message : "Project tool failed." }], isError: true }); }
}

function result(id: unknown, value: unknown): Record<string, unknown> { return { jsonrpc: "2.0", id: id ?? null, result: value }; }
function error(id: unknown, code: number, message: string): Record<string, unknown> { return { jsonrpc: "2.0", id: id ?? null, error: { code, message } }; }
function readIdentity(argv: readonly string[]): ProjectToolIdentity { const [connectionString, tenantId, fromRoleId, runId] = argv; if ([connectionString, tenantId, fromRoleId].some((value) => typeof value !== "string" || value.trim() === "")) throw new Error("project MCP requires connection string, tenant ID, and calling role ID."); return { connectionString, tenantId, fromRoleId, ...(typeof runId === "string" && runId.trim() !== "" ? { runId } : {}) }; }

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) startProjectMcpServer(readIdentity(process.argv.slice(2)));
