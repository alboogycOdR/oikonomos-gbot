/**
 * TASK-056 / OIK-084 — the only two modules this service is allowed to
 * import for persistence. Every route handler goes through the
 * `ControlApiDeps` port below; no route, and no other file in this
 * package, may import `pg`, hold a `Pool`, or embed a SQL string
 * (OIK-084 "not the DB" / N9 spirit). `test/no-raw-sql.test.ts` is the
 * liveness check that keeps this true.
 */
import {
  createTask as dbCreateTask,
  createRole as dbCreateRole,
  getOrCreateThreadForRole as dbGetOrCreateThreadForRole,
  insertMessage as dbInsertMessage,
  getAuditEventsForRun as dbGetAuditEventsForRun,
  getRun as dbGetRun,
  listPendingApprovals as dbListPendingApprovals,
  listMessages as dbListMessages,
  listRoles as dbListRoles,
  listRuns as dbListRuns,
  listTasks as dbListTasks,
  listThreads as dbListThreads,
  type AuditEvent,
  type DatabaseOptions,
  type NewTask,
  type NewRole,
  type NewThread,
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
  type Thread,
  type Message,
  type MessageListOptions,
} from "@oikonomos/db";
import {
  decideApproval as approvalsDecideApproval,
  editApproval as approvalsEditApproval,
  type ApprovalDecision,
  type DecideApprovalResult,
  type EditApprovalResult,
  type IssueApprovalRequest,
} from "@oikonomos/approvals";
import { createChatRunDriver, type ChatRunDriver } from "@oikonomos/worker";

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
  createRole(input: NewRole): Promise<Role>;
  listRoles(filter: { tenantId: string; status?: "active" | "hidden" | "deleted" }): Promise<Role[]>;
  getOrCreateThreadForRole(input: NewThread): Promise<Thread>;
  listThreads(): Promise<Thread[]>;
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
  runChatTask(input: { task: Task; threadId: string }): Promise<void>;
}

/**
 * Bind every port method to one live `DatabaseOptions`. The approval
 * decide path is handed `{ database: options }` so `packages/approvals`
 * opens its own connection via `createDatabaseStore` — this file never
 * touches a `Pool` directly, only the two packages' public functions.
 */
export function createDatabaseBackedDeps(options: DatabaseOptions): ControlApiDeps {
  const chatRunDriver: ChatRunDriver = createChatRunDriver(options);
  return {
    createTask: (input) => dbCreateTask(options, input),
    createRole: (input) => dbCreateRole(options, input),
    listRoles: (filter) => dbListRoles(options, filter),
    getOrCreateThreadForRole: (input) => dbGetOrCreateThreadForRole(options, input),
    listThreads: () => dbListThreads(options),
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
    runChatTask: (input) => chatRunDriver.run(input),
  };
}
