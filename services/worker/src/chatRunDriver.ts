import { issueApproval, verifyAndConsume } from "@oikonomos/approvals";
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
import {
  Database,
  getRoleSandbox,
  getLatestThreadSummary,
  getOrInitThreadContext,
  getRole,
  insertMessage,
  insertThreadSummary,
  listMessages,
  updateThreadContext,
  updateRoleSandboxState,
  upsertRoleSandbox,
  type DatabaseOptions,
  type Task,
} from "@oikonomos/db";
import { mintBrokerToken } from "@oikonomos/broker";
import { createSandboxClient, type SandboxClient, type SandboxEndpoint, type Sandbox } from "@oikonomos/sandbox-client";
import { recordAuditEvent, recordDecision } from "@oikonomos/audit";
import { executeTaskRun } from "./executeRun.js";
import { completeTaskRun, failTaskRun, parkTaskRun, resumeInterruptedRun, startTaskRun } from "./runLifecycle.js";
import { sandboxHookEnvironment, type AgentSdkQueryFn } from "@oikonomos/harness-factory";
import type { RunParkPort } from "@oikonomos/harness-factory/compose";
import { buildRoleSystemPrompt } from "./promptAssembly.js";
import { maybeCompact } from "./contextCompaction.js";
import { createTierZeroProvider, type CreateTierZeroProviderOptions } from "./tierZeroProvider.js";
import { createChatRunWorkspace, removeChatRunWorkspace } from "./runWorkspace.js";
import {
  combineConnectorContexts,
  resolveGmailMcpUrl,
  resolveGrantedGmailConnector,
  resolveGrantedGoogleCalendarConnector,
  resolveGrantedGoogleDriveConnector,
  resolveGrantedWorkspaceConnector,
  WORKSPACE_RENAME_SELF_TOOL,
  WORKSPACE_REQUEST_SECRET_TOOL,
  WORKSPACE_SEND_TO_ROLE_TOOL,
} from "./connectorResolution.js";
export { combineConnectorContexts } from "./connectorResolution.js";
export {
  CHAT_FANOUT_CAPABILITY_ID,
  deliverBotToBotMessage,
  type BotToBotMessageRequest,
  type BotToBotMessageResult,
} from "./groupFanout.js";

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
  /** Injectable Tier-0 configuration for live context compaction. */
  readonly tierZeroProviderOptions?: Omit<CreateTierZeroProviderOptions, "db" | "runId">;
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
  /** Injectable OpenSandbox seam; production constructs the authenticated client from SANDBOX_INTEGRATION_URL. */
  readonly sandboxClient?: SandboxClient;
}

const SANDBOX_IMAGE = "oikonomos-office-base:claude-2.1.263";
const SANDBOX_EXECD_TOKEN_REF = "secret://opensandbox/execd_access_token";
const SANDBOX_COMMAND_TIMEOUT_MS = 10 * 60_000;
const SANDBOX_READY_TIMEOUT_MS = 30_000;
const SANDBOX_MANAGED_SETTINGS_PATH = "/etc/claude-code/managed-settings.json";
// SHA-256 of infra/sandbox/images/office-base/managed-settings.json. Keep this
// paired with the image asset: stale or altered managed settings fail closed.
const SANDBOX_MANAGED_SETTINGS_SHA256 = "886c6ad71724d395fd4600dd8cc0625df68686808409d6657fab8e9737083854";

/**
 * Local mode is deliberately opt-in. An unset or misspelled value must never
 * quietly bypass the managed sandbox hook on a production worker.
 */
