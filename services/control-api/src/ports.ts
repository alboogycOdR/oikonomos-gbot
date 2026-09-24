/**
 * TASK-056 / OIK-084 — the only two modules this service is allowed to
 * import for persistence. Every route handler goes through the
 * `ControlApiDeps` port below; no route, and no other file in this
 * package, may import `pg`, hold a `Pool`, or embed a SQL string
 * (OIK-084 "not the DB" / N9 spirit). `test/no-raw-sql.test.ts` is the
 * liveness check that keeps this true.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Database,
  checkDatabaseReadiness,
  createTask as dbCreateTask,
  createTaskExecutionRun as dbCreateTaskExecutionRun,
  createRoutine as dbCreateRoutine,
  createRole as dbCreateRole,
  createBotTemplate as dbCreateBotTemplate,
  createRoleTemplateInstall as dbCreateRoleTemplateInstall,
  createGroupThread as dbCreateGroupThread,
  getOrCreateThreadForRole as dbGetOrCreateThreadForRole,
  getTask as dbGetTask,
  getRole as dbGetRole,
  getBotTemplate as dbGetBotTemplate,
  getLatestBotTemplate as dbGetLatestBotTemplate,
  getRoleTemplateInstall as dbGetRoleTemplateInstall,
  insertMessage as dbInsertMessage,
  insertAuditEvent as dbInsertAuditEvent,
  assignProjectTaskOwner as dbAssignProjectTaskOwner,
  createProjectArtifact as dbCreateProjectArtifact,
  createProjectTask as dbCreateProjectTask,
  createProjectWithRoster as dbCreateProjectWithRoster,
  getProject as dbGetProject,
  getProjectOverview as dbGetProjectOverview,
  getProjectTask as dbGetProjectTask,
  listProjectArtifacts as dbListProjectArtifacts,
  listProjectDecisions as dbListProjectDecisions,
  listProjectRoleMembers as dbListProjectRoleMembers,
  listProjects as dbListProjects,
  listProjectTasks as dbListProjectTasks,
  mirrorApprovalDecisionToProjects as dbMirrorApprovalDecisionToProjects,
  updateProjectTaskState as dbUpdateProjectTaskState,
  updateProjectWithRoster as dbUpdateProjectWithRoster,
  type NewProjectArtifact,
  type NewProjectTask,
  type NewProjectWithRoster,
  type Project,
  type ProjectArtifact,
  type ProjectArtifactListFilter,
  type ProjectDecision,
  type ProjectDecisionListFilter,
  type ProjectListFilter,
  type ProjectOverview,
  type ProjectRoleMember,
  type ProjectTask,
  type ProjectTaskListFilter,
  type ProjectTaskState,
  type ProjectUpdate,
  type ProjectWithRoster,
  getAuditEventsForRun as dbGetAuditEventsForRun,
  getRunReceipt as dbGetRunReceipt,
  getRun as dbGetRun,
  getPendingSecretRequest as dbGetPendingSecretRequest,
  listPendingApprovals as dbListPendingApprovals,
  listPendingSecretRequests as dbListPendingSecretRequests,
  listMessages as dbListMessages,
  listWorkspaceSummary as dbListWorkspaceSummary,
  listRoles as dbListRoles,
  listBotTemplates as dbListBotTemplates,
  listRoleMessages as dbListRoleMessages,
  updateRoleInstructions as dbUpdateRoleInstructions,
  listRoutines as dbListRoutines,
  listRuns as dbListRuns,
  queryRunLatencyStats as dbQueryRunLatencyStats,
  listTasks as dbListTasks,
  listThreads as dbListThreads,
  listAllThreadsWithMembers as dbListAllThreadsWithMembers,
  markThreadRead as dbMarkThreadRead,
  pinThread as dbPinThread,
  unpinThread as dbUnpinThread,
  listDeviceTokens as dbListDeviceTokens,
  registerDeviceToken as dbRegisterDeviceToken,
  createSkill as dbCreateSkill,
  getSkill as dbGetSkill,
  updateSkill as dbUpdateSkill,
  listSkills as dbListSkills,
  setEnabledForRole as dbSetEnabledForRole,
  listEnabledForRole as dbListEnabledForRole,
  getOrInitThreadContext as dbGetOrInitThreadContext,
  startFreshEpoch as dbStartFreshEpoch,
  getRoleSandbox as dbGetRoleSandbox,
  getRoutine as dbGetRoutine,
  setRoutinePaused as dbSetRoutinePaused,
  updateRoutineSkill as dbUpdateRoutineSkill,
  fulfillPendingSecretRequest as dbFulfillPendingSecretRequest,
  declineSecretRequest as dbDeclineSecretRequest,
  resumeRun as dbResumeRun,
  getLatestRunForThread as dbGetLatestRunForThread,
  getThreadEpoch as dbGetThreadEpoch,
  SECRET_VAULT_WRITE_EVENT,
  RoutineLimitError,
  type AuditEvent,
  type BotTemplate,
  type Capability,
  type DatabaseReadiness,
  type DatabaseOptions,
  type NewTask,
  type TaskExecution,
  type NewRoutine,
  type NewRole,
  type NewBotTemplate,
  type NewRoleTemplateInstall,
  type RoleTemplateInstall,
  type NewThread,
  type NewGroupThread,
  type NewMessage,
  type PendingApprovalFilter,
  type Approval,
  type PhaseLatencyStats,
  type Run,
  type RunListFilter,
  type RunListPage,
  type RunReceipt,
  type Task,
  type TaskListFilter,
  type TaskListPage,
  type Role,
  type RoleMessage,
  type RoleGrant,
  type Routine,
  type Thread,
  type GroupThread,
  type Message,
  type MessageListOptions,
  type DeviceToken,
  type RegisterDeviceTokenInput,
  type NewSkill,
  type Skill,
  type SkillListFilter,
  type UpdateSkill,
  type WorkspaceSummary,
  type SecretVault,
  resolveRoleRuntime,
} from "@oikonomos/db";
import {
  decideApproval as approvalsDecideApproval,
  editApproval as approvalsEditApproval,
  type ApprovalDecision,
  type DecideApprovalResult,
  type EditApprovalResult,
  type IssueApprovalRequest,
} from "@oikonomos/approvals";
import {
  completeTaskRun,
  createTierZeroProvider,
  createRunGate,
  enqueueRunExecution,
  deliverBotToBotMessage,
  failTaskRun,
  parkTaskRun,
  route,
  startTaskRun,
  type ChatRunDriver,
  type CreateTierZeroProviderOptions,
  type CreateChatRunDriverOptions,
  type GroupRoute,
  type QueuedRun,
  type RunGate,
} from "@oikonomos/worker";
import {
  createSandboxClient,
  envSecretResolver,
  OPENSANDBOX_EXECD_ACCESS_TOKEN_REF,
  type FetchLike,
  type SandboxClient,
  type SecretResolver,
} from "@oikonomos/sandbox-client";
import {
  readProfileTier as memoryReadProfileTier,
  writeMemoryFact as memoryWriteMemoryFact,
  type MemoryFact,
  type NewMemoryFact,
} from "@oikonomos/memory";
import type { SecretRequestsPort, ThreadContextPort } from "./app.js";
import type { LiveAgentExecdEndpoint, LiveAgentPort } from "./liveAgent.routes.js";
import { createPushTransportFromEnv, type PushNotification, type PushTransportPort } from "./pushTransport.js";

/** execd's documented PTY/command port, reached only via the lifecycle proxy. */
const EXECD_PTY_PORT = 44_772;
const EXECD_ACCESS_TOKEN_HEADER = "X-EXECD-ACCESS-TOKEN";

