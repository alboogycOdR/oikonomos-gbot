/**
 * TASK-273 — delivers a persisted `role_messages` handoff to its recipient.
 *
 * TASK-272 fixed `send_to_role`'s real bugs, so a handoff now genuinely
 * persists a `role_messages` row. Nothing delivered it: the only reader
 * (`services/control-api/src/app.ts`'s `GET /roles/:roleId/handoffs`) is a
 * human-facing dashboard history endpoint, not anything the recipient bot
 * itself can see or act on. This file is the missing other half of probe
 * Q5's documented "async-send-then-later-wake" design
 * (STUDY-grok-bot-018.md): a durable poller, mirroring
 * `services/worker/src/jobs/routineJob.ts`'s own accepted fire pattern
 * (`createAndEnqueueRoutineRun`), that turns each undelivered row into a
 * real bot-authored turn on the recipient's own thread.
 *
 * Design decisions the Acceptance Criteria explicitly asked this task to
 * make and document:
 *
 * - **Delivery text is `task.goal`.** Confirmed live in
 *   `services/worker/src/chatRunDriver.ts` that both lanes consume
 *   `task.goal` identically — `buildGeminiTurnPrompt` appends it as the
 *   newest turn, `claudePrintCommand(request.task.goal, ...)` sends it as
 *   the resumed turn — so setting the delivered text as the run's `goal`
 *   (exactly mirroring how a routine fire's goal reaches the model) makes
 *   lane parity true by construction. No provider-specific tool-layer code
 *   is needed.
 * - **"Delivered" is the existing `read_at` column, not a new one.**
 *   `markRoleMessageRead` (`@oikonomos/db`) is already exported and
 *   idempotent (`read_at = COALESCE(read_at, now())`), and a delivered
 *   message has no further use for an "unread" state distinct from
 *   "delivered" — the dashboard's own `GET /roles/:roleId/handoffs` history
 *   view is unaffected either way. Reusing it avoids a schema migration
 *   this task's `Owned_Paths` cannot reach (`packages/db` is out of
 *   territory here).
 * - **Ordering is enqueue-then-mark-read**, deliberately matching
 *   `routineJob.ts`'s own accepted `createAndEnqueueRoutineRun` (create +
 *   enqueue) BEFORE `recordFire` ordering: a crash between the enqueue and
 *   the `markRoleMessageRead` risks a rare duplicate redelivery on the next
 *   poll, never a silent, permanent drop. Combined with this poller's own
 *   `singleton` pg-boss queue policy (one poll in flight at a time, same as
 *   `WORKER_ROUTINE_POLL_JOB`), that keeps duplicates a crash-window edge
 *   case rather than a routine occurrence.
 * - **A missing or non-active recipient role is skipped, not dropped.** The
 *   row stays unread (never marked delivered) so a later poll retries it if
 *   the role becomes active again — "no silent drop if the recipient's
 *   thread does not exist yet" from the Acceptance Criteria.
 *   `role_messages.to_role_id` has a `REFERENCES roles(role_id)` foreign
 *   key with no `ON DELETE` action (`infra/postgres/migrations/
 *   004_roles_routines_rules.up.sql`), so a role referenced by a pending
 *   message can never be hard-deleted out from under it — the reachable
 *   "not deliverable yet" case is a role whose `status` has moved off
 *   `"active"` (soft-delete, matching `roleStatuses` in `roles.ts`), the
 *   same check `routineJob.ts`'s `environmentIsUp` already uses for the
 *   identical reason. `getOrCreateThreadForRole` itself always yields a
 *   thread for a role that exists, so this is the only skip case.
 * - **No regression to probe Q5's four properties** (async / verbatim text
 *   + sender identity / zero context carry-over / no implicit memory
 *   write, `services/workspace/src/mailbox.ts`): this module reads only
 *   `message.body` and the sender's display name (`getRole`) — no
 *   transcript, no memory write — and layers delivery on top of the
 *   existing send path without touching it.
 */
import { PgBoss } from "pg-boss";