export function chatExecutionMode(environment: NodeJS.ProcessEnv = process.env): "local" | "sandbox" {
  return environment.OIKONOMOS_CHAT_EXECUTION_MODE === "local" ? "local" : "sandbox";
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
    const workspaceConnector = await resolveGrantedWorkspaceConnector({
      database, roleId: request.task.roleId, tenantId: request.task.tenantId,
      connectionString: options.connectionString, runId: run.runId,
    });
    const connector = combineConnectorContexts(
      acquiredGmailConnector?.connector, workspaceConnector, acquiredCalendarConnector?.connector, acquiredDriveConnector?.connector,
    );
    const mountedToolNames = ["Bash", "Read", ...(connector?.allowedTools ?? [])];
    const policy = new PolicyRegistry({ mountedToolNames, policies: mountedToolNames.map((toolName) => ({ toolName })), manifestToolNames: [...registry.enabledToolNames] });
    let result;
    try {
      const systemPrompt = buildRoleSystemPrompt(await getRole(options, request.task.roleId), request.task.roleId);
      // An injected query function is an established test-only SDK seam. Keep
      // it local so all existing TASK-116/153/154 tests remain meaningful;
      // real production runs (no queryFn) default to the sandbox.
      if (!shouldUseSandbox(options)) {
        const workspace = await createChatRunWorkspace(run.runId);
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
              systemPrompt,
              ...(request.resume === undefined ? {} : { resume: run.sessionRef }),
            },
            ...(options.queryFn === undefined ? {} : { queryFn: options.queryFn }),
            ...(connector === undefined ? {} : { connector }),
            brokerDependencies: createBrokerDependencies(options, database, registry, policy),
            auditSink: completionAuditSink(options, run),
            park: createRunParkPort(options, run.runId),
          });
        } finally {
          await removeChatRunWorkspace(workspace);
        }
      } else {
        result = await executeSandboxChatRun(options, request, run, systemPrompt);
      }
    } finally {
      for (const acquiredConnector of [acquiredGmailConnector, acquiredCalendarConnector, acquiredDriveConnector]) {
        if (acquiredConnector !== undefined) acquiredConnector.pool.release(acquiredConnector.handle);
      }
    }
    await insertMessage(options, { threadId: request.threadId, role: "bot", body: finalText(result.events), runId: run.runId });
    await compactCompletedChatRun(options, request, run.runId);
    await completeTaskRun(options, run.runId);
  } catch (error) {
    if (runId !== undefined) await failTaskRun(options, runId, error instanceof Error ? error.message : "chat run failed");
    throw error;
  } finally { await database.close(); }
}

function shouldUseSandbox(options: CreateChatRunDriverOptions): boolean {
  if (options.sandboxClient !== undefined) return true;
  if (options.queryFn !== undefined || chatExecutionMode() === "local") return false;
  // The real database integration suite predates sandbox provisioning and
  // proves TASK-116/153/154 unchanged. A caller that wants a fake sandbox in
  // tests supplies sandboxClient explicitly; production is never NODE_ENV=test.
  return process.env.NODE_ENV !== "test";
}

/** Execute a governed CLI turn in the persistent per-role OpenSandbox office. */
async function executeSandboxChatRun(
  options: CreateChatRunDriverOptions,
  request: ChatRunRequest,
  run: { readonly runId: string; readonly sessionRef: string | null },
  systemPrompt: string,
): Promise<{ readonly events: readonly unknown[] }> {
  const client = options.sandboxClient ?? productionSandboxClient();
  const resolvedSandbox = await resolveRoleSandbox(options, client, request.task.roleId);
  const agentRef = { provider: "claude", sessionRef: run.sessionRef ?? run.runId, isSubagent: false };
  const token = mintBrokerToken({ runId: run.runId, roleId: request.task.roleId, tenantId: request.task.tenantId, agentRef }, SANDBOX_COMMAND_TIMEOUT_MS);
  const command = claudePrintCommand(request.task.goal, systemPrompt, request.resume?.sessionRef);
  await assertManagedSettingsIntegrity(client, resolvedSandbox.endpoint);
  const workspace = `/workspace/${safePathSegment(request.task.roleId)}`;
  await ensureSandboxWorkspace(client, resolvedSandbox.endpoint, workspace);
  const response = await client.runCommand(resolvedSandbox.endpoint, {
    command,
    cwd: workspace,
    // This is the whole child environment. Never spread process.env here:
    // only the per-turn broker identity and model credential cross the
    // worker/sandbox boundary — the image itself carries neither (TASK-154).
    envs: {
      [sandboxHookEnvironment.brokerUrl]: requiredSandboxBrokerUrl(),
      [sandboxHookEnvironment.brokerToken]: token,
      [sandboxHookEnvironment.runId]: run.runId,
      [sandboxHookEnvironment.roleId]: request.task.roleId,
      [sandboxHookEnvironment.tenantId]: request.task.tenantId,
      [sandboxHookEnvironment.agentProvider]: agentRef.provider,
      [sandboxHookEnvironment.agentSessionRef]: agentRef.sessionRef,
      ANTHROPIC_API_KEY: requiredSandboxAnthropicApiKey(),
    },
    timeoutMs: SANDBOX_COMMAND_TIMEOUT_MS,
  });
  if (response.exitCode !== 0) throw new Error(`Sandboxed Claude command failed with exit code ${response.exitCode}.`);

  // A completed turn is idle. Persist Paused only after the lifecycle API has
  // accepted the transition; the next turn resumes, polls Running, then gets a
  // fresh execd endpoint rather than reusing a stale pre-pause URL.
  await client.pauseSandbox(resolvedSandbox.sandboxId);
  await updateRoleSandboxState(options, request.task.roleId, "Paused");
  return { events: [{ type: "result", result: response.stdout.trim() }] };
}

