import { issueApproval, verifyAndConsume, type ApprovalWaitSignal } from "@oikonomos/approvals";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_TOOLS, CapabilityRegistry, PolicyRegistry, declaredToolsFromManifest, type BrokerDependencies, type PreToolUseRequest } from "@oikonomos/broker";
import {
  createConnectorSessionPool,
  createGmailConnectorSessionMinter,
  createGoogleCalendarConnectorSessionMinter,
  createGoogleDriveConnectorSessionMinter,
  defaultManifestsDir,
  envSecretResolver,
  loadManifests,
  type ConnectorManifest,
  type ConnectorSessionPool,
  type CreateGmailConnectorSessionMinterOptions,
  type CreateGoogleCalendarConnectorSessionMinterOptions,
  type CreateGoogleDriveConnectorSessionMinterOptions,
} from "@oikonomos/connectors";
import { Database, getOrCreateThreadForRole, getRole, insertMessage, type DatabaseOptions, type Role, type Task } from "@oikonomos/db";
import { recordAuditEvent, recordDecision } from "@oikonomos/audit";
import { executeTaskRun, type ConnectorContext } from "./executeRun.js";
import { completeTaskRun, failTaskRun, parkTaskRun, resumeInterruptedRun, startTaskRun } from "./runLifecycle.js";
import type { AgentSdkQueryFn } from "@oikonomos/harness-factory";
import type { RunParkPort } from "@oikonomos/harness-factory/compose";

export interface ChatRunRequest {
  readonly task: Task;
  readonly threadId: string;
  /** Continue this persisted Agent SDK session instead of starting a new run. */
  readonly resume?: { readonly runId: string; readonly sessionRef: string };
}
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
  /** Overrides for the Calendar minter's secret/OAuth ports; never logged. */
  readonly calendarSessionMinter?: Omit<CreateGoogleCalendarConnectorSessionMinterOptions, "manifest">;
  /** Overrides for the Drive minter's secret/OAuth ports; never logged. */
  readonly driveSessionMinter?: Omit<CreateGoogleDriveConnectorSessionMinterOptions, "manifest">;
}