import {
  createTaskExecutionRun,
  getOrCreateThreadForRole,
  getRole,
  listProjectRoleMembers,
  listRoleMessages,
  markRoleMessageRead,
  resolveRoleRuntime,
  type DatabaseOptions,
  type RoleMessage,
} from "@oikonomos/db";

import { enqueueRunExecution } from "./jobs/workerJobQueue.js";

export interface RoleMessageDeliveryOptions extends DatabaseOptions {
  tenantId: string;
}

export interface RoleMessageDeliveryResult {
  messageId: string;
  toRoleId: string;
  outcome: "delivered" | "skipped_no_role";
  /** Only set when `outcome === "delivered"` — the run a test can drive/inspect directly. */
  runId?: string;
}

/** Mirrors `routineJob.ts`'s own `environmentIsUp` check for the same reason. */
function roleIsDeliverable<T extends { status: string }>(role: T | null): role is T {
  return role !== null && role.status === "active";
}

function requireNonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`${field} must not be empty.`);
  return trimmed;
}

/**
 * The exact turn text the recipient's own next real chat run sees. Kept as
 * a named export so a test (or a future dashboard preview) can assert the
 * literal wording without duplicating it.
 */
export function roleMessageDeliveryGoal(senderName: string, body: string): string {
  return `You have a message from ${senderName}: ${body}`;
}

async function deliverRoleMessage(
  options: DatabaseOptions,
  message: RoleMessage,
): Promise<RoleMessageDeliveryResult> {
  const recipient = await getRole(options, message.toRoleId);
  if (!roleIsDeliverable(recipient)) {
    // Left unread on purpose: retried by the next poll rather than dropped.
    return { messageId: message.messageId, toRoleId: message.toRoleId, outcome: "skipped_no_role" };
  }

  const sender = await getRole(options, message.fromRoleId);
  const senderName = sender?.name ?? message.fromRoleId;

  const thread = await getOrCreateThreadForRole(options, { roleId: message.toRoleId });
  const { provider } = resolveRoleRuntime(recipient);
  const projectId = await attributedProjectIdForHandoff(options, message);
  const { runId } = await createTaskExecutionRun(options, {
    task: {
      tenantId: message.tenantId,
      roleId: message.toRoleId,
      title: `Message from ${senderName}`,
      goal: roleMessageDeliveryGoal(senderName, message.body),
      requestedBy: `role-message:${message.messageId}`,
    },
    execution: { version: 1, kind: "chat", threadId: thread.id, ...(projectId === null ? {} : { projectId }) } as never,
    provider,
  });
  await enqueueRunExecution(options.connectionString, runId);
  // Marked read last, deliberately — see the module docstring's ordering note.
  await markRoleMessageRead(options, message.messageId);

  return { messageId: message.messageId, toRoleId: message.toRoleId, outcome: "delivered", runId };
}

async function attributedProjectIdForHandoff(options: DatabaseOptions, message: RoleMessage): Promise<string | null> {
  if (message.handoffKind !== "task.assigned" || message.factRef === null) return null;
  const ref = message.factRef as { project_id?: unknown };
  if (typeof ref.project_id !== "string" || ref.project_id.trim().length === 0) return null;
  const members = await listProjectRoleMembers(options, ref.project_id);
  const sender = members.find((member) => member.roleId === message.fromRoleId);
  const recipient = members.find((member) => member.roleId === message.toRoleId);
  return sender?.isManager === true && recipient !== undefined ? ref.project_id : null;
}

/**
 * Finds every undelivered (`read_at IS NULL`) `role_messages` row for the
 * tenant and delivers each as a real bot-authored turn on the recipient's
 * own thread. Called by the poller below on a durable pg-boss schedule, and
 * directly by tests / an immediate-poll trigger.
 */