/**
 * The port every route handler is written against. Route-level tests
 * inject a fake implementing this interface — no network, no DB. The
 * real implementation (`createDatabaseBackedDeps`) binds each function to
 * a live `DatabaseOptions`/`@oikonomos/approvals` dependency object and is
 * used only by `index.ts`'s `start()` and by the DATABASE_URL-gated
 * integration tests.
 */
export type GroupRoutingDecision =
  | { route: GroupRoute; routingRunId: string | null }
  | { route: null; routingRunId: null; stopReason: "consecutive_bot_cap" | "quiet_room" };

export const GROUP_ROUTING_FALLBACK_REASONS = [
  "unreachable",
  "unparsed",
  "off_roster",
  "unconfident",
  "single_candidate",
] as const;

export type GroupRoutingFallbackReason = (typeof GROUP_ROUTING_FALLBACK_REASONS)[number];
export const GROUP_ROUTING_FALLBACK_EVENT_TYPE = "group_routing.fallback";

export class UnparsedGroupRoutingScoreError extends Error {}

interface RouteGroupMessageWithFallbackOptions {
  readonly message: string;
  readonly members: readonly GroupRoute["recipients"][number][];
  readonly mostRecentResponderRoleId: string | null;
  readonly grantsByRoleId: ReadonlyMap<string, readonly RoleGrant[]>;
  readonly scorer: (candidate: { member: GroupRoute["recipients"][number]; message: string }) => Promise<number>;
  readonly recordFallback: (reason: GroupRoutingFallbackReason) => Promise<void>;
  /** The initial deterministic pass deliberately throws to request Tier-0. */
  readonly fallbackOnScorerFailure?: boolean;
}

/**
 * Resolves deterministic group-routing shortcuts and makes every fallback to
 * the roster default observable.  This lives in the control-api composition
 * layer because grants and audit persistence are both infrastructure facts,
 * not worker routing-policy concerns.
 */
export async function routeGroupMessageWithFallback(
  options: RouteGroupMessageWithFallbackOptions,
): Promise<GroupRoute> {
  const message = options.message.trim();
  if (message.length === 0) throw new Error("group routing requires a non-empty message.");
  if (options.members.length === 0) throw new Error("group routing requires at least one member.");

  const defaultRoute = async (reason: GroupRoutingFallbackReason): Promise<GroupRoute> => {
    await options.recordFallback(reason);
    return { recipients: [options.members[0]!], reason: "scored" };
  };

  if (options.members.length === 1) return defaultRoute("single_candidate");

  const systemHolder = onlySystemHolder(message, options.members, options.grantsByRoleId);
  if (systemHolder !== null) return { recipients: [systemHolder], reason: "mentioned" };

  if (hasOffRosterMention(message, options.members)) return defaultRoute("off_roster");

  const scores: number[] = [];
  try {
    const resolved = await route({
      message,
      members: options.members,
      mostRecentResponderRoleId: options.mostRecentResponderRoleId,
      scorer: async (candidate) => {
        const score = await options.scorer(candidate);
        scores.push(score);
        return score;
      },
    });
    // A field of zero confidence contains no positive routing signal. The
    // worker would choose the first tied member; retain that choice and make
    // its fallback nature durable instead of silently claiming a score.
    if (scores.length > 0 && scores.every((score) => score === 0)) {
      return defaultRoute("unconfident");
    }
    return resolved;
  } catch (error) {
    if (options.fallbackOnScorerFailure === false) throw error;
    return defaultRoute(error instanceof UnparsedGroupRoutingScoreError ? "unparsed" : "unreachable");
  }
}

/**
 * TASK-304 (P-5) — the project workspace port (spec §9.1). Optional on
 * `ControlApiDeps` (like the template ports) so the many route-test
 * fixtures that predate it stay valid; the routes answer 501 without it.
 */
export interface ProjectPorts {
  createProject(input: NewProjectWithRoster): Promise<ProjectWithRoster>;
  getProject(projectId: string): Promise<Project | null>;
  listProjects(filter: ProjectListFilter): Promise<Project[]>;
  updateProject(input: ProjectUpdate): Promise<ProjectWithRoster | null>;
  getOverview(input: { tenantId: string; projectId: string }): Promise<ProjectOverview>;
  listRoster(projectId: string): Promise<ProjectRoleMember[]>;
  listTasks(filter: ProjectTaskListFilter): Promise<ProjectTask[]>;
  createTask(input: NewProjectTask): Promise<ProjectTask>;
  getTask(taskId: string): Promise<ProjectTask | null>;
  updateTaskState(taskId: string, state: ProjectTaskState, blockedReason?: string): Promise<ProjectTask | null>;
  assignTaskOwner(taskId: string, ownerRoleId: string): Promise<ProjectTask | null>;
  listArtifacts(filter: ProjectArtifactListFilter): Promise<ProjectArtifact[]>;
  createArtifact(input: NewProjectArtifact): Promise<ProjectArtifact>;
  listDecisions(filter: ProjectDecisionListFilter): Promise<ProjectDecision[]>;
}