/** Managed settings are an immutable security boundary for a persistent office. */
async function assertManagedSettingsIntegrity(client: SandboxClient, endpoint: SandboxEndpoint): Promise<void> {
  const result = await client.runCommand(endpoint, {
    command: `/usr/bin/sha256sum ${SANDBOX_MANAGED_SETTINGS_PATH}`,
    // The verification command receives no worker environment either.
    envs: {},
    timeoutMs: 10_000,
  });
  const observed = result.stdout.trim().split(/\s+/, 1)[0];
  if (result.exitCode !== 0 || observed !== SANDBOX_MANAGED_SETTINGS_SHA256) {
    throw new Error("Sandbox managed Claude settings failed the required integrity check.");
  }
}

/** Create the role's durable in-sandbox workspace before execd validates cwd. */
async function ensureSandboxWorkspace(client: SandboxClient, endpoint: SandboxEndpoint, workspace: string): Promise<void> {
  const result = await client.runCommand(endpoint, {
    command: `mkdir -p -- ${shellQuote(workspace)}`,
    cwd: "/workspace",
    // Workspace setup intentionally receives no worker environment or secrets.
    envs: {},
    timeoutMs: 10_000,
  });
  if (result.exitCode !== 0) throw new Error("Sandbox role workspace could not be prepared.");
}

function productionSandboxClient(): SandboxClient {
  const baseUrl = process.env.SANDBOX_INTEGRATION_URL?.trim();
  if (baseUrl === undefined || baseUrl.length === 0) {
    throw new Error("SANDBOX_INTEGRATION_URL must be set for sandbox chat execution (set OIKONOMOS_CHAT_EXECUTION_MODE=local only for development).");
  }
  return createSandboxClient({ baseUrl });
}

async function resolveRoleSandbox(options: DatabaseOptions, client: SandboxClient, roleId: string): Promise<{ readonly sandboxId: string; readonly endpoint: SandboxEndpoint }> {
  let record = await getRoleSandbox(options, roleId);
  if (record === null) {
    const created = await client.createSandbox({
      image: { uri: process.env.OIKONOMOS_SANDBOX_IMAGE?.trim() || SANDBOX_IMAGE },
      entrypoint: ["tail", "-f", "/dev/null"],
      resourceLimits: { cpu: "500m", memory: "512Mi" },
      metadata: { roleId },
    });
    record = await upsertRoleSandbox(options, { roleId, sandboxId: created.id, state: created.status.state, execdTokenRef: SANDBOX_EXECD_TOKEN_REF });
  }
  if (record.state === "Paused") {
    await client.resumeSandbox(record.sandboxId);
    await updateRoleSandboxState(options, roleId, "Resuming");
  }
  const running = await waitForSandboxRunning(client, record.sandboxId);
  await updateRoleSandboxState(options, roleId, running.status.state);
  return { sandboxId: record.sandboxId, endpoint: await client.getEndpoint(record.sandboxId) };
}

async function waitForSandboxRunning(client: SandboxClient, sandboxId: string): Promise<Sandbox> {
  const deadline = Date.now() + SANDBOX_READY_TIMEOUT_MS;
  do {
    const sandbox = await client.getSandbox(sandboxId);
    if (sandbox.status.state === "Running") return sandbox;
    if (sandbox.status.state === "Failed" || sandbox.status.state === "Terminated") {
      throw new Error(`Sandbox ${sandboxId} entered ${sandbox.status.state} while preparing a chat turn.`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
  } while (Date.now() < deadline);
  throw new Error(`Sandbox ${sandboxId} did not reach Running before the readiness timeout.`);
}

function requiredSandboxBrokerUrl(): string {
  const value = process.env.OIK_SANDBOX_BROKER_URL?.trim();
  if (value === undefined || value.length === 0) throw new Error("OIK_SANDBOX_BROKER_URL must be set for sandbox chat execution.");
  return value;
}

/**
 * The sandboxed `claude -p` CLI has no credential of its own by design
 * (TASK-154) and, per its own `--help`, authenticates non-interactively
 * ONLY via `ANTHROPIC_API_KEY` (OAuth/keychain/subscription logins are never
 * read headlessly, and — per Anthropic's Consumer Terms §3 — a subscription
 * credential must never authenticate automated/non-human access in the
 * first place). Read from `OIK_SECRET_*` to match this codebase's secret
 * env-var convention; never spread `process.env` here.
 */
function requiredSandboxAnthropicApiKey(): string {
  const value = process.env.OIK_SECRET_ANTHROPIC_API_KEY?.trim();
  if (value === undefined || value.length === 0) throw new Error("OIK_SECRET_ANTHROPIC_API_KEY must be set for sandbox chat execution.");
  return value;
}

function safePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "-");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\\"'\\\"'")}'`;
}

