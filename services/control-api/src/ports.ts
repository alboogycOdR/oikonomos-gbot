/**
 * TASK-056 / OIK-084 — the only two modules this service is allowed to
 * import for persistence. Every route handler goes through the
 * `ControlApiDeps` port below; no route, and no other file in this
 * package, may import `pg`, hold a `Pool`, or embed a SQL string
 * (OIK-084 "not the DB" / N9 spirit). `test/no-raw-sql.test.ts` is the
 * liveness check that keeps this true.
 */
import {
  Database,
  createTask as dbCreateTask,
  createRoutine as dbCreateRoutine,
  createRole as dbCreateRole,
  createGroupThread as dbCreateGroupThread,
  getOrCreateThreadForRole as dbGetOrCreateThreadForRole,
  insertMessage as dbInsertMessage,
  getAuditEventsForRun as dbGetAuditEventsForRun,
  getRun as dbGetRun,
  listPendingApprovals as dbListPendingApprovals,
  listMessages as dbListMessages,
  listRoles as dbListRoles,
  listRoutines as dbListRoutines,
  listRuns as dbListRuns,
  listTasks as dbListTasks,
  listThreads as dbListThreads,
  listAllThreadsWithMembers as dbListAllThreadsWithMembers,
  listDeviceTokens as dbListDeviceTokens,
  registerDeviceToken as dbRegisterDeviceToken,
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
  type RoleGrant,
  type Routine,
  type Thread,
  type GroupThread,
  type Message,
  type MessageListOptions,
  type DeviceToken,
  type RegisterDeviceTokenInput,
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
  createChatRunDriver,
  deliverBotToBotMessage,
  startTaskRun,
  type ChatRunDriver,
} from "@oikonomos/worker";
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
  listRoutines(filter: { tenantId: string; roleId?: string }): Promise<Routine[]>;
  getOrCreateThreadForRole(input: NewThread): Promise<Thread>;
  listThreads(): Promise<Thread[]>;
  createGroupThread(input: NewGroupThread): Promise<GroupThread>;
  listAllThreadsWithMembers(): Promise<Array<Thread | GroupThread>>;
  insertMessage(input: NewMessage): Promise<Message>;
  listMessages(threadId: string, options?: MessageListOptions): Promise<Message[]>;
  listTasks(filter?: TaskListFilter): Promise<TaskListPage>;
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
  runChatTask(input: { task: Task; threadId: string }): Promise<void>;
  requestGroupFanout(input: { task: Task; memberRoleIds: readonly string[]; body: string }): Promise<{ runId: string }>;
}

export interface CreateDatabaseBackedDepsOptions extends DatabaseOptions {
  /** Tests inject a collecting transport; production resolves the env-gated FCM transport. */
  pushTransport?: PushTransportPort;
}

export interface PushNotificationDeps {
  runChatTask(input: { task: Task; threadId: string }): Promise<void>;
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
  const chatRunDriver: ChatRunDriver = createChatRunDriver(options);
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
    createRoutine: (input) => dbCreateRoutine(options, input),
    createRole: (input) => dbCreateRole(options, input),
    listCapabilities: () => withDatabase(options, (database) => database.listCapabilities()),
    upsertRoleGrant: (input) => withDatabase(options, (database) => database.upsertRoleGrant(input)),
    listRoleGrants: (roleId) => withDatabase(options, (database) => database.listRoleGrants(roleId)),
    revokeRoleGrant: (roleId, capabilityId) =>
      withDatabase(options, (database) => database.revokeRoleGrant(roleId, capabilityId)),
    listRoles: (filter) => dbListRoles(options, filter),
    listRoutines: (filter) => dbListRoutines(options, filter),
    getOrCreateThreadForRole: (input) => dbGetOrCreateThreadForRole(options, input),
    listThreads: () => dbListThreads(options),
    createGroupThread: (input) => dbCreateGroupThread(options, input),
    listAllThreadsWithMembers: () => dbListAllThreadsWithMembers(options),
    insertMessage: (input) => dbInsertMessage(options, input),
    listMessages: (threadId, listOptions) => dbListMessages(options, threadId, listOptions),
    listTasks: (filter) => dbListTasks(options, filter),
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
  };
}

async function withDatabase<T>(options: DatabaseOptions, operation: (database: Database) => Promise<T>): Promise<T> {
  const database = new Database(options);
  try {
    return await operation(database);
  } finally {
    await database.close();
  }
}
