import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createGroupThread, createRole, defaultPoolConfig, getWorkforceEventCounts, insertAuditEvent, insertMessage, listMessages } from "@oikonomos/db";
import { Pool } from "pg";

import { runWorkforceCheck, WORKFORCE_ALERT_EVENT_TYPE } from "./workforceChecker.js";
import { runWorker } from "./main.js";
import { purgePgBossQueue, withPgBossQueueLock } from "./jobs/pgBossTestCleanup.js";
import { WORKER_HEARTBEAT_JOB, WORKER_ROUTINE_POLL_JOB, WORKER_RUN_EXECUTION_JOB } from "./jobs/workerJobQueue.js";

const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

integration("runWorkforceCheck (TASK-363)", () => {
  const tenantId = `task-363-${randomUUID()}`;
  const otherTenantId = `task-363-other-${randomUUID()}`;
  const alpha = `task-363-alpha-${randomUUID()}`;
  const beta = `task-363-beta-${randomUUID()}`;
  let pool: Pool;
  let groupThreadId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString!, ...defaultPoolConfig });
    const db = { connectionString: connectionString! };
    await createRole(db, { tenantId, roleId: alpha, name: "Workforce Alpha", title: "Alpha" });
    await createRole(db, { tenantId, roleId: beta, name: "Workforce Beta", title: "Beta" });
    const group = await createGroupThread(db, { roleIds: [alpha, beta], title: "TASK-363" });
    groupThreadId = group.id;
  });

  afterAll(async () => {
    await pool.query("DELETE FROM audit_events WHERE tenant_id IN ($1, $2)", [tenantId, otherTenantId]);
    await pool.query("DELETE FROM role_messages WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM messages WHERE thread_id = $1", [groupThreadId]);
    await pool.query("DELETE FROM thread_members WHERE thread_id = $1", [groupThreadId]);
    await pool.query("DELETE FROM threads WHERE id = $1", [groupThreadId]);
    await pool.query("DELETE FROM threads WHERE role_id IN ($1, $2)", [alpha, beta]);
    await pool.query("DELETE FROM roles WHERE role_id IN ($1, $2)", [alpha, beta]);
    await pool.end();
  });

  it("does nothing below threshold, then posts exactly one category-only alert per source each hour", async () => {
    const db = { connectionString: connectionString! };
    const now = new Date();
    for (let index = 0; index < 2; index += 1) {
      await insertAuditEvent(db, { tenantId, actor: "system:group-routing", eventType: "group.cap_reached", at: now, payload: { threadId: groupThreadId, reason: "round_cap" } });
    }
    for (let index = 0; index < 3; index += 1) {
      await insertAuditEvent(db, { tenantId: otherTenantId, actor: "system:group-routing", eventType: "group.cap_reached", at: now, payload: { threadId: groupThreadId, reason: "round_cap" } });
    }

    await expect(runWorkforceCheck({ ...db, tenantId }, now)).resolves.toBe(0);
    expect((await listMessages(db, groupThreadId)).filter((message) => message.body.startsWith("Workforce checker:"))).toHaveLength(0);

    await insertAuditEvent(db, { tenantId, actor: "system:group-routing", eventType: "group.cap_reached", at: now, payload: { threadId: groupThreadId, reason: "round_cap" } });
    const throwingProvider = vi.fn(() => { throw new Error("a model provider must not run"); });
    await expect(runWorkforceCheck({ ...db, tenantId, modelProvider: throwingProvider } as never, now)).resolves.toBe(1);
    expect(throwingProvider).not.toHaveBeenCalled();
    const notices = (await listMessages(db, groupThreadId)).filter((message) => message.body.startsWith("Workforce checker:"));
    expect(notices).toHaveLength(1);
    expect(notices[0]?.body).toContain("group.cap_reached observed 3");
    const alerts = await pool.query<{ payload: { category: string; count: number } }>("SELECT payload FROM audit_events WHERE tenant_id = $1 AND event_type = $2", [tenantId, WORKFORCE_ALERT_EVENT_TYPE]);
    expect(alerts.rows).toEqual([{ payload: { category: "group.cap_reached", count: 3 } }]);

    // LIVENESS: removing either the threshold comparison or the hourly guard
    // makes one of these exact-count assertions fail.
    await expect(runWorkforceCheck({ ...db, tenantId }, now)).resolves.toBe(0);
    expect((await listMessages(db, groupThreadId)).filter((message) => message.body.startsWith("Workforce checker:"))).toHaveLength(1);
  });

  it("returns tenant-scoped terminal-delivery and room-message counts", async () => {
    const db = { connectionString: connectionString! };
    const now = new Date();
    await insertMessage(db, { threadId: groupThreadId, role: "user", body: "check room count" });
    await pool.query("INSERT INTO role_messages (tenant_id, from_role_id, to_role_id, body, delivery_failed_at) VALUES ($1, $2, $3, 'terminal fixture', now())", [tenantId, alpha, beta]);
    const counts = await getWorkforceEventCounts(db, { tenantId, since: new Date(now.getTime() - 60_000) });
    expect(counts).toEqual(expect.arrayContaining([
      { category: "role_message.delivery_failed", sourceId: alpha, count: 1 },
      expect.objectContaining({ category: "group.message_count", sourceId: groupThreadId }),
    ]));
  });

  it("runs from the worker's existing maintenance poll", async () => {
    const workerTenantId = `task-363-worker-${randomUUID()}`;
    const workerAlpha = `task-363-worker-alpha-${randomUUID()}`;
    const workerBeta = `task-363-worker-beta-${randomUUID()}`;
    const db = { connectionString: connectionString! };
    await createRole(db, { tenantId: workerTenantId, roleId: workerAlpha, name: "Poll Alpha", title: "Alpha" });
    await createRole(db, { tenantId: workerTenantId, roleId: workerBeta, name: "Poll Beta", title: "Beta" });
    const group = await createGroupThread(db, { roleIds: [workerAlpha, workerBeta], title: "TASK-363 poll" });
    try {
      for (let index = 0; index < 3; index += 1) {
        await insertAuditEvent(db, { tenantId: workerTenantId, actor: "system:group-routing", eventType: "group.cap_reached", payload: { threadId: group.id, reason: "round_cap" } });
      }
      await withPgBossQueueLock(pool, async () => {
        await purgePgBossQueue(pool, WORKER_HEARTBEAT_JOB);
        await purgePgBossQueue(pool, WORKER_ROUTINE_POLL_JOB);
        await purgePgBossQueue(pool, WORKER_RUN_EXECUTION_JOB);
        const worker = await runWorker({
          connectionString: connectionString!, tenantId: workerTenantId, workforceCheckIntervalMs: 60_000,
          reconcileFilter: { taskId: "00000000-0000-0000-0000-000000000000" },
        });
        try {
          let posted = false;
          for (let attempt = 0; attempt < 50 && !posted; attempt += 1) {
            posted = (await listMessages(db, group.id)).some((message) => message.body.startsWith("Workforce checker:"));
            if (!posted) await delay(20);
          }
          // LIVENESS: removing main.ts's `void workforce()` wiring leaves
          // this initial maintenance poll without a notice.
          expect(posted).toBe(true);
        } finally { await worker.stop(); }
      });
    } finally {
      await pool.query("DELETE FROM audit_events WHERE tenant_id = $1", [workerTenantId]);
      await pool.query("DELETE FROM messages WHERE thread_id = $1", [group.id]);
      await pool.query("DELETE FROM thread_members WHERE thread_id = $1", [group.id]);
      await pool.query("DELETE FROM threads WHERE id = $1", [group.id]);
      await pool.query("DELETE FROM roles WHERE role_id IN ($1, $2)", [workerAlpha, workerBeta]);
    }
  }, 20_000);
});
