import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createRole, defaultPoolConfig, getOrCreateThreadForRole, insertMessage } from "./index.js";
import {
  getLatestThreadSummary,
  getOrInitThreadContext,
  insertThreadSummary,
  startFreshEpoch,
  updateThreadContext,
} from "./threadContext.js";

const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

integration("packages/db threadContext — meter, summaries, epoch (TASK-179)", () => {
  let pool: Pool;
  const tenantId = "task-179-thread-context-suite";
  const roleId = "task-179-thread-context-suite-role";
  let threadId: string;

  async function cleanup(): Promise<void> {
    await pool.query("DELETE FROM thread_summaries WHERE thread_id IN (SELECT id FROM threads WHERE role_id = $1)", [roleId]);
    await pool.query("DELETE FROM thread_context WHERE thread_id IN (SELECT id FROM threads WHERE role_id = $1)", [roleId]);
    await pool.query("DELETE FROM messages WHERE thread_id IN (SELECT id FROM threads WHERE role_id = $1)", [roleId]);
    await pool.query("DELETE FROM thread_members WHERE thread_id IN (SELECT id FROM threads WHERE role_id = $1)", [roleId]);
    await pool.query("DELETE FROM threads WHERE role_id = $1", [roleId]);
    await pool.query("DELETE FROM roles WHERE role_id = $1", [roleId]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString!, ...defaultPoolConfig });
    await cleanup();
    await createRole(
      { connectionString: connectionString! },
      { roleId, tenantId, name: "Thread Context Suite", title: "Thread Context Suite Role" },
    );
    threadId = (await getOrCreateThreadForRole({ connectionString: connectionString! }, { roleId })).id;
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("lazily initializes a thread_context row with the documented defaults", async () => {
    const context = await getOrInitThreadContext({ connectionString: connectionString! }, threadId);
    expect(context).toMatchObject({
      threadId,
      contextTokens: 0,
      contextLimit: 8000,
      compactedThroughMessageId: null,
      epoch: 0,
    });

    // Idempotent: a second call does not reset an already-measured row.
    await updateThreadContext({ connectionString: connectionString! }, threadId, { contextTokens: 42 });
    const again = await getOrInitThreadContext({ connectionString: connectionString! }, threadId);
    expect(again.contextTokens).toBe(42);
  });

  it("persists a summary and advances compacted_through_message_id via updateThreadContext", async () => {
    const message = await insertMessage(
      { connectionString: connectionString! },
      { threadId, role: "user", body: "message to be summarized" },
    );

    const summary = await insertThreadSummary(
      { connectionString: connectionString! },
      { threadId, epoch: 0, coversThroughMessageId: message.id, body: "A summary of earlier turns." },
    );
    expect(summary.body).toBe("A summary of earlier turns.");

    const latest = await getLatestThreadSummary({ connectionString: connectionString! }, threadId, 0);
    expect(latest?.summaryId).toBe(summary.summaryId);

    const updated = await updateThreadContext({ connectionString: connectionString! }, threadId, {
      contextTokens: 10,
      compactedThroughMessageId: message.id,
    });
    expect(updated.compactedThroughMessageId).toBe(message.id);
    expect(updated.contextTokens).toBe(10);
  });

  it("startFreshEpoch increments the epoch and resets the meter without deleting summaries", async () => {
    const before = await getOrInitThreadContext({ connectionString: connectionString! }, threadId);
    const after = await startFreshEpoch({ connectionString: connectionString! }, threadId);
    expect(after.epoch).toBe(before.epoch + 1);
    expect(after.contextTokens).toBe(0);
    expect(after.compactedThroughMessageId).toBeNull();

    // The pre-fresh epoch's summary still exists — startFreshEpoch never deletes rows.
    const oldEpochSummary = await getLatestThreadSummary({ connectionString: connectionString! }, threadId, before.epoch);
    expect(oldEpochSummary).not.toBeNull();

    // The new epoch has no summary of its own yet.
    const newEpochSummary = await getLatestThreadSummary({ connectionString: connectionString! }, threadId, after.epoch);
    expect(newEpochSummary).toBeNull();
  });

  it("getLatestThreadSummary returns the most recently created row for an epoch with multiple summaries", async () => {
    const context = await startFreshEpoch({ connectionString: connectionString! }, threadId);
    const first = await insertMessage({ connectionString: connectionString! }, { threadId, role: "user", body: "first" });
    const second = await insertMessage({ connectionString: connectionString! }, { threadId, role: "user", body: "second" });

    await insertThreadSummary(
      { connectionString: connectionString! },
      { threadId, epoch: context.epoch, coversThroughMessageId: first.id, body: "first summary" },
    );
    const newest = await insertThreadSummary(
      { connectionString: connectionString! },
      { threadId, epoch: context.epoch, coversThroughMessageId: second.id, body: "second summary" },
    );

    const latest = await getLatestThreadSummary({ connectionString: connectionString! }, threadId, context.epoch);
    expect(latest?.summaryId).toBe(newest.summaryId);
    expect(latest?.body).toBe("second summary");
  });
});
