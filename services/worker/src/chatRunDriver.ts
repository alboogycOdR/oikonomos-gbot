import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { issueApproval, verifyAndConsume } from "@oikonomos/approvals";
import { BUILTIN_TOOLS, CapabilityRegistry, PolicyRegistry, declaredToolsFromManifest, type BrokerDependencies, type PreToolUseRequest } from "@oikonomos/broker";
import { defaultManifestsDir, loadManifests } from "@oikonomos/connectors";
import { Database, insertMessage, type DatabaseOptions, type Task } from "@oikonomos/db";
import { recordAuditEvent, recordDecision } from "@oikonomos/audit";
import type { AgentSdkQueryFn } from "@oikonomos/harness-factory";
import { executeTaskRun } from "./executeRun.js";
import { completeTaskRun, failTaskRun, startTaskRun } from "./runLifecycle.js";

const execFileAsync = promisify(execFile);
export interface ChatRunRequest { readonly task: Task; readonly threadId: string; }
export interface ChatRunDriver { run(request: ChatRunRequest): Promise<void>; }
export interface CreateChatRunDriverOptions extends DatabaseOptions { readonly queryFn?: AgentSdkQueryFn; readonly manifestsDir?: string; }

/** First production chat task-to-run composition; registry resolution is declaration- and DB-backed. */
export function createChatRunDriver(options: CreateChatRunDriverOptions): ChatRunDriver {
  return { run: async (request) => runChatTask(options, request) };
}

async function runChatTask(options: CreateChatRunDriverOptions, request: ChatRunRequest): Promise<void> {
  assertRequest(request);
  const database = new Database(options);
  let runId: string | undefined;
  try {
    const manifests = await loadManifests(options.manifestsDir ?? defaultManifestsDir());
    const registry = await CapabilityRegistry.build({ declared: [...BUILTIN_TOOLS, ...manifests.flatMap(declaredToolsFromManifest)], persisted: database });
    const policy = new PolicyRegistry({ mountedToolNames: ["Bash"], policies: [{ toolName: "Bash" }], manifestToolNames: [...registry.enabledToolNames] });
    const run = await startTaskRun(options, { taskId: request.task.taskId, provider: "claude", tenantId: request.task.tenantId });
    runId = run.runId;
    const result = await executeTaskRun({
      prompt: request.task.goal,
      run: { runId: run.runId, roleId: request.task.roleId, tenantId: request.task.tenantId, agentRef: { provider: "claude", sessionRef: run.sessionRef ?? run.runId, isSubagent: false } },
      allowedTools: ["Bash"],
      brokerDependencies: createBrokerDependencies(options, database, registry, policy),
      auditSink: completionAuditSink(options, run),
      queryFn: options.queryFn ?? createSystemClaudeQuery(),
    });
    await insertMessage(options, { threadId: request.threadId, role: "bot", body: finalText(result.events), runId: run.runId });
    await completeTaskRun(options, run.runId);
  } catch (error) {
    if (runId !== undefined) await failTaskRun(options, runId, error instanceof Error ? error.message : "chat run failed");
    throw error;
  } finally { await database.close(); }
}

function createBrokerDependencies(options: DatabaseOptions, database: Database, registry: CapabilityRegistry, policy: PolicyRegistry): BrokerDependencies {
  return {
    isCapabilitiesEnabled: () => process.env.OIKONOMOS_CAPABILITIES_ENABLED === "true",
    ...registry.brokerPorts(database), destinationFor, issueApproval, verifyAndConsume,
    issueApprovalDependencies: { database: options }, consumeDependencies: { database: options }, manifestMap: policy.manifestMap,
    recordDecision: async (event) => ({ eventId: (await recordDecision(options, event)).eventId }),
  };
}

interface CompletionAuditSink {
  writeCompletionEvidence(evidence: { toolUseId: string; toolName: string; resultDigest: string; artifactUris: readonly string[] }): Promise<void>;
}
function completionAuditSink(options: DatabaseOptions, run: { runId: string; tenantId: string }): CompletionAuditSink {
  return { writeCompletionEvidence: async (evidence) => { await recordAuditEvent(options, { tenantId: run.tenantId, runId: run.runId, actor: "agent:claude", eventType: "tool.completed", payload: { ...evidence } }); } };
}

/** ADR-013's v1 target extraction. Unknown shapes deliberately fail closed. */
export function destinationFor(request: PreToolUseRequest): string {
  const input = request.input;
  const destination = request.toolName === "Read" || request.toolName === "Edit" || request.toolName === "Write" ? input.file_path
    : request.toolName === "Glob" || request.toolName === "Grep" ? input.path ?? input.pattern
      : request.toolName === "Bash" ? input.command
        : request.toolName === "mcp__gmail__send_message" ? input.to : undefined;
  if (typeof destination !== "string" || destination.trim().length === 0) throw new Error(`No governed destination for tool '${request.toolName}'.`);
  return destination;
}

function createSystemClaudeQuery(): AgentSdkQueryFn { return (input) => systemClaudeQuery(input); }
async function* systemClaudeQuery(input: Parameters<AgentSdkQueryFn>[0]): AsyncGenerator<unknown> {
  const executable = await resolveClaudeExecutable();
  const callerOptions = input.options && typeof input.options === "object" ? input.options : {};
  if (typeof input.prompt !== "string") throw new Error("chat runs require a string prompt.");
  yield* sdkQuery({ prompt: input.prompt, options: { ...callerOptions, pathToClaudeCodeExecutable: executable } });
}
async function resolveClaudeExecutable(): Promise<string> {
  const configured = process.env.OIKONOMOS_CLAUDE_EXECUTABLE;
  if (configured !== undefined && configured.trim().length > 0) return configured.trim();
  const { stdout } = await execFileAsync(process.platform === "win32" ? "where.exe" : "which", ["claude"], { windowsHide: true });
  const found = stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (found === undefined) throw new Error("System Claude executable was not found; set OIKONOMOS_CLAUDE_EXECUTABLE.");
  return found;
}
export function finalText(events: readonly unknown[]): string {
  for (const event of [...events].reverse()) if (typeof event === "object" && event !== null && typeof (event as { result?: unknown }).result === "string") {
    const result = (event as { result: string }).result.trim(); if (result.length > 0) return result;
  }
  return "I completed the requested chat run.";
}
function assertRequest(request: ChatRunRequest): void {
  if (typeof request?.threadId !== "string" || request.threadId.trim().length === 0) throw new Error("chat run requires threadId.");
  if (typeof request?.task?.taskId !== "string" || request.task.taskId.trim().length === 0) throw new Error("chat run requires task.");
}