export interface ControlApiDeps {
  /** TASK-326: category-only readiness for the public supervisor probe. */
  checkDatabaseReadiness?(): Promise<DatabaseReadiness>;
  /** TASK-304: project workspace routes; `501` when absent. */
  projects?: ProjectPorts;
  createTask(input: NewTask): Promise<Task>;
  /**
   * Persist a reference-only worker command and its initial run together,
   * then durably enqueue that run.  New chat submission must use this port;
   * retaining separate task/run writes would let a worker observe a run with
   * no command to execute after an API-process failure.
   */
  submitTaskExecution?(input: { task: NewTask; execution: TaskExecution }): Promise<{ task: Task; runId: string }>;
  createRoutine(input: NewRoutine): Promise<Routine>;
  createRole(input: NewRole): Promise<Role>;
  /** Template persistence is optional only for legacy route fixtures. Production always provides it. */
  createBotTemplate?(input: NewBotTemplate): Promise<BotTemplate>;
  getLatestBotTemplate?(templateId: string): Promise<BotTemplate | null>;
  getBotTemplate?(templateId: string, version: number): Promise<BotTemplate | null>;
  listBotTemplates?(filter: { tenantId: string }): Promise<BotTemplate[]>;
  createRoleTemplateInstall?(input: NewRoleTemplateInstall): Promise<void>;
  /** TASK-289 / spec §6.1 — the install-provenance row a role was created from, or null if it wasn't installed from a template. */
  getRoleTemplateInstall?(roleId: string): Promise<RoleTemplateInstall | null>;
  insertAuditEvent?(input: {
    tenantId: string;
    actor: string;
    eventType: string;
    payload: Record<string, unknown>;
  }): Promise<void>;
  listCapabilities(): Promise<Capability[]>;
  upsertRoleGrant(input: RoleGrant): Promise<RoleGrant>;
  listRoleGrants(roleId: string): Promise<RoleGrant[]>;
  revokeRoleGrant(roleId: string, capabilityId: string): Promise<void>;
  listRoles(filter: { tenantId: string; status?: "active" | "hidden" | "deleted" }): Promise<Role[]>;
  updateRoleInstructions(roleId: string, instructions: string): Promise<Role | null>;
  listRoleMessages(filter: { tenantId: string; toRoleId?: string; fromRoleId?: string }): Promise<RoleMessage[]>;
  listRoutines(filter: { tenantId: string; roleId?: string }): Promise<Routine[]>;
  setRoutinePaused?(routineId: string, tenantId: string, paused: boolean): Promise<Routine | null>;
  updateRoutineSkill?(routineId: string, tenantId: string, skillId: string | null): Promise<Routine | null>;
  testRunRoutine?(routineId: string, tenantId: string): Promise<Routine | null>;
  getOrCreateThreadForRole(input: NewThread): Promise<Thread>;
  listThreads(): Promise<Thread[]>;
  createGroupThread(input: NewGroupThread): Promise<GroupThread>;
  listAllThreadsWithMembers(viewerTenantId?: string): Promise<Array<Thread | GroupThread>>;
  markThreadRead?(input: { threadId: string; tenantId: string; readAt?: Date }): Promise<Date>;
  pinThread?(input: { threadId: string; tenantId: string }): Promise<Date>;
  unpinThread?(input: { threadId: string; tenantId: string }): Promise<void>;
  listWorkspaceSummary?(tenantId: string): Promise<WorkspaceSummary[]>;
  insertMessage(input: NewMessage): Promise<Message>;
  listMessages(threadId: string, options?: MessageListOptions): Promise<Message[]>;
  listTasks(filter?: TaskListFilter): Promise<TaskListPage>;
  getTask(taskId: string): Promise<Task | null>;
  listRuns(filter?: RunListFilter): Promise<RunListPage>;
  getRun(runId: string): Promise<Run | null>;
  /** Optional for legacy route-test fixtures; production always wires this. */
  getRunReceipt?(runId: string, tenantId: string): Promise<RunReceipt | null>;
  /**
   * TASK-230 — per-phase latency stats (p50/p95/max) over the most recent
   * runs. Optional (like `listEnabledSkillsForRole` below) so the many
   * test-fixture `ControlApiDeps` objects that predate this route don't
   * all need updating; the route itself 501s when it's absent.
   */
  getRunLatencyStats?(limit?: number): Promise<PhaseLatencyStats[]>;
  listPendingApprovals(filter?: PendingApprovalFilter): Promise<Approval[]>;
  decideApproval(
    nonce: string,
    decision: ApprovalDecision,
    decidedBy: string,
  ): Promise<DecideApprovalResult>;
  /**
   * TASK-063 / OIK-086: atomically invalidate the named PENDING approval
   * and issue a replacement bound to `editedRequest` (ADR-004 render
   * provenance; N8 single nonce). `editedRequest.tenantId` MUST be
   * forwarded by every caller — an omitted tenantId defaults to
   * `basileia` inside `@oikonomos/approvals` and is a HARD REFUSAL for
   * any other tenant's approval (fail-closed by design).
   */
  editApproval(nonce: string, editedRequest: IssueApprovalRequest): Promise<EditApprovalResult>;
  getAuditEventsForRun(runId: string): Promise<AuditEvent[]>;
  registerDeviceToken(input: RegisterDeviceTokenInput): Promise<DeviceToken>;
  runChatTask(input: { task: Task; threadId: string; resume?: { runId: string; sessionRef: string } }): Promise<void>;
  requestGroupFanout(input: { task: Task; memberRoleIds: readonly string[]; body: string }): Promise<{ runId: string }>;
  /**
   * TASK-189: resolves group recipients against live membership and thread
   * history. Optional only to preserve older injected fixtures; production
   * always provides this through createDatabaseBackedDeps.
   */
  routeGroupMessage?(input: {
    tenantId: string;
    threadId: string;
    memberRoleIds: readonly string[];
    body: string;
    title: string;
    goal: string;
  }): Promise<GroupRoutingDecision>;
  /**
   * TASK-177 (G-01b) — Skills CRUD, tenant-scoped like every other list
   * route. Declared optional (unlike every other port method here) purely
   * so pre-existing `ControlApiDeps` literals elsewhere in this package
   * that predate this task (chat.routes.test.ts, sse.test.ts — both
   * outside this task's Owned_Paths) keep type-checking without an
   * out-of-territory edit to add six unrelated fields; every real and
   * skills-focused test fixture provides all six. Route handlers guard
   * with a 501 when a dep omits them (see app.ts).
   */
  createSkill?(input: NewSkill): Promise<Skill>;
  getSkill?(skillId: string): Promise<Skill | null>;
  updateSkill?(skillId: string, input: UpdateSkill): Promise<Skill | null>;
  listSkills?(filter: SkillListFilter): Promise<Skill[]>;
  /** The per-Bot enable list (`role_skills`). */
  setSkillEnabledForRole?(roleId: string, skillId: string, enabled: boolean): Promise<void>;
  listEnabledSkillsForRole?(roleId: string): Promise<Skill[]>;
  /** Template memory is deliberately explicit at the route boundary. */
  readProfileTier?(context: { tenantId: string; roleId: string }): Promise<MemoryFact[]>;
  writeMemoryFact?(input: NewMemoryFact): Promise<MemoryFact>;
}

export interface CreateDatabaseBackedDepsOptions extends DatabaseOptions {
  /** Tests inject a collecting transport; production resolves the env-gated FCM transport. */
  pushTransport?: PushTransportPort;
  /** Test-only seams for real database-backed chat lifecycle tests. */
  chatRunDriverOptions?: Omit<CreateChatRunDriverOptions, keyof DatabaseOptions>;
  /** Test seam proving the production composition observes gate evidence. */
  onRunQueued?: (queued: QueuedRun) => void;
  /** Injectable Tier-0 configuration; production resolves the same values from env. */
  tierZeroProviderOptions?: Omit<CreateTierZeroProviderOptions, "db" | "runId">;
}

export const RUN_QUEUED_EVENT_TYPE = "run.queued";

interface QueuedRunAudit {
  readonly runId: string | null;
  readonly taskId: string;
  readonly tenantId: string;
  readonly roleId: string;
  readonly position: number;
  readonly reason: "concurrency.cap" | "submission" | "consumer_gate";
}

/** The production chat wrapper: liveness tests observe its emitted queue evidence. */
export function createGatedChatRunTask(
  chatRunDriver: ChatRunDriver,
  dependencies: {
    readonly recordQueuedRun: (event: QueuedRunAudit) => Promise<void>;
  },
  gate: RunGate = createRunGate({ maxConcurrent: 2 }),
): ControlApiDeps["runChatTask"] {
  return async (request) => gate.run(
    request.task.roleId,
    () => chatRunDriver.run(request),
    async (queued) => dependencies.recordQueuedRun({
      runId: null,
      taskId: request.task.taskId,
      tenantId: request.task.tenantId,
      ...queued,
    }),
  );
}

/** Keep the group delivery port on the exact gate used by ordinary chat runs. */
export function runGatedGroupFanout<T>(
  gate: RunGate,
  roleId: string,
  fn: (execution: { readonly queued: QueuedRun | null }) => Promise<T> | T,
  onQueued?: (queued: QueuedRun) => void | Promise<void>,
): Promise<T> {
  return gate.run(roleId, fn, onQueued);
}

/**
 * The production implementation for TASK-179's HTTP context routes.
 * Kept separate from ControlApiDeps because the routes intentionally receive
 * the narrow ThreadContextPort rather than widening the general route port.
 */
export function createDatabaseBackedThreadContext(options: DatabaseOptions): ThreadContextPort {
  return {
    async getContext(threadId) {
      const context = await dbGetOrInitThreadContext(options, threadId);
      return {
        contextTokens: context.contextTokens,
        contextLimit: context.contextLimit,
        epoch: context.epoch,
      };
    },
    async startFresh(threadId) {
      const context = await dbStartFreshEpoch(options, threadId);
      return {
        contextTokens: context.contextTokens,
        contextLimit: context.contextLimit,
        epoch: context.epoch,
      };
    },
  };
}

