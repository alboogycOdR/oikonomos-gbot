import { issueApproval, verifyAndConsume, type ApprovalWaitSignal } from "@oikonomos/approvals";
import { BUILTIN_TOOLS, CapabilityRegistry, PolicyRegistry, declaredToolsFromManifest, type BrokerDependencies, type PreToolUseRequest } from "@oikonomos/broker";
import { defaultManifestsDir, loadManifests } from "@oikonomos/connectors";
import { Database, getOrCreateThreadForRole, insertMessage, type DatabaseOptions, type Task } from "@oikonomos/db";
import { recordAuditEvent, recordDecision } from "@oikonomos/audit";
import { executeTaskRun } from "./executeRun.js";
import { completeTaskRun, failTaskRun, startTaskRun } from "./runLifecycle.js";

export interface ChatRunRequest { readonly task: Task; readonly threadId: string; }
export interface ChatRunDriver { run(request: ChatRunRequest): Promise<void>; }
export interface CreateChatRunDriverOptions extends DatabaseOptions { readonly manifestsDir?: string; }

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
    const policy = new PolicyRegistry({ mountedToolNames: ["Bash", "Read"], policies: [{ toolName: "Bash" }, { toolName: "Read" }], manifestToolNames: [...registry.enabledToolNames] });
    const run = await startTaskRun(options, { taskId: request.task.taskId, provider: "claude", tenantId: request.task.tenantId });
    runId = run.runId;
    const result = await executeTaskRun({
      prompt: request.task.goal,
      run: { runId: run.runId, roleId: request.task.roleId, tenantId: request.task.tenantId, agentRef: { provider: "claude", sessionRef: run.sessionRef ?? run.runId, isSubagent: false } },
      // L2 requires the scoped form; PolicyRegistry receives its bare name.
      allowedTools: ["Bash(*)", "Read(*)"],
      brokerDependencies: createBrokerDependencies(options, database, registry, policy),
      auditSink: completionAuditSink(options, run),
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

export function finalText(events: readonly unknown[]): string {
  for (const event of [...events].reverse()) if (typeof event === "object" && event !== null && typeof (event as { result?: unknown }).result === "string") {
    const result = (event as { result: string }).result.trim(); if (result.length > 0) return result;
  }
  return "I completed the requested chat run.";
}
/**
 * TASK-122 (Chat-2c) — the fan-out-approval rule, confirmed against the
 * real Grok Bot reference product 2026-09-03 (PLAN.md orchestrator_notes):
 * a single 1:1 bot-to-bot delegation ping needs no human approval; a bot
 * messaging multiple bots or a whole group in one action does. Kept
 * deliberately narrow (Description's own instruction: "this task does not
 * need to solve general multi-agent orchestration, only gate the fan-out
 * case") — a single exported gate function, not a new orchestration layer.
 *
 * Reuses the existing approval-issuance path (`issueApproval`, already
 * imported and already used by this driver's own `brokerDependencies`)
 * rather than inventing a second one, per the Description. The gate runs
 * *before* any message is persisted: a fan-out call returns the pending
 * `ApprovalWaitSignal` and delivers nothing; a single-recipient call
 * delivers immediately via the same `insertMessage`/`getOrCreateThreadForRole`
 * primitives `runChatTask` already uses for the human-facing bot reply.
 */
export interface BotToBotMessageRequest {
  readonly fromRoleId: string;
  readonly toRoleIds: readonly string[];
  readonly body: string;
  readonly runId: string;
  readonly tenantId?: string;
}
export type BotToBotMessageResult =
  | { readonly delivered: true }
  | { readonly delivered: false; readonly approval: ApprovalWaitSignal };

export const CHAT_FANOUT_CAPABILITY_ID = "chat.bot_fanout";

export async function deliverBotToBotMessage(
  options: DatabaseOptions,
  request: BotToBotMessageRequest,
): Promise<BotToBotMessageResult> {
  const fromRoleId = request.fromRoleId.trim();
  if (fromRoleId.length === 0) throw new Error("bot-to-bot message requires fromRoleId.");
  const toRoleIds = [...new Set(request.toRoleIds.map((roleId) => roleId.trim()))].filter(
    (roleId) => roleId.length > 0,
  );
  if (toRoleIds.length === 0) throw new Error("bot-to-bot message requires at least one recipient role.");
  const body = request.body.trim();
  if (body.length === 0) throw new Error("bot-to-bot message body must not be empty.");

  // Fan-out: 2+ distinct recipients requires a real pending approval
  // before anything is sent — deleting this branch (falling through to
  // direct delivery below for every case) is exactly the mutation the
  // liveness test proves against: it would make every fan-out deliver
  // immediately with zero pending approvals, reddening the test.
  if (toRoleIds.length > 1) {
    // `approvals.capability_id` FK-references `capabilities` — upsert
    // (idempotent) rather than requiring a manifest/migration for this
    // one governed action, same pattern packages/db's own
    // `seedInboxTriage` uses for a capability with no connector manifest.
    const database = new Database(options);
    try {
      await database.upsertCapability({
        capabilityId: CHAT_FANOUT_CAPABILITY_ID,
        description: "Send a chat message to more than one bot or a whole group in one action.",
        defaultTier: "T2_internal",
        adapter: "chat:bot_fanout",
        enabled: true,
      });
    } finally {
      await database.close();
    }
    const approval = await issueApproval(
      {
        runId: request.runId,
        capabilityId: CHAT_FANOUT_CAPABILITY_ID,
        toolName: "chat.bot_fanout",
        input: { fromRoleId, toRoleIds, body },
        destination: toRoleIds.join(","),
        ...(request.tenantId === undefined ? {} : { tenantId: request.tenantId }),
      },
      { database: options },
    );
    return { delivered: false, approval };
  }

  const [toRoleId] = toRoleIds;
  const thread = await getOrCreateThreadForRole(options, { roleId: toRoleId! });
  await insertMessage(options, {
    threadId: thread.id,
    role: "bot",
    body,
    runId: request.runId,
    senderRoleId: fromRoleId,
  });
  return { delivered: true };
}

function assertRequest(request: ChatRunRequest): void {
  if (typeof request?.threadId !== "string" || request.threadId.trim().length === 0) throw new Error("chat run requires threadId.");
  if (typeof request?.task?.taskId !== "string" || request.task.taskId.trim().length === 0) throw new Error("chat run requires task.");
}