export async function deliverPendingRoleMessages(
  options: RoleMessageDeliveryOptions,
): Promise<RoleMessageDeliveryResult[]> {
  const tenantId = requireNonEmpty(options.tenantId, "tenantId");
  const pending = await listRoleMessages(options, { tenantId, unreadOnly: true });
  const results: RoleMessageDeliveryResult[] = [];
  // Sequential, not Promise.all: two pending messages can target the same
  // recipient role, and `getOrCreateThreadForRole`'s upsert is safe either
  // way, but serial delivery keeps this poller's own behaviour easy to
  // reason about and keeps one bad row (e.g. a deleted role) from racing a
  // good one for no benefit — a poll tick is not latency-sensitive.
  for (const message of pending) {
    results.push(await deliverRoleMessage(options, message));
  }
  return results;
}

export const WORKER_ROLE_MESSAGE_DELIVERY_POLL_JOB = "worker.role-message-delivery-poll";

const roleMessageDeliveryPollQueueOptions = {
  policy: "singleton",
  retryLimit: 3,
  retryDelay: 1,
  retryBackoff: true,
  expireInSeconds: 60,
  retentionSeconds: 86_400,
  deleteAfterSeconds: 604_800,
} as const;

/** Same cadence as `WORKER_ROUTINE_POLL_JOB` (workerJobQueue.ts). */
const ROLE_MESSAGE_DELIVERY_POLL_CRON = "* * * * *";

export interface RoleMessageDeliveryPollerOptions {
  connectionString: string;
  tenantId: string;
  /** Lets deployments and integration tests identify pg-boss-owned connections. */
  applicationName?: string;
  /**
   * Mirrors `CreateWorkerJobQueueOptions.onError` (workerJobQueue.ts,
   * TASK-221): pg-boss's own 'error' event and any handler throw are
   * otherwise silent. Defaults to `console.error`.
   */
  onError?(error: unknown, context: { job: string }): Promise<void> | void;
}

function assertConnectionString(connectionString: string): void {
  if (connectionString.trim().length === 0) {
    throw new Error("DATABASE_URL must not be empty when starting the role-message delivery poller.");
  }
}

/**
 * Owns its own small pg-boss lifecycle — deliberately separate from
 * `WorkerJobQueue` (`services/worker/src/jobs/workerJobQueue.ts`), which is
 * outside this task's `Owned_Paths`. Mirrors that class's own
 * start/schedule/stop shape so `services/worker/src/main.ts` can compose it
 * the same way it composes `WorkerJobQueue`.
 */
export class RoleMessageDeliveryPoller {
  private boss: PgBoss | undefined;

  public constructor(private readonly options: RoleMessageDeliveryPollerOptions) {
    assertConnectionString(options.connectionString);
  }

  public async start(): Promise<void> {
    if (this.boss !== undefined) return;

    const boss = new PgBoss({
      connectionString: this.options.connectionString,
      application_name: this.options.applicationName ?? "oikonomos-worker-role-message-delivery",
    });

    const onError = this.options.onError ?? ((error: unknown) => console.error(error));
    boss.on("error", (error) => void onError(error, { job: "pg-boss" }));

    try {
      await boss.start();
      await boss.createQueue(WORKER_ROLE_MESSAGE_DELIVERY_POLL_JOB, roleMessageDeliveryPollQueueOptions);
      await boss.work(WORKER_ROLE_MESSAGE_DELIVERY_POLL_JOB, async () => {
        try {
          await deliverPendingRoleMessages({
            connectionString: this.options.connectionString,
            tenantId: this.options.tenantId,
          });
        } catch (error) {
          await onError(error, { job: WORKER_ROLE_MESSAGE_DELIVERY_POLL_JOB });
          throw error; // still fails/retries the job the same as before — this only adds visibility.
        }
      });
      // pg-boss owns this durable repeating schedule, so a worker restart
      // neither loses nor duplicates the next delivery sweep.
      await boss.schedule(WORKER_ROLE_MESSAGE_DELIVERY_POLL_JOB, ROLE_MESSAGE_DELIVERY_POLL_CRON);
      this.boss = boss;
    } catch (error) {
      await boss.stop({ close: true }).catch(() => undefined);
      throw error;
    }
  }