export interface CreateDatabaseBackedLiveAgentOptions extends DatabaseOptions {
  /**
   * Test seam. Production constructs an authenticated client from
   * SANDBOX_INTEGRATION_URL on first PTY-endpoint resolution.
   */
  sandboxClient?: Pick<SandboxClient, "getEndpoint">;
  /** Test seam for the lifecycle base URL; production reads SANDBOX_INTEGRATION_URL. */
  sandboxBaseUrl?: string;
  fetchImpl?: FetchLike;
  resolveApiKey?: SecretResolver;
  resolveExecdAccessToken?: SecretResolver;
}

/**
 * Production LiveAgentPort: a role's current sandbox from `role_sandboxes`,
 * then execd's PTY-viewer URL via sandbox-client `getEndpoint` with
 * `use_server_proxy=true` (TASK-169). Direct sandbox-published ports are
 * refused even if a client returns one.
 */
export function createDatabaseBackedLiveAgent(options: CreateDatabaseBackedLiveAgentOptions): LiveAgentPort {
  let client: Pick<SandboxClient, "getEndpoint"> | undefined = options.sandboxClient;
  const resolveExecdAccessToken = options.resolveExecdAccessToken ?? envSecretResolver;

  function resolveClient(): Pick<SandboxClient, "getEndpoint"> {
    if (client !== undefined) return client;
    const baseUrl = (options.sandboxBaseUrl ?? process.env.SANDBOX_INTEGRATION_URL)?.trim();
    if (baseUrl === undefined || baseUrl.length === 0) {
      throw new Error("SANDBOX_INTEGRATION_URL must be set to resolve a live-agent PTY viewer endpoint.");
    }
    client = createSandboxClient({
      baseUrl,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.resolveApiKey === undefined ? {} : { resolveApiKey: options.resolveApiKey }),
      ...(options.resolveExecdAccessToken === undefined ? {} : { resolveExecdAccessToken: options.resolveExecdAccessToken }),
    });
    return client;
  }

  return {
    async getActiveSandbox(roleId, tenantId) {
      const role = await dbGetRole(options, roleId);
      if (role === null || role.tenantId !== tenantId) return null;
      const record = await dbGetRoleSandbox(options, roleId);
      if (record === null) return null;
      return { sandboxId: record.sandboxId, state: record.state };
    },
    async getPtyViewerEndpoint(sandboxId) {
      return resolvePtyEndpoint(sandboxId, "mode=viewer&since=0");
    },
    // TASK-228 — the write-capable counterpart. `takeover=1` is execd's
    // own real contract for evicting whatever connection currently holds
    // write access and becoming the new holder (confirmed against
    // upstream source, `pty_ws.go` — see PLAN.md TASK-188/228's research
    // trail). Deliberately its own query string, not `mode=viewer` with
    // a flag appended — these are two different execd modes, not one
    // mode with an option.
    async getPtyTakeoverEndpoint(sandboxId) {
      return resolvePtyEndpoint(sandboxId, "mode=holder&takeover=1");
    },
  };

  async function resolvePtyEndpoint(sandboxId: string, query: string): Promise<LiveAgentExecdEndpoint> {
    const resolved = await resolveClient().getEndpoint(sandboxId, EXECD_PTY_PORT, true);
    const httpUrl = requireLifecycleProxyUrl(resolved.endpoint);
    const wsProtocol = httpUrl.protocol === "https:" ? "wss:" : "ws:";
    const pathname = httpUrl.pathname.replace(/\/$/, "");
    const token = await resolveExecdAccessToken(OPENSANDBOX_EXECD_ACCESS_TOKEN_REF);
    return {
      url: `${wsProtocol}//${httpUrl.host}${pathname}/pty/${encodeURIComponent(sandboxId)}/ws?${query}`,
      headers: {
        ...resolved.headers,
        [EXECD_ACCESS_TOKEN_HEADER]: token,
      },
    };
  }
}

function requireLifecycleProxyUrl(endpoint: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("live-agent execd endpoint was not a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("live-agent execd endpoint must be http:// or https://");
  }
  if (!/\/proxy\/\d+\/?$/.test(parsed.pathname)) {
    throw new Error("live-agent execd endpoint must route through the lifecycle server proxy");
  }
  return parsed;
}

export interface PushNotificationDeps {
  runChatTask(input: { task: Task; threadId: string; resume?: { runId: string; sessionRef: string } }): Promise<void>;
  listRuns(filter: RunListFilter): Promise<RunListPage>;
  listPendingApprovals(): Promise<Approval[]>;
  listDeviceTokens(): Promise<DeviceToken[]>;
  pushTransport: PushTransportPort;
}

/**
 * Wait for the chat driver before observing the persisted run. The control
 * API owns this derived notification, leaving approval and worker packages
 * untouched. Transport failures are deliberately isolated from the run.
 */
export async function notifyAfterChatRun(
  input: { task: Task; threadId: string },
  dependencies: PushNotificationDeps,
): Promise<void> {
  await dependencies.runChatTask(input);
  // Per-user identity does not exist yet. Broadcast to every registered
  // device is therefore the honest shared-token model; replace this with
  // user-scoped targets when per-user auth ships.
  const [{ runs }, approvals, devices] = await Promise.all([
    dependencies.listRuns({ taskId: input.task.taskId, limit: 1 }),
    dependencies.listPendingApprovals(),
    dependencies.listDeviceTokens(),
  ]);
  const run = runs[0];
  if (run === undefined) return;
  const notification: PushNotification = {
    type: approvals.some((approval) => approval.runId === run.runId) ? "approval-pending" : "run-completed",
    runId: run.runId,
  };
  await Promise.all(devices.map(async ({ token }) => {
    try {
      await dependencies.pushTransport.send(token, notification);
    } catch {
      // Provider errors can echo a token or credential, so log no error details.
      console.error("push notification delivery failed");
    }
  }));
}

/**
 * Bind every port method to one live `DatabaseOptions`. The approval
 * decide path is handed `{ database: options }` so `packages/approvals`
 * opens its own connection via `createDatabaseStore` — this file never
 * touches a `Pool` directly, only the two packages' public functions.
 */
/**
 * `TaskExecution` (packages/db/src/tasks.ts, outside this task's
 * Owned_Paths) has no `epoch` field of its own -- rather than widen that
 * type (and its DB-side validation) for a control-api-only concern, this
 * task stamps `epoch` onto the execution JSON at the port boundary. The
 * underlying JSONB column and `createTaskExecutionRun`'s persistence are
 * already field-agnostic (`JSON.stringify(execution)`), so this is a pure
 * additive read/write contract between `submitTaskExecution` (writer) and
 * `getLatestRunForThread` (reader) -- see runs.ts's matching doc comment.
 */
type EpochStampedExecution = TaskExecution & { readonly epoch: number };

