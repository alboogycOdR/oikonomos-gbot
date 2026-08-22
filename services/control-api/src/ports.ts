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
  getAuditEventsForRun as dbGetAuditEventsForRun,
  getRun as dbGetRun,
  listPendingApprovals as dbListPendingApprovals,
  listRuns as dbListRuns,
  type AuditEvent,
  type DatabaseOptions,
  type NewTask,
  type PendingApprovalFilter,
  type Approval,
  type Run,
  type RunListFilter,
  type RunListPage,
  type Task,
} from "@oikonomos/db";
import {
  decideApproval as approvalsDecideApproval,
  type ApprovalDecision,
  type DecideApprovalResult,
} from "@oikonomos/approvals";

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
  listRuns(filter?: RunListFilter): Promise<RunListPage>;
  getRun(runId: string): Promise<Run | null>;
  listPendingApprovals(filter?: PendingApprovalFilter): Promise<Approval[]>;
  decideApproval(
    nonce: string,
    decision: ApprovalDecision,
    decidedBy: string,
  ): Promise<DecideApprovalResult>;
  getAuditEventsForRun(runId: string): Promise<AuditEvent[]>;
}

/**
 * Bind every port method to one live `DatabaseOptions`. The approval
 * decide path is handed `{ database: options }` so `packages/approvals`
 * opens its own connection via `createDatabaseStore` — this file never
 * touches a `Pool` directly, only the two packages' public functions.
 */
export function createDatabaseBackedDeps(options: DatabaseOptions): ControlApiDeps {
  return {
    createTask: (input) => dbCreateTask(options, input),
    listRuns: (filter) => dbListRuns(options, filter),
    getRun: (runId) => dbGetRun(options, runId),
    listPendingApprovals: (filter) => dbListPendingApprovals(options, filter),
    decideApproval: (nonce, decision, decidedBy) =>
      approvalsDecideApproval(nonce, decision, decidedBy, { database: options }),
    getAuditEventsForRun: (runId) => dbGetAuditEventsForRun(options, runId),
  };
}
