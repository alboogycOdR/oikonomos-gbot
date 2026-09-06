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
  createTask as dbCreateTask,
  createRoutine as dbCreateRoutine,
  createRole as dbCreateRole,
  createGroupThread as dbCreateGroupThread,
  getOrCreateThreadForRole as dbGetOrCreateThreadForRole,
  getTask as dbGetTask,
  insertMessage as dbInsertMessage,
  getAuditEventsForRun as dbGetAuditEventsForRun,
  getRun as dbGetRun,
  listPendingApprovals as dbListPendingApprovals,
  listMessages as dbListMessages,
  listRoles as dbListRoles,
  listRoleMessages as dbListRoleMessages,
  updateRoleInstructions as dbUpdateRoleInstructions,
  listRoutines as dbListRoutines,
  listRuns as dbListRuns,
  listTasks as dbListTasks,
  listThreads as dbListThreads,
  listAllThreadsWithMembers as dbListAllThreadsWithMembers,
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
  getRoutine as dbGetRoutine,
  setRoutinePaused as dbSetRoutinePaused,
  updateRoutineSkill as dbUpdateRoutineSkill,
  RoutineLimitError,
  type AuditEvent,
  type Capability,
  type DatabaseOptions,
  type NewTask,
  type NewRoutine,
  type NewRole,
  type NewThread,
  type NewGroupThread,
  type NewMessage,
  type PendingApprovalFilter,
  type Approval,
  type Run,
  type RunListFilter,
  type RunListPage,
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
  createChatRunDriver,
  createTierZeroProvider,
  deliverBotToBotMessage,
  failTaskRun,
  route,
  startTaskRun,
  type ChatRunDriver,
  type CreateTierZeroProviderOptions,
  type CreateChatRunDriverOptions,
  type GroupRoute,
} from "@oikonomos/worker";
import type { ThreadContextPort } from "./app.js";
import { createPushTransportFromEnv, type PushNotification, type PushTransportPort } from "./pushTransport.js";

/**
 * The port every route handler is written against. Route-level tests
 * inject a fake implementing this interface — no network, no DB. The
 * real implementation (`createDatabaseBackedDeps`) binds each function to
 * a live `DatabaseOptions`/`@oikonomos/approvals` dependency object and is
 * used only by `index.ts`'s `start()` and by the DATABASE_URL-gated
 * integration tests.
 */
export interface ControlApiDeps {
  createTask(input: NewTask): Promise<Task>;
  createRoutine(input: NewRoutine): Promise<Routine>;
  createRole(input: NewRole): Promise<Role>;
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
  listAllThreadsWithMembers(): Promise<Array<Thread | GroupThread>>;
  insertMessage(input: NewMessage): Promise<Message>;
  listMessages(threadId: string, options?: MessageListOptions): Promise<Message[]>;
  listTasks(filter?: TaskListFilter): Promise<TaskListPage>;
  getTask(taskId: string): Promise<Task | null>;
  listRuns(filter?: RunListFilter): Promise<RunListPage>;
  getRun(runId: string): Promise<Run | null>;
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
  }): Promise<{ route: GroupRoute; routingRunId: string | null }>;
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
}