export function createDatabaseBackedDeps(options: CreateDatabaseBackedDepsOptions): ControlApiDeps {
  const pushTransport = options.pushTransport ?? createPushTransportFromEnv();
  const recordQueuedRun = async (event: QueuedRunAudit): Promise<void> => {
    await dbInsertAuditEvent(options, {
      tenantId: event.tenantId,
      runId: event.runId,
      actor: "system:run-concurrency",
      eventType: RUN_QUEUED_EVENT_TYPE,
      payload: { taskId: event.taskId, roleId: event.roleId, position: event.position, reason: event.reason },
    });
  };
  const runChatTask: ControlApiDeps["runChatTask"] = async (request) => {
    const role = await dbGetRole(options, request.task.roleId);
    if (role === null) throw new Error(`Cannot queue chat task: role ${request.task.roleId} not found.`);
    const run = request.resume === undefined
      ? await startTaskRun(options, { taskId: request.task.taskId, tenantId: request.task.tenantId, provider: resolveRoleRuntime(role).provider })
      : await dbGetRun(options, request.resume.runId);
    if (run === null) throw new Error(`Cannot queue unknown chat run ${request.resume?.runId}.`);
    await recordQueuedRun({ runId: run.runId, taskId: request.task.taskId, tenantId: request.task.tenantId, roleId: request.task.roleId, position: 0, reason: "submission" });
    await enqueueRunExecution(options.connectionString, run.runId);
  };
  const submitTaskExecution: NonNullable<ControlApiDeps["submitTaskExecution"]> = async ({ task, execution }) => {
    const role = await dbGetRole(options, task.roleId);
    if (role === null) throw new Error(`Cannot queue task execution: role ${task.roleId} not found.`);
    const provider = resolveRoleRuntime(role).provider;
    // TASK-269: an ordinary follow-up message in an existing thread must
    // continue the SAME Agent SDK session the thread's last turn used, not
    // start a fresh, memoryless one every time. Look up the thread's most
    // recent prior run BEFORE creating this turn's own run below --
    // `getLatestRunForThread` orders by `started_at DESC` with no way to
    // exclude a not-yet-existing row, so querying it after
    // `createTaskExecutionRun` would find the run THIS call just created
    // (itself always the newest) instead of the real predecessor, and
    // silently never seed continuity at all.
    //
    // Deliberately conservative about WHEN to seed:
    // - no prior run for this thread+role -> first message ever, start
    //   fresh (do nothing here).
    // - prior run's provider differs from this run's -> never hand a
    //   Claude session token to a Gemini run or vice versa (the exact
    //   danger chatRunDriver.ts's own provider-pinning comment names).
    // - prior run did not reach 'completed' -> nothing safe to resume (a
    //   still-open, failed, or cancelled run has no known-good session
    //   state to continue from).
    //
    // Deliberately fails CLOSED to "no continuity" (never lets a lookup
    // problem here block message-sending itself, which is the one thing
    // this port must never regress): a thread-context or continuity-lookup
    // error leaves both `currentEpoch` at its safe default and `priorRun`
    // `null`, so this path still creates and queues an ordinary, un-seeded
    // run exactly as it did before this task, never failing the chat turn.
    //
    // TASK-270 review rework: `/threads/:id/fresh` (TASK-179) bumps the
    // thread's `thread_context.epoch` specifically so the model stops
    // seeing anything from before that reset. Without scoping the prior-run
    // lookup to the thread's CURRENT epoch, a user who just called `/fresh`
    // would still have their old Claude session silently resumed on their
    // very next message -- defeating the fresh-reset contract entirely.
    // Reuses the same epoch concept `chatRunDriver.ts`'s Gemini-lane
    // compaction logic already relies on, rather than inventing a second
    // "start fresh" mechanism -- but reads it via `getThreadEpoch` (a plain,
    // lock-free read), NOT `getOrInitThreadContext` (an UPSERT): this
    // runs on EVERY chat turn, and paying a write lock on `thread_context`
    // just to read a number that defaults to 0 until the first `/fresh`
    // would needlessly serialize back-to-back turns on the same thread.
    // `currentEpoch` is also stamped onto THIS run's own execution JSON
    // below, so the very next turn (or the next `/fresh`) has a reliable
    // epoch to compare against in turn.
    let currentEpoch = 0;
    let priorRun: Awaited<ReturnType<typeof dbGetLatestRunForThread>> | null = null;
    try {
      currentEpoch = await dbGetThreadEpoch(options, execution.threadId);
      priorRun = await dbGetLatestRunForThread(options, {
        threadId: execution.threadId,
        roleId: task.roleId,
        epoch: currentEpoch,
      });
    } catch (error) {
      console.error("TASK-269 continuity lookup failed; continuing without session continuity for this turn:", error);
    }
    // Stamp the epoch onto this run's own execution record (an extra field
    // on the already-flexible `execution` JSONB, deliberately not added to
    // `TaskExecution`'s own type in packages/db/src/tasks.ts -- outside this
    // task's Owned_Paths) so a FUTURE turn's `getLatestRunForThread` lookup
    // can tell whether THIS run belongs to its thread's still-current epoch.
    const epochStampedExecution: EpochStampedExecution = { ...execution, epoch: currentEpoch };
    const persisted = await dbCreateTaskExecutionRun(options, {
      task,
      execution: epochStampedExecution,
      provider,
    });
    // `createTaskExecutionRun` always inserts a brand-new run with no
    // `session_ref` (correct for a genuinely first message); seed
    // continuity here, BEFORE this run is ever enqueued, by reusing
    // `dbResumeRun` -- already-tested machinery that sets both
    // `session_ref` and `status='resumed'` atomically -- to attach the
    // prior run's session. `services/worker/src/main.ts` (unchanged,
    // outside this task's territory) already forwards `run.sessionRef` as
    // `resume.sessionRef` to the driver whenever it is non-null, so seeding
    // it here is the only wiring this path needs; chatRunDriver.ts's
    // existing `--resume` plumbing (and this task's new post-run
    // session_ref capture, see that file) does the rest.
    if (priorRun !== null && priorRun.status === "completed" && priorRun.provider === provider) {
      await dbResumeRun(options, persisted.runId, priorRun.sessionRef ?? priorRun.runId);
    }
    await recordQueuedRun({
      runId: persisted.runId,
      taskId: persisted.task.taskId,
      tenantId: persisted.task.tenantId,
      roleId: persisted.task.roleId,
      position: 0,
      reason: "submission",
    });
    await enqueueRunExecution(options.connectionString, persisted.runId);
    return persisted;
  };
  const notify = (input: { task: Task; threadId: string }) => notifyAfterChatRun(input, {
    runChatTask,
    listRuns: (filter) => dbListRuns(options, filter),
    listPendingApprovals: () => dbListPendingApprovals(options),
    listDeviceTokens: () => dbListDeviceTokens(options),
    pushTransport,
  });
  return {
    checkDatabaseReadiness: () => checkDatabaseReadiness(options),
    createTask: (input) => dbCreateTask(options, input),
    submitTaskExecution,
    createRoutine: async (input) => dbCreateRoutine(options, input),
    createRole: (input) => dbCreateRole(options, input),
    createBotTemplate: (input) => dbCreateBotTemplate(options, input),
    getLatestBotTemplate: (templateId) => dbGetLatestBotTemplate(options, templateId),
    getBotTemplate: (templateId, version) => dbGetBotTemplate(options, templateId, version),
    listBotTemplates: (filter) => dbListBotTemplates(options, filter),
    createRoleTemplateInstall: async (input) => { await dbCreateRoleTemplateInstall(options, input); },
    getRoleTemplateInstall: (roleId) => dbGetRoleTemplateInstall(options, roleId),
    insertAuditEvent: async (input) => { await dbInsertAuditEvent(options, input); },
    listCapabilities: () => withDatabase(options, (database) => database.listCapabilities()),
    upsertRoleGrant: (input) => withDatabase(options, (database) => database.upsertRoleGrant(input)),
    listRoleGrants: (roleId) => withDatabase(options, (database) => database.listRoleGrants(roleId)),
    revokeRoleGrant: (roleId, capabilityId) =>
      withDatabase(options, (database) => database.revokeRoleGrant(roleId, capabilityId)),
    listRoles: (filter) => dbListRoles(options, filter),
    updateRoleInstructions: (roleId, instructions) => dbUpdateRoleInstructions(options, roleId, instructions),
    listRoleMessages: (filter) => dbListRoleMessages(options, filter),
    listRoutines: (filter) => dbListRoutines(options, filter),
    setRoutinePaused: async (routineId, tenantId, paused) => {
      const routine = await dbGetRoutine(options, routineId);
      if (routine === null || routine.tenantId !== tenantId) return null;
      return dbSetRoutinePaused(options, routineId, paused);
    },
    updateRoutineSkill: async (routineId, tenantId, skillId) => {
      const routine = await dbGetRoutine(options, routineId);
      if (routine === null || routine.tenantId !== tenantId) return null;
      return dbUpdateRoutineSkill(options, routineId, skillId);
    },
    testRunRoutine: async (routineId, tenantId) => {
      const routine = await dbGetRoutine(options, routineId);
      if (routine === null || routine.tenantId !== tenantId) return null;
      const task = await dbCreateTask(options, {
        tenantId, roleId: routine.roleId, title: routine.name,
        goal: typeof routine.definition.goal === "string" && routine.definition.goal.trim().length > 0 ? routine.definition.goal : routine.name,
        routineId, requestedBy: `routine-test:${routineId}`,
      });
      const thread = await dbGetOrCreateThreadForRole(options, { roleId: routine.roleId });
      await notify({ task, threadId: thread.id });
      return routine;
    },
    getOrCreateThreadForRole: (input) => dbGetOrCreateThreadForRole(options, input),
    listThreads: () => dbListThreads(options),
    createGroupThread: (input) => dbCreateGroupThread(options, input),
    listAllThreadsWithMembers: (viewerTenantId) => dbListAllThreadsWithMembers(options, viewerTenantId),
    markThreadRead: (input) => dbMarkThreadRead(options, input),
    pinThread: (input) => dbPinThread(options, input),
    unpinThread: (input) => dbUnpinThread(options, input),
    listWorkspaceSummary: (tenantId) => dbListWorkspaceSummary(options, tenantId),
    projects: {
      createProject: (input) => dbCreateProjectWithRoster(options, input),
      getProject: (projectId) => dbGetProject(options, projectId),
      listProjects: (filter) => dbListProjects(options, filter),
      updateProject: (input) => dbUpdateProjectWithRoster(options, input),
      getOverview: (input) => dbGetProjectOverview(options, input),
      listRoster: (projectId) => dbListProjectRoleMembers(options, projectId),
      listTasks: (filter) => dbListProjectTasks(options, filter),
      createTask: (input) => dbCreateProjectTask(options, input),
      getTask: (taskId) => dbGetProjectTask(options, taskId),
      updateTaskState: (taskId, state, blockedReason) => dbUpdateProjectTaskState(options, taskId, state, blockedReason),
      assignTaskOwner: (taskId, ownerRoleId) => dbAssignProjectTaskOwner(options, taskId, ownerRoleId),
      listArtifacts: (filter) => dbListProjectArtifacts(options, filter),
      createArtifact: (input) => dbCreateProjectArtifact(options, input),
      listDecisions: (filter) => dbListProjectDecisions(options, filter),
    },
    insertMessage: (input) => dbInsertMessage(options, input),
    listMessages: (threadId, listOptions) => dbListMessages(options, threadId, listOptions),
    listTasks: (filter) => dbListTasks(options, filter),
    getTask: (taskId) => dbGetTask(options, taskId),
    listRuns: (filter) => dbListRuns(options, filter),
    getRun: (runId) => dbGetRun(options, runId),
    getRunReceipt: (runId, tenantId) => dbGetRunReceipt(options, { runId, tenantId }),
    getRunLatencyStats: (limit) => dbQueryRunLatencyStats(options, { ...(limit === undefined ? {} : { limit }) }),
    listPendingApprovals: (filter) => dbListPendingApprovals(options, filter),
    decideApproval: async (nonce, decision, decidedBy) => {
      const result = await approvalsDecideApproval(nonce, decision, decidedBy, { database: options });
      if (result.decided) {
        // Spec §8.1: an approval decided on a project-attributed run is
        // mirrored into the project's decision log BY REFERENCE. The decision
        // itself is already committed and single-use, so a mirror failure must
        // not turn it into an error response; the row is idempotent per
        // (project, approval) and a later decision or backfill can repair it.
        await dbMirrorApprovalDecisionToProjects(options, { nonce, decision, decidedBy }).catch(() => 0);
      }
      return result;
    },
    editApproval: (nonce, editedRequest) =>
      approvalsEditApproval(nonce, editedRequest, { database: options }),
    getAuditEventsForRun: (runId) => dbGetAuditEventsForRun(options, runId),
    registerDeviceToken: (input) => dbRegisterDeviceToken(options, input),
    runChatTask: notify,
    requestGroupFanout: async ({ task, memberRoleIds, body }) => {
      const run = await startTaskRun(options, { taskId: task.taskId, provider: "chat-group", tenantId: task.tenantId });
      const result = await deliverBotToBotMessage(options, {
        // The fan-out gate's sender label is audit data, not a role FK. The
        // persisted group-thread message remains correctly unattributed
        // (`senderRoleId: null`) because its author is the human user.
        fromRoleId: "human",
        toRoleIds: memberRoleIds,
        body,
        runId: run.runId,
          tenantId: task.tenantId,
      });
      // TASK-205: a fan-out (2+ recipients) issues a real pending approval
      // via `deliverBotToBotMessage` but never parked the run — the caller
      // never checked `result.delivered`, so `runs.status` stayed `started`
      // forever even though a real `approvals` row existed. `parkTaskRun`
      // is what every other approval-gated path (TASK-136) already calls;
      // this call site was simply missing it.
      if (!result.delivered) await parkTaskRun(options, run.runId);
      return { runId: run.runId };
    },
    routeGroupMessage: async ({ tenantId, threadId, memberRoleIds, body, title, goal }) => {
      const [roles, messages] = await Promise.all([
        dbListRoles(options, { tenantId, status: "active" }),
        dbListMessages(options, threadId),
      ]);
      // TASK-275: Tier-0 gets a deliberately small, bounded transcript
      // window. `listMessages` is oldest-first, so reverse only after
      // truncating the tail to keep the ten newest entries newest-first.
      const routingHistory = messages.slice(-GROUP_ROUTING_HISTORY_WINDOW).reverse();
      const roomLimit = evaluateGroupRoomLimits(messages, body);
      if (roomLimit !== null) return { route: null, routingRunId: null, stopReason: roomLimit };
      const rolesById = new Map(roles.map((role) => [role.roleId, role]));
      const members = memberRoleIds.map((roleId) => {
        const role = rolesById.get(roleId);
        if (role === undefined) throw new Error(`group routing member ${roleId} is unavailable to this tenant.`);
        return { roleId: role.roleId, name: role.name, title: role.title, description: role.description };
      });
      const grantsByRoleId = new Map(await Promise.all(members.map(async (member) => [
        member.roleId,
        await withDatabase(options, (database) => database.listRoleGrants(member.roleId)),
      ] as const)));
      const mostRecentResponderRoleId = [...messages].reverse().find(
        (message) => message.role === "bot" && message.senderRoleId !== null && message.senderRoleId !== undefined,
      )?.senderRoleId ?? null;

      const recordFallback = async (reason: GroupRoutingFallbackReason, runId: string | null = null): Promise<void> => {
        await dbInsertAuditEvent(options, {
          tenantId,
          runId,
          actor: "system:group-routing",
          eventType: GROUP_ROUTING_FALLBACK_EVENT_TYPE,
          payload: { reason },
        });
      };

      const scoreRequired = new Error("group routing requires Tier-0 scoring");
      try {
        const resolved = await routeGroupMessageWithFallback({
          message: body,
          members,
          mostRecentResponderRoleId,
          grantsByRoleId,
          scorer: async () => { throw scoreRequired; },
          recordFallback,
          fallbackOnScorerFailure: false,
        });
        return { route: resolved, routingRunId: null };
      } catch (error) {
        if (error !== scoreRequired) throw error;
      }

      const routingRoleId = members[0]?.roleId;
      if (routingRoleId === undefined) throw new Error("group routing requires at least one member.");
      const routingTask = await dbCreateTask(options, {
        tenantId,
        roleId: routingRoleId,
        title: `Group routing: ${title.slice(0, 120)}`,
        goal,
        requestedBy: `chat:thread:${threadId}`,
      });
      const routingRun = await startTaskRun(options, {
        taskId: routingTask.taskId,
        tenantId,
        provider: "free-llm-api",
      });
      try {
        const tierZero = createTierZeroProvider({
          db: options,
          runId: routingRun.runId,
          ...resolveTierZeroProviderOptions(options),
        });
        const resolved = await routeGroupMessageWithFallback({
          message: body,
          members,
          mostRecentResponderRoleId,
          grantsByRoleId,
          scorer: async ({ member, message }) => parseTierZeroScore(await tierZero(groupRoutingPrompt(member, message, routingHistory))),
          recordFallback: async (reason) => recordFallback(reason, routingRun.runId),
        });
        await completeTaskRun(options, routingRun.runId);
        return { route: resolved, routingRunId: routingRun.runId };
      } catch (error) {
        await failTaskRun(options, routingRun.runId, "Group routing classifier failed.").catch(() => undefined);
        throw error;
      }
    },
    createSkill: (input) => dbCreateSkill(options, input),
    getSkill: (skillId) => dbGetSkill(options, skillId),
    updateSkill: (skillId, input) => dbUpdateSkill(options, skillId, input),
    listSkills: (filter) => dbListSkills(options, filter),
    setSkillEnabledForRole: (roleId, skillId, enabled) => dbSetEnabledForRole(options, roleId, skillId, enabled),
    listEnabledSkillsForRole: (roleId) => dbListEnabledForRole(options, roleId),
    readProfileTier: (context) => memoryReadProfileTier(options, context),
    writeMemoryFact: (input) => memoryWriteMemoryFact(options, input),
  };
}