/** First production chat task-to-run composition; registry resolution is declaration- and DB-backed. */
export function createChatRunDriver(options: CreateChatRunDriverOptions): ChatRunDriver {
  let gmailSessionPool = options.connectorSessionPool;
  let calendarSessionPool: ConnectorSessionPool | undefined;
  let driveSessionPool: ConnectorSessionPool | undefined;
  return {
    run: async (request) => runChatTask(options, request, {
      gmailPoolFor: (manifest) => {
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
      },
      calendarPoolFor: (manifest) => {
        if (calendarSessionPool === undefined) {
          calendarSessionPool = createConnectorSessionPool({
            mint: createGoogleCalendarConnectorSessionMinter({
              manifest,
              resolveUrl: options.calendarSessionMinter?.resolveUrl ?? envSecretResolver,
              oauth: options.calendarSessionMinter?.oauth ?? { resolve: envSecretResolver },
              ...(options.calendarSessionMinter?.serverName === undefined ? {} : { serverName: options.calendarSessionMinter.serverName }),
            }),
          });
        }
        return calendarSessionPool;
      },
      drivePoolFor: (manifest) => {
        if (driveSessionPool === undefined) {
          driveSessionPool = createConnectorSessionPool({
            mint: createGoogleDriveConnectorSessionMinter({
              manifest,
              resolveUrl: options.driveSessionMinter?.resolveUrl ?? envSecretResolver,
              ...(options.driveSessionMinter?.oauth === undefined ? {} : { oauth: options.driveSessionMinter.oauth }),
              ...(options.driveSessionMinter?.serverName === undefined ? {} : { serverName: options.driveSessionMinter.serverName }),
            }),
          });
        }
        return driveSessionPool;
      },
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
  pools: {
    readonly gmailPoolFor: (manifest: ConnectorManifest) => ConnectorSessionPool;
    readonly calendarPoolFor: (manifest: ConnectorManifest) => ConnectorSessionPool;
    readonly drivePoolFor: (manifest: ConnectorManifest) => ConnectorSessionPool;
  },
): Promise<void> {
  assertRequest(request);
  const database = new Database(options);
  let runId: string | undefined;
  try {
    const manifests = options.manifests ?? await loadManifests(options.manifestsDir ?? defaultManifestsDir());
    const registry = await CapabilityRegistry.build({ declared: [...BUILTIN_TOOLS, ...manifests.flatMap(declaredToolsFromManifest)], persisted: database });
    const acquiredGmailConnector = await resolveGrantedGmailConnector({
      database,
      manifests,
      roleId: request.task.roleId,
      tenantId: request.task.tenantId,
      gmailPoolFor: pools.gmailPoolFor,
    });
    const acquiredCalendarConnector = await resolveGrantedGoogleCalendarConnector({
      database,
      manifests,
      roleId: request.task.roleId,
      tenantId: request.task.tenantId,
      calendarPoolFor: pools.calendarPoolFor,
    });
    const acquiredDriveConnector = await resolveGrantedGoogleDriveConnector({
      database,
      manifests,
      roleId: request.task.roleId,
      tenantId: request.task.tenantId,
      drivePoolFor: pools.drivePoolFor,
    });
    const workspaceConnector = await resolveGrantedWorkspaceConnector({
      database,
      roleId: request.task.roleId,
      tenantId: request.task.tenantId,
      connectionString: options.connectionString,
    });
    const connector = combineConnectorContexts(
      acquiredGmailConnector?.connector,
      workspaceConnector,
      acquiredCalendarConnector?.connector,
      acquiredDriveConnector?.connector,
    );
    const mountedToolNames = ["Bash", "Read", ...(connector?.allowedTools ?? [])];
    const policy = new PolicyRegistry({
      mountedToolNames,
      policies: mountedToolNames.map((toolName) => ({ toolName })),
      manifestToolNames: [...registry.enabledToolNames],
    });
    let run;
    if (request.resume === undefined) {
      run = await startTaskRun(options, { taskId: request.task.taskId, provider: "claude", tenantId: request.task.tenantId });
      runId = run.runId;
    } else {
      runId = request.resume.runId;
      if (request.resume.sessionRef.trim().length === 0) {
        throw new Error(`Cannot resume chat run ${runId}: persisted session_ref is empty.`);
      }
      run = await resumeInterruptedRun(options, runId);
      if (run.sessionRef === null) {
        throw new Error(`Cannot resume chat run ${runId}: persisted session_ref is missing.`);
      }
    }
    const workspace = await createChatRunWorkspace(run.runId);
    let result;
    try {
      result = await executeTaskRun({
        prompt: request.task.goal,
        run: { runId: run.runId, roleId: request.task.roleId, tenantId: request.task.tenantId, agentRef: { provider: "claude", sessionRef: run.sessionRef ?? run.runId, isSubagent: false } },
        // L2 requires the scoped form; PolicyRegistry receives its bare name.
        allowedTools: ["Bash(*)", "Read(*)"],
        // Never inherit the worker process cwd or environment into a bot.
        // The Agent SDK forwards these values to its Bash/Read tool process.
        agentSdkOptions: {
          cwd: workspace,
          env: {},
          systemPrompt: buildRoleSystemPrompt(await getRole(options, request.task.roleId), request.task.roleId),
          ...(request.resume === undefined ? {} : { resume: run.sessionRef }),
        },
        ...(options.queryFn === undefined ? {} : { queryFn: options.queryFn }),
        ...(connector === undefined ? {} : { connector }),
        brokerDependencies: createBrokerDependencies(options, database, registry, policy),
        auditSink: completionAuditSink(options, run),
        park: createRunParkPort(options, run.runId),
      });
    } finally {
      for (const acquiredConnector of [acquiredGmailConnector, acquiredCalendarConnector, acquiredDriveConnector]) {
        if (acquiredConnector !== undefined) acquiredConnector.pool.release(acquiredConnector.handle);
      }
      await removeChatRunWorkspace(workspace);
    }
    await insertMessage(options, { threadId: request.threadId, role: "bot", body: finalText(result.events), runId: run.runId });
    await completeTaskRun(options, run.runId);
  } catch (error) {
    if (runId !== undefined) await failTaskRun(options, runId, error instanceof Error ? error.message : "chat run failed");
    throw error;
  } finally { await database.close(); }
}

/** Build a useful identity even when an older role has no custom instructions. */
function buildRoleSystemPrompt(role: Role | null, fallbackRoleId: string): string {
  const name = role?.name ?? fallbackRoleId;
  const title = role?.title ?? name;
  const description = role?.description.trim() ?? "";
  const instructions = role?.instructions?.trim() ?? "";
  const identity = [
    `You are ${name}, serving as ${title}.`,
    description.length === 0 ? "Represent this bot identity clearly and helpfully." : `Your role description: ${description}`,
  ];
  if (instructions.length > 0) identity.push(`Your custom instructions:\n${instructions}`);
  return identity.join("\n\n");
}

/** A fresh disposable working directory prevents one chat run seeing another. */
async function createChatRunWorkspace(runId: string): Promise<string> {
  const safeRunId = runId.replace(/[^a-zA-Z0-9_-]/g, "-");
  return mkdtemp(join(tmpdir(), `oikonomos-chat-${safeRunId}-`));
}

async function removeChatRunWorkspace(workspace: string): Promise<void> {
  await rm(workspace, { recursive: true, force: true, maxRetries: 3 });
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
export function combineConnectorContexts(
  ...contexts: readonly (ConnectorContext | undefined)[]
): ConnectorContext | undefined {
  const definedContexts = contexts.filter((context): context is ConnectorContext => context !== undefined);
  const [first] = definedContexts;
  if (first === undefined) return undefined;
  return {
    manifest: first.manifest,
    connectorIds: Object.freeze([...new Set(definedContexts.flatMap((context) => context.connectorIds ?? [context.manifest.connector_id]))]),
    mcpServers: Object.assign({}, ...definedContexts.map((context) => context.mcpServers)),
    allowedTools: definedContexts.flatMap((context) => context.allowedTools),
  };
}

interface AcquiredConnector {
  readonly connector: ConnectorContext;
  readonly pool: ConnectorSessionPool;
  readonly handle: Awaited<ReturnType<ConnectorSessionPool["acquire"]>>;
}

/**
 * Derive the connector surface from persisted grants, not from a model prompt
 * or a manifest default. Every manifest connector is independently filtered
 * to its persisted grants before its session is ever acquired.
 */
async function resolveGrantedGmailConnector(input: {
  readonly database: Database;
  readonly manifests: readonly ConnectorManifest[];
  readonly roleId: string;
  readonly tenantId: string;
  readonly gmailPoolFor: (manifest: ConnectorManifest) => ConnectorSessionPool;
}): Promise<AcquiredConnector | undefined> {
  return resolveGrantedManifestConnector({ ...input, connectorId: "gmail", poolFor: input.gmailPoolFor });
}

/** Mount Calendar only when at least one enabled Calendar tool is role-granted. */
async function resolveGrantedGoogleCalendarConnector(input: {
  readonly database: Database;
  readonly manifests: readonly ConnectorManifest[];
  readonly roleId: string;
  readonly tenantId: string;
  readonly calendarPoolFor: (manifest: ConnectorManifest) => ConnectorSessionPool;
}): Promise<AcquiredConnector | undefined> {
  return resolveGrantedManifestConnector({ ...input, connectorId: "google-calendar", poolFor: input.calendarPoolFor });
}

/** Mount Drive only when at least one enabled Drive tool is role-granted. */
async function resolveGrantedGoogleDriveConnector(input: {
  readonly database: Database;
  readonly manifests: readonly ConnectorManifest[];
  readonly roleId: string;
  readonly tenantId: string;
  readonly drivePoolFor: (manifest: ConnectorManifest) => ConnectorSessionPool;
}): Promise<AcquiredConnector | undefined> {
  return resolveGrantedManifestConnector({ ...input, connectorId: "google-drive", poolFor: input.drivePoolFor });
}

async function resolveGrantedManifestConnector(input: {
  readonly connectorId: string;
  readonly database: Database;
  readonly manifests: readonly ConnectorManifest[];
  readonly roleId: string;
  readonly tenantId: string;
  readonly poolFor: (manifest: ConnectorManifest) => ConnectorSessionPool;
}): Promise<AcquiredConnector | undefined> {
  const manifest = input.manifests.find((candidate) => candidate.connector_id === input.connectorId);
  if (manifest === undefined) return undefined;

  const grantedCapabilities = new Set((await input.database.listRoleGrants(input.roleId)).map((grant) => grant.capabilityId));
  const allowedTools = manifest.tools
    .filter((tool) => tool.enabled !== false && grantedCapabilities.has(tool.capability_id))
    .map((tool) => tool.tool_name);
  if (allowedTools.length === 0) return undefined;

  const pool = input.poolFor(manifest);
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
            : request.toolName === "mcp__google-calendar__list_events" ? input.calendarId
              : request.toolName === "mcp__google-drive__search_files" ? input.query
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
  if (request.resume !== undefined && (typeof request.resume.runId !== "string" || request.resume.runId.trim().length === 0 || typeof request.resume.sessionRef !== "string")) {
    throw new Error("chat run resume requires a runId and sessionRef.");
  }
}