  /** Enqueue an immediate durable poll, used by bootstraps and integration tests. */
  public async enqueuePollNow(): Promise<string> {
    if (this.boss === undefined) {
      throw new Error("Role-message delivery poller must be started before a poll can be enqueued.");
    }
    const id = await this.boss.send(WORKER_ROLE_MESSAGE_DELIVERY_POLL_JOB, {});
    if (id === null) throw new Error("pg-boss did not create the role-message delivery poll job.");
    return id;
  }

  public async stop(): Promise<void> {
    const boss = this.boss;
    this.boss = undefined;
    if (boss !== undefined) await boss.stop({ close: true, graceful: true, timeout: 10_000 });
  }
}

export function createRoleMessageDeliveryPoller(
  options: RoleMessageDeliveryPollerOptions,
): RoleMessageDeliveryPoller {
  return new RoleMessageDeliveryPoller(options);
}

if (import.meta.vitest) {
  const { describe, it, expect, beforeAll, afterAll } = import.meta.vitest;
  const {
    addProjectRoleMember,
    createProject,
    createProjectTask,
    createRole,
    sendRoleMessage,
    getRun,
    getTask,
    listMessages,
    defaultPoolConfig,
  } = await import(
    "@oikonomos/db"
  );
  const { Pool } = await import("pg");
  const { purgePgBossQueue, withPgBossQueueLock } = await import("./jobs/pgBossTestCleanup.js");
  const { WORKER_RUN_EXECUTION_JOB } = await import("./jobs/workerJobQueue.js");
  const { createChatRunDriver } = await import("./chatRunDriver.js");

  describe("roleMessageDeliveryGoal — pure text, lane-agnostic by construction", () => {
    it("renders sender name and verbatim body", () => {
      expect(roleMessageDeliveryGoal("Alice", "please review the draft")).toBe(
        "You have a message from Alice: please review the draft",
      );
    });
  });

  const connectionString = process.env.DATABASE_URL;
  const integration = connectionString === undefined ? describe.skip : describe;

  integration("deliverPendingRoleMessages — real Postgres + real pg-boss (TASK-273)", () => {
    let pool: InstanceType<typeof Pool>;
    const tenantId = `task-273-role-message-delivery-${crypto.randomUUID()}`;
    const options = { connectionString: connectionString!, tenantId };

    beforeAll(() => {
      pool = new Pool({ connectionString: connectionString!, ...defaultPoolConfig });
    });

    afterAll(async () => {
      await pool.query(`DELETE FROM role_messages WHERE tenant_id = $1`, [tenantId]);
      // messages.run_id REFERENCES runs — delete messages before runs, and
      // audit_events before runs too (chatRunDriver.test.ts's own precedent).
      await pool.query(
        `DELETE FROM messages WHERE thread_id IN (SELECT id FROM threads WHERE role_id IN (SELECT role_id FROM roles WHERE tenant_id = $1))`,
        [tenantId],
      );
      await pool.query(`DELETE FROM audit_events WHERE run_id IN (SELECT run_id FROM runs WHERE task_id IN (SELECT task_id FROM tasks WHERE tenant_id = $1))`, [tenantId]);
      await pool.query(`DELETE FROM runs WHERE task_id IN (SELECT task_id FROM tasks WHERE tenant_id = $1)`, [tenantId]);
      await pool.query(`DELETE FROM tasks WHERE tenant_id = $1`, [tenantId]);
      await pool.query(`DELETE FROM project_tasks WHERE project_id IN (SELECT project_id FROM projects WHERE tenant_id = $1)`, [tenantId]);
      await pool.query(`DELETE FROM project_roles WHERE project_id IN (SELECT project_id FROM projects WHERE tenant_id = $1)`, [tenantId]);
      await pool.query(`DELETE FROM projects WHERE tenant_id = $1`, [tenantId]);
      await pool.query(`DELETE FROM thread_members WHERE thread_id IN (SELECT id FROM threads WHERE role_id IN (SELECT role_id FROM roles WHERE tenant_id = $1))`, [tenantId]);
      await pool.query(`DELETE FROM threads WHERE role_id IN (SELECT role_id FROM roles WHERE tenant_id = $1)`, [tenantId]);
      await pool.query(`DELETE FROM roles WHERE tenant_id = $1`, [tenantId]);
      await pool.end();
    });

    it("delivers a real handoff as a real chat run and marks it read exactly once", async () => {
      await withPgBossQueueLock(pool, async () => {
        await purgePgBossQueue(pool, WORKER_RUN_EXECUTION_JOB);

        const senderId = `task-273-sender-${crypto.randomUUID()}`;
        const recipientId = `task-273-recipient-${crypto.randomUUID()}`;
        await createRole({ connectionString: connectionString! }, { roleId: senderId, tenantId, name: "Sender Bot", title: "Sender" });
        await createRole({ connectionString: connectionString! }, { roleId: recipientId, tenantId, name: "Recipient Bot", title: "Recipient" });

        const sent = await sendRoleMessage(
          { connectionString: connectionString! },
          { tenantId, fromRoleId: senderId, toRoleId: recipientId, body: "please review the draft" },
        );

        const results = await deliverPendingRoleMessages(options);
        const delivered = results.find((r) => r.messageId === sent.messageId);
        expect(delivered).toMatchObject({ messageId: sent.messageId, toRoleId: recipientId, outcome: "delivered" });
        expect(typeof delivered?.runId).toBe("string");
        const runId = delivered!.runId!;

        const tasks = await pool.query<{ task_id: string; goal: string }>(
          `SELECT task_id, goal FROM tasks WHERE tenant_id = $1 AND role_id = $2`,
          [tenantId, recipientId],
        );
        expect(tasks.rows).toHaveLength(1);
        expect(tasks.rows[0]!.goal).toBe("You have a message from Sender Bot: please review the draft");

        // Liveness check, not a mock: a real `runs` row and a real
        // `pgboss.job` row for WORKER_RUN_EXECUTION_JOB must exist for that
        // exact run (TASK-258's own precedent) — proves the enqueue really
        // happened rather than that some in-process function was merely
        // called.
        const runs = await pool.query<{ run_id: string }>(`SELECT run_id FROM runs WHERE task_id = $1`, [tasks.rows[0]!.task_id]);
        expect(runs.rows).toHaveLength(1);
        expect(runs.rows[0]!.run_id).toBe(runId);
        expect(await getRun({ connectionString: connectionString! }, runId)).not.toBeNull();

        const jobs = await pool.query<{ data: { runId: string } }>(
          `SELECT data FROM pgboss.job WHERE name = $1 AND data->>'runId' = $2`,
          [WORKER_RUN_EXECUTION_JOB, runId],
        );
        expect(jobs.rows).toHaveLength(1);

        const refetched = await pool.query<{ read_at: Date | null }>(
          `SELECT read_at FROM role_messages WHERE message_id = $1`,
          [sent.messageId],
        );
        expect(refetched.rows[0]!.read_at).not.toBeNull();

        // Idempotent: a second poll with nothing new pending delivers nothing more.
        const secondPass = await deliverPendingRoleMessages(options);
        expect(secondPass.find((r) => r.messageId === sent.messageId)).toBeUndefined();

        await purgePgBossQueue(pool, WORKER_RUN_EXECUTION_JOB);
      });
    }, 20_000);

    // Acceptance Criterion 3: "works identically on both provider lanes ...
    // confirm this explicitly rather than assuming it." The module
    // docstring documents *why* this is lane-agnostic by construction
    // (`task.goal` is consumed identically by `buildGeminiTurnPrompt` and
    // `claudePrintCommand` — read live in `chatRunDriver.ts`, not assumed);
    // this test confirms the half THIS module actually owns: that a
    // Gemini-provider recipient's `resolveRoleRuntime` result really
    // reaches the persisted run as `provider: 'gemini'` (the exact value
    // `chatRunDriver.ts`'s own `resolveChatRunExecution` branches lane
    // selection on) and that the delivered goal text is byte-identical to
    // the Claude-lane case above. `chatRunDriver.test.ts`'s own Gemini-lane
    // suite (TASK-220 and neighbours) already exhaustively covers what
    // happens once a Gemini run actually executes — this task's own
    // boundary is provider selection reaching the run, not re-proving that
    // driver's internals.
    it("selects the gemini lane for a gemini-provider recipient, with the identical delivered goal text", async () => {
      await withPgBossQueueLock(pool, async () => {
      const senderId = `task-273-sender-gemini-${crypto.randomUUID()}`;
      const recipientId = `task-273-recipient-gemini-${crypto.randomUUID()}`;
      await createRole({ connectionString: connectionString! }, { roleId: senderId, tenantId, name: "Sender Bot", title: "Sender" });
      await createRole({ connectionString: connectionString! }, { roleId: recipientId, tenantId, name: "Recipient Bot", title: "Recipient" });
      // NewRole has no `provider` field (set post-creation, matching
      // chatRunDriver.test.ts's own TASK-220 gemini-lane fixture).
      await pool.query(`UPDATE roles SET provider = 'gemini' WHERE role_id = $1`, [recipientId]);

      const sent = await sendRoleMessage(
        { connectionString: connectionString! },
        { tenantId, fromRoleId: senderId, toRoleId: recipientId, body: "please review the draft" },
      );

      const results = await deliverPendingRoleMessages(options);
      const delivered = results.find((r) => r.messageId === sent.messageId);
      expect(delivered?.outcome).toBe("delivered");

      const run = await getRun({ connectionString: connectionString! }, delivered!.runId!);
      expect(run?.provider).toBe("gemini");

      const tasks = await pool.query<{ goal: string }>(
        `SELECT goal FROM tasks WHERE tenant_id = $1 AND role_id = $2`,
        [tenantId, recipientId],
      );
      expect(tasks.rows[0]!.goal).toBe("You have a message from Sender Bot: please review the draft");
      });
    }, 20_000);

    it("skips (and does not mark read) a message addressed to a non-active (soft-deleted) recipient role", async () => {
      await withPgBossQueueLock(pool, async () => {
      // role_messages.to_role_id carries a REFERENCES roles(role_id) FK with
      // no ON DELETE action, so a hard-missing role can never actually be
      // the recipient of a pending message — the real, reachable case this
      // guards is a role whose status moved off "active" after the send.
      const senderId = `task-273-sender-missing-${crypto.randomUUID()}`;
      const deletedRoleId = `task-273-deleted-recipient-${crypto.randomUUID()}`;
      await createRole({ connectionString: connectionString! }, { roleId: senderId, tenantId, name: "Sender Bot", title: "Sender" });
      await createRole({ connectionString: connectionString! }, { roleId: deletedRoleId, tenantId, name: "Deleted Bot", title: "Deleted" });

      const sent = await sendRoleMessage(
        { connectionString: connectionString! },
        { tenantId, fromRoleId: senderId, toRoleId: deletedRoleId, body: "hello?" },
      );
      // Soft-delete AFTER the send, matching the real ordering this guards against.
      await createRole({ connectionString: connectionString! }, { roleId: deletedRoleId, tenantId, name: "Deleted Bot", title: "Deleted", status: "deleted" });

      const results = await deliverPendingRoleMessages(options);
      expect(results).toContainEqual({ messageId: sent.messageId, toRoleId: deletedRoleId, outcome: "skipped_no_role" });

      const refetched = await pool.query<{ read_at: Date | null }>(
        `SELECT read_at FROM role_messages WHERE message_id = $1`,
        [sent.messageId],
      );
      expect(refetched.rows[0]!.read_at).toBeNull();
      });
    }, 20_000);

    it("attributes only a manager's task.assigned handoff to its project, leaving a roster member's forged handoff ordinary (TASK-301)", async () => {
      await withPgBossQueueLock(pool, async () => {
      const managerId = `task-301-manager-${crypto.randomUUID()}`;
      const specialistId = `task-301-specialist-${crypto.randomUUID()}`;
      const forgedSenderId = `task-301-forged-${crypto.randomUUID()}`;
      await createRole({ connectionString: connectionString! }, { roleId: managerId, tenantId, name: "Manager", title: "Manager" });
      await createRole({ connectionString: connectionString! }, { roleId: specialistId, tenantId, name: "Specialist", title: "Specialist" });
      await createRole({ connectionString: connectionString! }, { roleId: forgedSenderId, tenantId, name: "Forged", title: "Specialist" });
      const threadId = (await pool.query<{ id: string }>(
        "INSERT INTO threads (role_id) VALUES ($1) RETURNING id", [managerId],
      )).rows[0]!.id;
      const project = await createProject({ connectionString: connectionString! }, {
        tenantId, threadId, name: "TASK-301 attribution", goal: "prove attribution", doneCriterion: "tests pass", createdBy: managerId,
      });
      await addProjectRoleMember({ connectionString: connectionString! }, { projectId: project.projectId, roleId: managerId, isManager: true });
      await addProjectRoleMember({ connectionString: connectionString! }, { projectId: project.projectId, roleId: specialistId });
      await addProjectRoleMember({ connectionString: connectionString! }, { projectId: project.projectId, roleId: forgedSenderId });
      const task = await createProjectTask({ connectionString: connectionString! }, {
        projectId: project.projectId, title: "handoff fixture", createdBy: managerId,
      });
      const ref = { project_id: project.projectId, task_id: task.taskId, artifact_ids: [] };

      const managerMessage = await sendRoleMessage({ connectionString: connectionString! }, {
        tenantId, fromRoleId: managerId, toRoleId: specialistId, body: "manager handoff", handoffKind: "task.assigned", factRef: ref,
      });
      const forgedMessage = await sendRoleMessage({ connectionString: connectionString! }, {
        tenantId, fromRoleId: forgedSenderId, toRoleId: specialistId, body: "forged handoff", handoffKind: "task.assigned", factRef: ref,
      });
      const delivered = await deliverPendingRoleMessages(options);
      const managerRun = await getRun({ connectionString: connectionString! }, delivered.find((r) => r.messageId === managerMessage.messageId)!.runId!);
      const forgedRun = await getRun({ connectionString: connectionString! }, delivered.find((r) => r.messageId === forgedMessage.messageId)!.runId!);
      const managerTask = await getTask({ connectionString: connectionString! }, managerRun!.taskId);
      const forgedTask = await getTask({ connectionString: connectionString! }, forgedRun!.taskId);
      expect(managerTask!.execution).toMatchObject({ kind: "chat", projectId: project.projectId });
      expect(forgedTask!.execution).toMatchObject({ kind: "chat" });
      expect((forgedTask!.execution as Record<string, unknown>).projectId).toBeUndefined();
      });
    }, 20_000);

    it("RoleMessageDeliveryPoller delivers via a real durable pg-boss schedule, immediate-poll triggered", async () => {
      await withPgBossQueueLock(pool, async () => {
        await purgePgBossQueue(pool, WORKER_ROLE_MESSAGE_DELIVERY_POLL_JOB);
        await purgePgBossQueue(pool, WORKER_RUN_EXECUTION_JOB);

        const senderId = `task-273-poller-sender-${crypto.randomUUID()}`;
        const recipientId = `task-273-poller-recipient-${crypto.randomUUID()}`;
        await createRole({ connectionString: connectionString! }, { roleId: senderId, tenantId, name: "Sender Bot", title: "Sender" });
        await createRole({ connectionString: connectionString! }, { roleId: recipientId, tenantId, name: "Recipient Bot", title: "Recipient" });
        const sent = await sendRoleMessage(
          { connectionString: connectionString! },
          { tenantId, fromRoleId: senderId, toRoleId: recipientId, body: "via the poller" },
        );

        const poller = createRoleMessageDeliveryPoller({ connectionString: connectionString!, tenantId });
        try {
          await poller.start();
          await poller.enqueuePollNow();

          let readAt: Date | null = null;
          for (let attempt = 0; attempt < 100; attempt += 1) {
            const refetched = await pool.query<{ read_at: Date | null }>(
              `SELECT read_at FROM role_messages WHERE message_id = $1`,
              [sent.messageId],
            );
            readAt = refetched.rows[0]?.read_at ?? null;
            if (readAt !== null) break;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          expect(readAt).not.toBeNull();
        } finally {
          await poller.stop();
        }

        await purgePgBossQueue(pool, WORKER_ROLE_MESSAGE_DELIVERY_POLL_JOB);
        await purgePgBossQueue(pool, WORKER_RUN_EXECUTION_JOB);
      });
    }, 20_000);

    // Acceptance Criterion 2 requires proof "from the recipient's own
    // actual behavior/reply in a live test, not from the sender's
    // acknowledgement alone, and not from a unit test with a mocked
    // delivery path". Every test above proves the mechanism is real up to
    // the enqueued `worker.run-execution` job (TASK-258's own accepted
    // liveness bar); this test goes one step further and actually DRIVES
    // that exact run through the real `createChatRunDriver` — the same
    // real-provider driver `chatRunDriver.test.ts` exercises with no
    // `queryFn` override — with `resume: { runId }`, mirroring exactly what
    // `main.ts`'s own `onRunExecution` handler does for a freshly-enqueued
    // run. The recipient bot's own real reply, not a scripted one, is what
    // gets asserted.
    it(
      "a real handoff genuinely reaches the recipient: its own real reply answers the sender's question",
      async () => {
        await withPgBossQueueLock(pool, async () => {
          await purgePgBossQueue(pool, WORKER_RUN_EXECUTION_JOB);

          const senderId = `task-273-live-sender-${crypto.randomUUID()}`;
          const recipientId = `task-273-live-recipient-${crypto.randomUUID()}`;
          await createRole({ connectionString: connectionString! }, { roleId: senderId, tenantId, name: "Alice", title: "Sender" });
          await createRole({ connectionString: connectionString! }, { roleId: recipientId, tenantId, name: "Recipient Bot", title: "Recipient" });

          const sent = await sendRoleMessage(
            { connectionString: connectionString! },
            {
              tenantId,
              fromRoleId: senderId,
              toRoleId: recipientId,
              body: "What is 7 plus 8? Reply with only the number, nothing else.",
            },
          );

          const results = await deliverPendingRoleMessages(options);
          const delivered = results.find((r) => r.messageId === sent.messageId);
          expect(delivered?.outcome).toBe("delivered");
          const runId = delivered!.runId!;

          const run = await getRun({ connectionString: connectionString! }, runId);
          expect(run).not.toBeNull();
          const task = await getTask({ connectionString: connectionString! }, run!.taskId);
          expect(task).not.toBeNull();
          expect(task!.execution).toMatchObject({ kind: "chat" });
          const threadId = (task!.execution as { threadId: string }).threadId;

          // Real driver, real provider — exactly `main.ts`'s own
          // `onRunExecution` resume path for a brand-new (no captured
          // session) run, not a mock or a scripted queryFn.
          const driver = createChatRunDriver({ connectionString: connectionString! });
          await driver.run({ task: task!, threadId, resume: { runId } });

          const finished = await getRun({ connectionString: connectionString! }, runId);
          expect(finished?.status).toBe("completed");

          const messages = await listMessages({ connectionString: connectionString! }, threadId);
          const reply = messages.find((message) => message.role === "bot" && message.runId === runId);
          expect(reply).toBeDefined();
          expect(reply?.body.length).toBeGreaterThan(0);
          // The recipient's OWN real behavior, not the sender's
          // acknowledgement: it actually answered the question the
          // delivered goal text carried (a genuinely fresh fact the
          // recipient could only have from this delivered turn).
          expect(reply?.body).toMatch(/15/);

          await purgePgBossQueue(pool, WORKER_RUN_EXECUTION_JOB);
        });
      },
      120_000,
    );
  });
}
