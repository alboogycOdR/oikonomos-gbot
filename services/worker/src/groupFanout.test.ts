import {
  createRole,
  createTask,
  defaultPoolConfig,
  getOrCreateThreadForRole,
  listMessages,
  type DatabaseOptions,
} from "@oikonomos/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CHAT_FANOUT_CAPABILITY_ID, deliverBotToBotMessage } from "./groupFanout.js";
import { startTaskRun } from "./runLifecycle.js";

const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

// TASK-122 (Chat-2c): the fan-out-approval rule, confirmed against the real
// Grok Bot reference product 2026-09-03 — a single 1:1 bot-to-bot message
// needs no human approval; fan-out to 2+ bots/a group does. Real Postgres,
// same evidentiary bar as chatRunDriver.test.ts's own liveness assertions:
// AC3's mutation-proof shape is satisfied because `deliverBotToBotMessage`'s
// only branch point is `toRoleIds.length > 1` — deleting that guard (so
// every call falls through to direct delivery) makes the fan-out case
// insert messages with zero pending approvals, reddening this suite's own
// "produces a pending approval" assertion below.
integration("deliverBotToBotMessage — fan-out approval rule (TASK-122)", () => {
  let pool: Pool;
  let options: DatabaseOptions;
  const fromRoleId = "task-122-fanout-sender";
  const toRoleIdA = "task-122-fanout-recipient-a";
  const toRoleIdB = "task-122-fanout-recipient-b";
  const allRoleIds = [fromRoleId, toRoleIdA, toRoleIdB];
  let runId: string;

  async function cleanup(): Promise<void> {
    await pool.query(
      `DELETE FROM approvals WHERE run_id IN (SELECT run_id FROM runs WHERE task_id IN (SELECT task_id FROM tasks WHERE role_id = $1))`,
      [fromRoleId],
    );
    await pool.query(
      `DELETE FROM messages WHERE thread_id IN (SELECT id FROM threads WHERE role_id = ANY($1::text[]))`,
      [allRoleIds],
    );
    await pool.query(
      `DELETE FROM runs WHERE task_id IN (SELECT task_id FROM tasks WHERE role_id = $1)`,
      [fromRoleId],
    );
    await pool.query(`DELETE FROM tasks WHERE role_id = $1`, [fromRoleId]);
    await pool.query(`DELETE FROM thread_members WHERE role_id = ANY($1::text[])`, [allRoleIds]);
    await pool.query(`DELETE FROM threads WHERE role_id = ANY($1::text[])`, [allRoleIds]);
    await pool.query(`DELETE FROM role_grants WHERE role_id = ANY($1::text[])`, [allRoleIds]);
    await pool.query(`DELETE FROM roles WHERE role_id = ANY($1::text[])`, [allRoleIds]);
    await pool.query(`DELETE FROM capabilities WHERE capability_id = $1`, [CHAT_FANOUT_CAPABILITY_ID]);
  }

  beforeAll(async () => {
    options = { connectionString: connectionString! };
    pool = new Pool({ connectionString: connectionString!, ...defaultPoolConfig });
    await cleanup();

    for (const roleId of allRoleIds) {
      await createRole(options, {
        roleId,
        name: roleId,
        title: "TASK-122 fan-out fixture role",
        description: "TASK-122 deliverBotToBotMessage integration fixture.",
      });
    }
    const task = await createTask(options, {
      roleId: fromRoleId,
      title: "TASK-122 fan-out fixture task",
      goal: "fixture task backing a real run for approvals.run_id's FK",
      requestedBy: "task-122-suite",
    });
    const run = await startTaskRun(options, { taskId: task.taskId, provider: "claude", tenantId: task.tenantId });
    runId = run.runId;
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("a single bot messaging exactly one other bot delivers immediately, no pending approval", async () => {
    const result = await deliverBotToBotMessage(options, {
      fromRoleId,
      toRoleIds: [toRoleIdA],
      body: "single-recipient delegation ping",
      runId,
    });
    expect(result.delivered).toBe(true);

    const thread = await getOrCreateThreadForRole(options, { roleId: toRoleIdA });
    const messages = await listMessages(options, thread.id);
    const delivered = messages.find((message) => message.body === "single-recipient delegation ping");
    expect(delivered).toBeDefined();
    expect(delivered?.senderRoleId).toBe(fromRoleId);

    const approvals = await pool.query<{ count: string }>(
      "SELECT count(*) FROM approvals WHERE run_id = $1 AND status = 'pending'",
      [runId],
    );
    expect(approvals.rows[0]!.count).toBe("0");
  });

  it("a bot messaging multiple bots/a group in one action produces a real pending approval instead of delivering", async () => {
    const result = await deliverBotToBotMessage(options, {
      fromRoleId,
      toRoleIds: [toRoleIdA, toRoleIdB],
      body: "fan-out ping that must not be sent yet",
      runId,
    });
    expect(result.delivered).toBe(false);
    if (result.delivered) throw new Error("unreachable");
    expect(result.approval.status).toBe("pending");

    const approvalRow = await pool.query<{ status: string; capability_id: string }>(
      "SELECT status, capability_id FROM approvals WHERE nonce = $1",
      [result.approval.nonce],
    );
    expect(approvalRow.rows[0]).toMatchObject({ status: "pending", capability_id: CHAT_FANOUT_CAPABILITY_ID });

    // Nothing was sent to either recipient — the gate ran before delivery.
    const threadA = await getOrCreateThreadForRole(options, { roleId: toRoleIdA });
    const threadB = await getOrCreateThreadForRole(options, { roleId: toRoleIdB });
    const [messagesA, messagesB] = await Promise.all([
      listMessages(options, threadA.id),
      listMessages(options, threadB.id),
    ]);
    expect(messagesA.some((message) => message.body === "fan-out ping that must not be sent yet")).toBe(false);
    expect(messagesB.some((message) => message.body === "fan-out ping that must not be sent yet")).toBe(false);
  });

  it("rejects an empty recipient list before touching the database", async () => {
    await expect(
      deliverBotToBotMessage(options, { fromRoleId, toRoleIds: [], body: "no recipients", runId }),
    ).rejects.toThrow(/at least one recipient/);
  });
});