/**
 * Production composition for TASK-187's human-secret lifecycle. This is the
 * sole control-api boundary that holds a submitted plaintext, and it passes
 * that value directly to the ADR-014 vault before persisting only its ref.
 */
export function createDatabaseBackedSecretRequests(options: DatabaseOptions, vault: SecretVault): SecretRequestsPort {
  return {
    async listPending(tenantId) {
      const requests = await dbListPendingSecretRequests(options, tenantId);
      return requests.map((request) => ({
        requestId: request.requestId,
        runId: request.runId,
        roleId: request.roleId,
        label: request.label,
        purpose: request.purpose,
        createdAt: request.createdAt.toISOString(),
      }));
    },
    async fulfil(requestId, tenantId, value) {
      // Check ownership before encryption; the conditional update below also
      // makes a concurrent fulfil/decline unable to overwrite the request.
      const pending = await dbGetPendingSecretRequest(options, requestId, tenantId);
      if (pending === null) return { found: false };
      const { ref } = await vault.storeSecret(options, { tenantId, roleId: pending.roleId, value });
      const fulfilled = await dbFulfillPendingSecretRequest(options, requestId, tenantId, `secret://${ref}`);
      if (fulfilled === null) return { found: false };
      await dbInsertAuditEvent(options, {
        tenantId,
        runId: pending.runId,
        actor: "control-api:secret-fulfilment",
        eventType: SECRET_VAULT_WRITE_EVENT,
        payload: { ref, role_id: pending.roleId },
      });
      await dbResumeRun(options, pending.runId);
      return { found: true, ref };
    },
    async decline(requestId, tenantId) {
      const declined = await dbDeclineSecretRequest(options, requestId, tenantId);
      if (declined === null) return { found: false };
      await dbResumeRun(options, declined.runId);
      return { found: true };
    },
  };
}

