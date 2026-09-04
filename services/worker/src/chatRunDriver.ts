import { issueApproval, verifyAndConsume, type ApprovalWaitSignal } from "@oikonomos/approvals";
import { fileURLToPath } from "node:url";
import { BUILTIN_TOOLS, CapabilityRegistry, PolicyRegistry, declaredToolsFromManifest, type BrokerDependencies, type PreToolUseRequest } from "@oikonomos/broker";
import {
  createConnectorSessionPool,
  createGmailConnectorSessionMinter,
  defaultManifestsDir,
  loadManifests,
  type ConnectorManifest,
  type ConnectorSessionPool,
  type CreateGmailConnectorSessionMinterOptions,
} from "@oikonomos/connectors";
import { Database, getOrCreateThreadForRole, insertMessage, type DatabaseOptions, type Task } from "@oikonomos/db";
import { recordAuditEvent, recordDecision } from "@oikonomos/audit";
import { executeTaskRun, type ConnectorContext } from "./executeRun.js";
import { completeTaskRun, failTaskRun, parkTaskRun, startTaskRun } from "./runLifecycle.js";
import type { AgentSdkQueryFn } from "@oikonomos/harness-factory";
import type { RunParkPort } from "@oikonomos/harness-factory/compose";

export interface ChatRunRequest { readonly task: Task; readonly threadId: string; }
export interface ChatRunDriver { run(request: ChatRunRequest): Promise<void>; }
export interface CreateChatRunDriverOptions extends DatabaseOptions {
  readonly manifestsDir?: string;
  /** Test-only manifest seam; production always loads the validated manifest directory. */
  readonly manifests?: readonly ConnectorManifest[];
  /** Test-only Agent SDK seam; production uses the SDK's default query function. */
  readonly queryFn?: AgentSdkQueryFn;
  /**
   * Test seam for connector session acquisition. Production callers leave
   * this unset and use the Gmail OAuth-backed session minter below.
   */
  readonly connectorSessionPool?: ConnectorSessionPool;
  /** Overrides for the Gmail minter's secret/OAuth ports; never logged. */
  readonly gmailSessionMinter?: Omit<CreateGmailConnectorSessionMinterOptions, "manifest">;
}

/** First production chat task-to-run composition; registry resolution is declaration- and DB-backed. */
export function createChatRunDriver(options: CreateChatRunDriverOptions): ChatRunDriver {
  let gmailSessionPool = options.connectorSessionPool;
  return {
    run: async (request) => runChatTask(options, request, (manifest) => {
      if (gmailSessionPool === undefined) {
        gmailSessionPool = createConnectorSessionPool({
          mint: createGmailConnectorSessionMinter({
            manifest,
            resolveUrl: options.gmailSessionMinter?.resolveUrl ?? resolveGmailMcpUrl,
            ...(options.gmailSessionMinter?.oauth === undefined ? {} : { oauth: options.gmailSessionMinter.oauth }),
            ...(options.gmailSessionMinter?.serverName === undefined ? {} : { serverName: options.gmailSessionMinter.serverName }),
          }),
        });
      }
      return gmailSessionPool;
    }),
  };
}

/** The Gmail minter requires a URL resolver; keep the secret value out of errors. */
async function resolveGmailMcpUrl(ref: string): Promise<string> {
  if (ref !== "secret://mcp/gmail/url") throw new Error(`unsupported connector URL secret ref: ${ref}`);
  const value = process.env.OIK_SECRET_MCP_GMAIL_URL;
  if (value === undefined || value.length === 0) throw new Error(`secret ref is unset: ${ref}`);
  return value;
}

async function runChatTask(
  options: CreateChatRunDriverOptions,
  request: ChatRunRequest,
  gmailPoolFor: (manifest: ConnectorManifest) => ConnectorSessionPool,
): Promise<void> {
  assertRequest(request);
  const database = new Database(options);
  let runId: string | undefined;
  try {
    const manifests = options.manifests ?? await loadManifests(options.manifestsDir ?? defaultManifestsDir());
    const registry = await CapabilityRegistry.build({ declared: [...BUILTIN_TOOLS, ...manifests.flatMap(declaredToolsFromManifest)], persisted: database });
    const acquiredConnector = await resolveGrantedGmailConnector({
      database,
      manifests,
      roleId: request.task.roleId,
      tenantId: request.task.tenantId,
      gmailPoolFor,
    });
    const workspaceConnector = await resolveGrantedWorkspaceConnector({
      database,
      roleId: request.task.roleId,
      tenantId: request.task.tenantId,
      connectionString: options.connectionString,
    });
    const connector = combineConnectorContexts(acquiredConnector?.connector, workspaceConnector);
    const mountedToolNames = ["Bash", "Read", ...(connector?.allowedTools ?? [])];
    const policy = new PolicyRegistry({
      mountedToolNames,
      policies: mountedToolNames.map((toolName) => ({ toolName })),
      manifestToolNames: [...registry.enabledToolNames],
    });
    const run = await startTaskRun(options, { taskId: request.task.taskId, provider: "claude", tenantId: request.task.tenantId });
    runId = run.runId;
    let result;
    try {
      result = await executeTaskRun({
        prompt: request.task.goal,
        run: { runId: run.runId, roleId: request.task.roleId, tenantId: request.task.tenantId, agentRef: { provider: "claude", sessionRef: run.sessionRef ?? run.runId, isSubagent: false } },
        // L2 requires the scoped form; PolicyRegistry receives its bare name.
        allowedTools: ["Bash(*)", "Read(*)"],
        ...(options.queryFn === undefined ? {} : { queryFn: options.queryFn }),
        ...(connector === undefined ? {} : { connector }),
        brokerDependencies: createBrokerDependencies(options, database, registry, policy),
        auditSink: completionAuditSink(options, run),
        park: createRunParkPort(options, run.runId),
      });
    } finally {
      if (acquiredConnector !== undefined) acquiredConnector.pool.release(acquiredConnector.handle);
    }
    await insertMessage(options, { threadId: request.threadId, role: "bot", body: finalText(result.events), runId: run.runId });
    await completeTaskRun(options, run.runId);
  } catch (error) {
    if (runId !== undefined) await failTaskRun(options, runId, error instanceof Error ? error.message : "chat run failed");
    throw error;
  } finally { await database.close(); }
}