export interface CreateDatabaseBackedDepsOptions extends DatabaseOptions {
  /** Tests inject a collecting transport; production resolves the env-gated FCM transport. */
  pushTransport?: PushTransportPort;
  /** Test-only seams for real database-backed chat lifecycle tests. */
  chatRunDriverOptions?: Omit<CreateChatRunDriverOptions, keyof DatabaseOptions>;
  /** Injectable Tier-0 configuration; production resolves the same values from env. */
  tierZeroProviderOptions?: Omit<CreateTierZeroProviderOptions, "db" | "runId">;
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
export function createDatabaseBackedDeps(options: CreateDatabaseBackedDepsOptions): ControlApiDeps {
  const chatRunDriver: ChatRunDriver = createChatRunDriver({ ...options, ...options.chatRunDriverOptions });
  const pushTransport = options.pushTransport ?? createPushTransportFromEnv();
  const notify = (input: { task: Task; threadId: string }) => notifyAfterChatRun(input, {
    runChatTask: (request) => chatRunDriver.run(request),
    listRuns: (filter) => dbListRuns(options, filter),
    listPendingApprovals: () => dbListPendingApprovals(options),
    listDeviceTokens: () => dbListDeviceTokens(options),
    pushTransport,
  });
  return {
    createTask: (input) => dbCreateTask(options, input),
    createRoutine: async (input) => dbCreateRoutine(options, input),
    createRole: (input) => dbCreateRole(options, input),
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
    listAllThreadsWithMembers: () => dbListAllThreadsWithMembers(options),
    insertMessage: (input) => dbInsertMessage(options, input),
    listMessages: (threadId, listOptions) => dbListMessages(options, threadId, listOptions),
    listTasks: (filter) => dbListTasks(options, filter),
    getTask: (taskId) => dbGetTask(options, taskId),
    listRuns: (filter) => dbListRuns(options, filter),
    getRun: (runId) => dbGetRun(options, runId),
    listPendingApprovals: (filter) => dbListPendingApprovals(options, filter),
    decideApproval: (nonce, decision, decidedBy) =>
      approvalsDecideApproval(nonce, decision, decidedBy, { database: options }),
    editApproval: (nonce, editedRequest) =>
      approvalsEditApproval(nonce, editedRequest, { database: options }),
    getAuditEventsForRun: (runId) => dbGetAuditEventsForRun(options, runId),
    registerDeviceToken: (input) => dbRegisterDeviceToken(options, input),
    runChatTask: notify,
    requestGroupFanout: async ({ task, memberRoleIds, body }) => {
      const run = await startTaskRun(options, { taskId: task.taskId, provider: "chat-group" });
      await deliverBotToBotMessage(options, {
        // The fan-out gate's sender label is audit data, not a role FK. The
        // persisted group-thread message remains correctly unattributed
        // (`senderRoleId: null`) because its author is the human user.
        fromRoleId: "human",
        toRoleIds: memberRoleIds,
        body,
        runId: run.runId,
        tenantId: task.tenantId,
      });
      return { runId: run.runId };
    },
    routeGroupMessage: async ({ tenantId, threadId, memberRoleIds, body, title, goal }) => {
      const [roles, messages] = await Promise.all([
        dbListRoles(options, { tenantId, status: "active" }),
        dbListMessages(options, threadId),
      ]);
      const rolesById = new Map(roles.map((role) => [role.roleId, role]));
      const members = memberRoleIds.map((roleId) => {
        const role = rolesById.get(roleId);
        if (role === undefined) throw new Error(`group routing member ${roleId} is unavailable to this tenant.`);
        return { roleId: role.roleId, name: role.name, title: role.title, description: role.description };
      });
      const mostRecentResponderRoleId = [...messages].reverse().find(
        (message) => message.role === "bot" && message.senderRoleId !== null && message.senderRoleId !== undefined,
      )?.senderRoleId ?? null;

      const scoreRequired = new Error("group routing requires Tier-0 scoring");
      try {
        const resolved = await route({
          message: body,
          members,
          mostRecentResponderRoleId,
          scorer: async () => { throw scoreRequired; },
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
        const resolved = await route({
          message: body,
          members,
          mostRecentResponderRoleId,
          scorer: async ({ member, message }) => parseTierZeroScore(await tierZero(groupRoutingPrompt(member, message))),
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
): string {
  return [
    "Return only a JSON object with a numeric score from 0 through 1.",
    "Score how appropriate it is for this group member to respond to the message.",
    `Member title: ${member.title}`,
    `Member description: ${member.description}`,
    `Message: ${message}`,
  ].join("\n");
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
  throw new Error("Tier-0 scorer must return JSON {\"score\": number between 0 and 1}.");
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