function resolveTierZeroProviderOptions(
  options: CreateDatabaseBackedDepsOptions,
): Omit<CreateTierZeroProviderOptions, "db" | "runId"> {
  if (options.tierZeroProviderOptions !== undefined) return options.tierZeroProviderOptions;
  const endpoint = process.env.FREE_LLM_API_ENDPOINT?.trim();
  const model = process.env.FREE_LLM_API_MODEL?.trim();
  if (endpoint === undefined || endpoint.length === 0) throw new Error("FREE_LLM_API_ENDPOINT must be set for unaddressed group routing.");
  if (model === undefined || model.length === 0) throw new Error("FREE_LLM_API_MODEL must be set for unaddressed group routing.");
  const apiKey = process.env.FREE_LLM_API_KEY?.trim();
  return { endpoint, model, ...(apiKey === undefined || apiKey.length === 0 ? {} : { apiKey }) };
}

function groupRoutingPrompt(
  member: { title: string; description: string },
  message: string,
  history: readonly Message[] = [],
): string {
  const transcript = history.length === 0
    ? "(no prior messages)"
    : history.map((entry) => `[${entry.role}] ${entry.body}`).join("\n");
  return [
    "Return only a JSON object with a numeric score from 0 through 1.",
    "Score how appropriate it is for this group member to respond to the message.",
    `Member title: ${member.title}`,
    `Member description: ${member.description}`,
    "Recent group transcript (newest first; at most 10 messages):",
    transcript,
    `Message: ${message}`,
  ].join("\n");
}

/** TASK-275's conservative, explicitly configured Tier-0 context bound. */
export const GROUP_ROUTING_HISTORY_WINDOW = 10;
/** TASK-275's configured maximum number of trailing bot-authored turns. */
export const GROUP_CONSECUTIVE_BOT_TURN_CAP = 3;
/** TASK-275's configured count of identical trailing bot replies. */
export const GROUP_QUIET_ROOM_REPEAT_CAP = 2;

export function evaluateGroupRoomLimits(
  messages: readonly Message[],
  incomingBody: string,
): "consecutive_bot_cap" | "quiet_room" | null {
  // Grok Bot's direct-address convention deliberately overrides chatter
  // controls; all unmentioned routing remains server-side fail-closed.
  if (/@[\p{L}\p{N}_-]+/u.test(incomingBody)) return null;

  let trailingBots = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== "bot") break;
    trailingBots += 1;
  }
  if (trailingBots >= GROUP_CONSECUTIVE_BOT_TURN_CAP) return "consecutive_bot_cap";

  const recent = messages.slice(-GROUP_QUIET_ROOM_REPEAT_CAP);
  if (recent.length !== GROUP_QUIET_ROOM_REPEAT_CAP || recent.some((message) => message.role !== "bot")) return null;
  const normalized = recent.map((message) => message.body.trim().toLocaleLowerCase());
  return normalized.every((body) => body === normalized[0]) ? "quiet_room" : null;
}

function parseTierZeroScore(response: string): number {
  try {
    const parsed: unknown = JSON.parse(response);
    if (typeof parsed === "object" && parsed !== null && "score" in parsed) {
      const score = (parsed as { score: unknown }).score;
      if (typeof score === "number" && score >= 0 && score <= 1) return score;
    }
  } catch {
    // Reject non-JSON model prose; selection must remain deterministic.
  }
  throw new UnparsedGroupRoutingScoreError("Tier-0 scorer must return JSON {\"score\": number between 0 and 1}.");
}