const WORKSPACE_SEND_TO_ROLE_CAPABILITY_ID = "workspace.send_to_role";
const WORKSPACE_SEND_TO_ROLE_TOOL = "mcp__workspace__send_to_role";

/** Mount the internal stdio bridge only when its persisted role grant exists. */
async function resolveGrantedWorkspaceConnector(input: {
  readonly database: Database;
  readonly connectionString: string;
  readonly roleId: string;
  readonly tenantId: string;
}): Promise<ConnectorContext | undefined> {
  const grants = await input.database.listRoleGrants(input.roleId);
  if (!grants.some((grant) => grant.capabilityId === WORKSPACE_SEND_TO_ROLE_CAPABILITY_ID)) return undefined;
  return {
    manifest: { connector_id: "workspace", mcp_server: { name: "workspace" }, tools: [] },
    mcpServers: {
      workspace: {
        transport: "stdio",
        command: process.execPath,
        args: [fileURLToPath(new URL("./workspaceMcpServer.js", import.meta.url)), input.connectionString, input.tenantId, input.roleId],
      },
    },
    allowedTools: [WORKSPACE_SEND_TO_ROLE_TOOL],
  };
}

/** executeTaskRun accepts one context; merge independently grant-derived MCP mounts into it. */
function combineConnectorContexts(
  first: ConnectorContext | undefined,
  second: ConnectorContext | undefined,
): ConnectorContext | undefined {
  if (first === undefined) return second;
  if (second === undefined) return first;
  return {
    manifest: first.manifest,
    mcpServers: { ...first.mcpServers, ...second.mcpServers },
    allowedTools: [...first.allowedTools, ...second.allowedTools],
  };
}

interface AcquiredConnector {
  readonly connector: ConnectorContext;
  readonly pool: ConnectorSessionPool;
  readonly handle: Awaited<ReturnType<ConnectorSessionPool["acquire"]>>;
}

/**
 * Derive the connector surface from persisted grants, not from a model prompt
 * or a manifest default. Gmail is deliberately the only mounted connector in
 * this wave: other manifests have no session minter yet and therefore remain
 * unavailable even if their rows are granted.
 */
async function resolveGrantedGmailConnector(input: {
  readonly database: Database;
  readonly manifests: readonly ConnectorManifest[];
  readonly roleId: string;
  readonly tenantId: string;
  readonly gmailPoolFor: (manifest: ConnectorManifest) => ConnectorSessionPool;
}): Promise<AcquiredConnector | undefined> {
  const manifest = input.manifests.find((candidate) => candidate.connector_id === "gmail");
  if (manifest === undefined) return undefined;

  const grantedCapabilities = new Set((await input.database.listRoleGrants(input.roleId)).map((grant) => grant.capabilityId));
  const allowedTools = manifest.tools
    .filter((tool) => tool.enabled !== false && grantedCapabilities.has(tool.capability_id))
    .map((tool) => tool.tool_name);
  if (allowedTools.length === 0) return undefined;

  const pool = input.gmailPoolFor(manifest);
  const handle = await pool.acquire(input.tenantId, manifest.connector_id);
  return {
    pool,
    handle,
    connector: { manifest, mcpServers: handle.mcpServers, allowedTools },
  };
}

/**
 * TASK-136 — the real `RunParkPort` `runChatTask` wires into `executeTaskRun`.
 * `withPark` in `packages/harness-factory` calls `park()` exactly once, only
 * when L1 denies a tool use for a reason in `PARK_REASONS` (`approval_pending`
 * plus the fail-closed broker-error reasons, CAN-04) — this transitions the
 * run's DB status to `waiting_approval` via the typed `parkTaskRun` accessor,
 * closing the gap TASK-135 documented (no chat run ever reached that status
 * in production before this). The Agent SDK query loop continues after a
 * denial (the tool call simply fails for that turn), so the run still runs
 * to completion/failure normally afterward; `completeRun`/`failRun` both
 * already accept `waiting_approval` as a legal source status, so no further
 * change is needed for the run to still terminate correctly. Deliberately
 * scoped to reaching-and-proving `waiting_approval` only, per this task's own
 * Description: the harder "resume the live session after a human grants the
 * approval" question is out of scope for this task (see dossier).
 */
function createRunParkPort(options: DatabaseOptions, runId: string): RunParkPort {
  return {
    park: async () => {
      await parkTaskRun(options, runId);
    },
  };
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
          : request.toolName === "mcp__gmail__list_messages" ? input.q
          : request.toolName === "mcp__gmail__send_message" ? input.to
            : request.toolName === WORKSPACE_SEND_TO_ROLE_TOOL ? input.toRoleId : undefined;
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