/**
 * Cheapest available model by default — the R350/month platform ceiling
 * (DEFAULT_PLATFORM_CEILING_ZAR) leaves very little headroom for sandboxed
 * turns. Override via OIKONOMOS_SANDBOX_MODEL for a specific role/routine
 * that genuinely needs a stronger model; never assume Sonnet/Opus pricing
 * fits this budget by default.
 */
const DEFAULT_SANDBOX_MODEL = "claude-haiku-4-5-20251001";

export function claudePrintCommand(prompt: string, systemPrompt: string, resume?: string): string {
  const model = process.env.OIKONOMOS_SANDBOX_MODEL?.trim() || DEFAULT_SANDBOX_MODEL;
  return [
    "claude", "-p", "--permission-mode", "dontAsk", "--output-format", "text", "--model", shellQuote(model),
    "--allowedTools", shellQuote("Bash Read"), "--system-prompt", shellQuote(systemPrompt),
    ...(resume === undefined ? [] : ["--resume", shellQuote(resume)]), shellQuote(prompt),
  ].join(" ");
}

/** Runs TASK-179's real Postgres compaction ports after every completed chat response. */
async function compactCompletedChatRun(
  options: CreateChatRunDriverOptions,
  request: ChatRunRequest,
  runId: string,
): Promise<void> {
  const role = await getRole(options, request.task.roleId);
  let tierZero: ReturnType<typeof createTierZeroProvider> | undefined;
  await maybeCompact({
    threadId: request.threadId,
    systemPrompt: buildRoleSystemPrompt(role, request.task.roleId),
    // Construct only when the measured meter actually crosses its threshold;
    // ordinary short chat turns must not require Tier-0 environment config.
    summarize: async (prompt) => {
      tierZero ??= createTierZeroProvider({ db: options, runId, ...resolveTierZeroProviderOptions(options) });
      return tierZero(prompt);
    },
    ports: {
      loadState: async (threadId) => getOrInitThreadContext(options, threadId),
      loadLatestSummary: async (threadId, epoch) => getLatestThreadSummary(options, threadId, epoch),
      loadMessagesSince: async (threadId, _epoch, afterMessageId) => {
        const messages = await listMessages(options, threadId, afterMessageId === null ? {} : { after: afterMessageId });
        return messages.map(({ id, role, body }) => ({ id, role, body }));
      },
      saveSummary: (input) => insertThreadSummary(options, input),
      updateState: async (threadId, patch) => { await updateThreadContext(options, threadId, patch); },
      insertSystemMessage: async (threadId, body) => { await insertMessage(options, { threadId, role: "system", body }); },
    },
  });
}

function resolveTierZeroProviderOptions(
  options: CreateChatRunDriverOptions,
): Omit<CreateTierZeroProviderOptions, "db" | "runId"> {
  if (options.tierZeroProviderOptions !== undefined) return options.tierZeroProviderOptions;
  const endpoint = process.env.FREE_LLM_API_ENDPOINT?.trim();
  const model = process.env.FREE_LLM_API_MODEL?.trim();
  if (endpoint === undefined || endpoint.length === 0) throw new Error("FREE_LLM_API_ENDPOINT must be set for context compaction.");
  if (model === undefined || model.length === 0) throw new Error("FREE_LLM_API_MODEL must be set for context compaction.");
  const apiKey = process.env.FREE_LLM_API_KEY?.trim();
  return { endpoint, model, ...(apiKey === undefined || apiKey.length === 0 ? {} : { apiKey }) };
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
            : request.toolName === WORKSPACE_SEND_TO_ROLE_TOOL ? input.toRoleId
              : request.toolName === WORKSPACE_RENAME_SELF_TOOL ? input.name
                : request.toolName === WORKSPACE_REQUEST_SECRET_TOOL ? input.label : undefined;
  if (typeof destination !== "string" || destination.trim().length === 0) throw new Error(`No governed destination for tool '${request.toolName}'.`);
  return destination;
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
  if (request.resume !== undefined && (typeof request.resume.runId !== "string" || request.resume.runId.trim().length === 0 || typeof request.resume.sessionRef !== "string")) {
    throw new Error("chat run resume requires a runId and sessionRef.");
  }
}