function onlySystemHolder(
  message: string,
  members: readonly GroupRoute["recipients"][number][],
  grantsByRoleId: ReadonlyMap<string, readonly RoleGrant[]>,
): GroupRoute["recipients"][number] | null {
  const holders = members.filter((member) => (grantsByRoleId.get(member.roleId) ?? []).some((grant) =>
    systemNamesForCapability(grant.capabilityId).some((name) => containsSystemName(message, name)),
  ));
  return holders.length === 1 ? holders[0]! : null;
}

function hasOffRosterMention(message: string, members: readonly GroupRoute["recipients"][number][]): boolean {
  const mentions = [...message.matchAll(/@([\p{L}\p{N}_-]+)/gu)].map((match) => normalizeRoutingName(match[1]!));
  return mentions.some((mention) => mention !== "everyone" && !members.some((member) => normalizeRoutingName(member.name) === mention));
}

function systemNamesForCapability(capabilityId: string): readonly string[] {
  const connector = capabilityId.split(".")[0]?.trim();
  return connector === undefined || connector.length === 0 || connector === capabilityId
    ? [capabilityId]
    : [capabilityId, connector];
}

function containsSystemName(message: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "iu").test(message);
}

function normalizeRoutingName(value: string): string {
  return value.trim().normalize("NFKC").toLocaleLowerCase();
}

async function withDatabase<T>(options: DatabaseOptions, operation: (database: Database) => Promise<T>): Promise<T> {
  const database = new Database(options);
  try {
    return await operation(database);
  } finally {
    await database.close();
  }
}

/** 10 MiB decoded. Enforced in the upload route, not only the client. */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_MAX_COUNT = 10;
export const ATTACHMENT_INLINE_TEXT_MAX_BYTES = 64 * 1024;
export const ATTACHMENT_ALLOWED_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/pdf",
] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TEXT_CONTENT_TYPES = new Set(["text/plain", "text/markdown", "text/csv", "application/json"]);

export class AttachmentStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentStoreError";
  }
}

export interface ThreadAttachment {
  readonly id: string;
  readonly threadId: string;
  readonly filename: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly absolutePath: string;
}

export interface AttachmentStore {
  persist(input: {
    threadId: string;
    filename: string;
    contentType: string;
    bytes: Buffer;
  }): Promise<ThreadAttachment>;
  resolve(threadId: string, ids: readonly string[]): Promise<ThreadAttachment[]>;
}

export function defaultAttachmentsRoot(): string {
  const fromEnv = process.env.OIK_ATTACHMENTS_DIR?.trim();
  return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : join(tmpdir(), "oikonomos-attachments");
}

export function normalizeAttachmentContentType(value: string): string {
  const raw = value.split(";")[0]?.trim().toLowerCase() ?? "";
  if (raw === "image/jpg") return "image/jpeg";
  return raw;
}

export function isAllowedAttachmentContentType(value: string): boolean {
  return (ATTACHMENT_ALLOWED_CONTENT_TYPES as readonly string[]).includes(normalizeAttachmentContentType(value));
}

export function isInlineableTextContentType(value: string): boolean {
  return TEXT_CONTENT_TYPES.has(normalizeAttachmentContentType(value));
}

export function publicAttachmentRef(attachment: ThreadAttachment): {
  id: string;
  filename: string;
  contentType: string;
  byteSize: number;
  sha256: string;
} {
  return {
    id: attachment.id,
    filename: attachment.filename,
    contentType: attachment.contentType,
    byteSize: attachment.byteSize,
    sha256: attachment.sha256,
  };
}

/**
 * Build the chat-run prompt so the existing agent Read/Bash tools can
 * reach the file without a worker change. Small UTF-8 text is inlined;
 * every attachment also carries its absolute path (TASK-153: host paths
 * outside the per-run cwd remain reachable).
 */
export function buildChatGoal(
  body: string,
  attachments: ReadonlyArray<ThreadAttachment & { textContent?: string }>,
): string {
  if (attachments.length === 0) return body;
  const intro =
    body.trim().length === 0
      ? "The user sent file attachment(s) with no additional text."
      : body.trim();
  const sections = attachments.map((attachment) => {
    const header = [
      `### ${attachment.filename} (${attachment.contentType}, ${String(attachment.byteSize)} bytes, sha256 ${attachment.sha256})`,
      `Absolute path: ${attachment.absolutePath}`,
    ];
    if (attachment.textContent !== undefined) {
      header.push("Inlined text contents:", "```", attachment.textContent, "```");
    } else {
      header.push("Binary or large file: use the Read tool on the absolute path above to inspect the bytes.");
    }
    return header.join("\n");
  });
  return `${intro}\n\n---\nAttached files. Each file is stored on disk at the given absolute path; you can Read that path with your existing tools. Text contents are inlined when small enough.\n\n${sections.join("\n\n")}`;
}

interface AttachmentMeta {
  id: string;
  threadId: string;
  filename: string;
  contentType: string;
  byteSize: number;
  sha256: string;
}

function requireUuidSegment(value: string, field: string): string {
  const trimmed = value.trim();
  if (!UUID_RE.test(trimmed)) throw new AttachmentStoreError(`${field} must be a UUID.`);
  return trimmed;
}

function sanitizeStoredFilename(filename: string): string {
  const base = filename.replace(/\\/g, "/").split("/").pop()?.trim() ?? "";
  if (base.length === 0 || base === "." || base === "..") {
    throw new AttachmentStoreError("filename must be a single path segment.");
  }
  if (base.length > 255) throw new AttachmentStoreError("filename must be at most 255 characters.");
  return base;
}

export function createFilesystemAttachmentStore(rootDir: string = defaultAttachmentsRoot()): AttachmentStore {
  return {
    async persist(input) {
      const threadId = requireUuidSegment(input.threadId, "threadId");
      const filename = sanitizeStoredFilename(input.filename);
      const contentType = normalizeAttachmentContentType(input.contentType);
      if (input.bytes.length === 0) throw new AttachmentStoreError("file must not be empty.");
      const id = randomUUID();
      const sha256 = createHash("sha256").update(input.bytes).digest("hex");
      const dir = join(rootDir, threadId);
      await mkdir(dir, { recursive: true });
      const absolutePath = join(dir, `${id}.bin`);
      const meta: AttachmentMeta = {
        id,
        threadId,
        filename,
        contentType,
        byteSize: input.bytes.length,
        sha256,
      };
      await writeFile(absolutePath, input.bytes);
      await writeFile(join(dir, `${id}.meta.json`), JSON.stringify(meta), "utf8");
      return { ...meta, absolutePath };
    },
    async resolve(threadId, ids) {
      const normalizedThreadId = requireUuidSegment(threadId, "threadId");
      const uniqueIds = [...new Set(ids.map((id) => requireUuidSegment(id, "attachmentId")))];
      const resolved: ThreadAttachment[] = [];
      for (const id of uniqueIds) {
        const dir = join(rootDir, normalizedThreadId);
        const absolutePath = join(dir, `${id}.bin`);
        const metaRaw = await readFile(join(dir, `${id}.meta.json`), "utf8").catch(() => {
          throw new AttachmentStoreError(`attachment not found: ${id}`);
        });
        let meta: AttachmentMeta;
        try {
          meta = JSON.parse(metaRaw) as AttachmentMeta;
        } catch {
          throw new AttachmentStoreError(`attachment metadata is unreadable: ${id}`);
        }
        if (meta.threadId !== normalizedThreadId || meta.id !== id) {
          throw new AttachmentStoreError(`attachment not found: ${id}`);
        }
        const bytes = await readFile(absolutePath).catch(() => {
          throw new AttachmentStoreError(`attachment not found: ${id}`);
        });
        resolved.push({ ...meta, byteSize: bytes.length, absolutePath });
      }
      return resolved;
    },
  };
}
