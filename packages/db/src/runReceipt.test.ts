import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { defaultPoolConfig } from "./database.js";
import { getRunReceipt } from "./runReceipt.js";

describe("getRunReceipt (TASK-242)", () => {
  it("rejects invalid identifiers before opening a database connection", async () => {
    await expect(getRunReceipt({ connectionString: "postgres://unused.invalid/test" }, { runId: "not-a-uuid", tenantId: "tenant" })).rejects.toThrow(/runId/);
    await expect(getRunReceipt({ connectionString: "postgres://unused.invalid/test" }, { runId: randomUUID(), tenantId: " " })).rejects.toThrow(/tenantId/);
  });
});

const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

integration("getRunReceipt against real Postgres (TASK-242)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString!, ...defaultPoolConfig, max: 1 });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("projects final bot output, audit actions, approval states and actual spend without estimating", async () => {
    const tenantId = `task-242-${randomUUID()}`;
    const roleId = `task-242-role-${randomUUID()}`;
    const taskId = randomUUID();
    const runId = randomUUID();
    const threadId = randomUUID();
    const capabilityId = `task-242-capability-${randomUUID()}`;
    try {
      await pool.query("INSERT INTO roles (role_id, tenant_id, name, title, description, status) VALUES ($1, $2, 'Receipt bot', 'Receipt bot', '', 'active')", [roleId, tenantId]);
      await pool.query("INSERT INTO tasks (task_id, tenant_id, role_id, title, goal, requested_by) VALUES ($1, $2, $3, 'Receipt fixture', 'Test receipt', 'test')", [taskId, tenantId, roleId]);
      await pool.query("INSERT INTO runs (run_id, task_id, tenant_id, provider, status, started_at, ended_at) VALUES ($1, $2, $3, 'test', 'completed', '2026-09-12T10:00:00Z', '2026-09-12T10:01:00Z')", [runId, taskId, tenantId]);
      await pool.query("INSERT INTO threads (id, role_id, title) VALUES ($1, $2, 'Receipt fixture')", [threadId, roleId]);
      await pool.query("INSERT INTO messages (thread_id, role, body, run_id, created_at) VALUES ($1, 'bot', 'Older result', $2, '2026-09-12T10:00:10Z'), ($1, 'bot', 'Final result', $2, '2026-09-12T10:00:20Z')", [threadId, runId]);
      await pool.query("INSERT INTO capabilities (capability_id, description, default_tier, adapter) VALUES ($1, 'Receipt fixture', 'T3_external', 'test')", [capabilityId]);
      await pool.query("INSERT INTO audit_events (tenant_id, run_id, actor, event_type, capability, tier, payload) VALUES ($1, $2, 'broker', 'policy.decision', $3, 'T3_external', '{\"verdict\":\"require_approval\",\"reason\":\"policy.requires_approval\"}')", [tenantId, runId, capabilityId]);
      await pool.query("INSERT INTO approvals (tenant_id, run_id, capability_id, action_digest, action_render, destination, nonce, status, expires_at) VALUES ($1, $2, $3, '\\x01', 'Send final report', 'ops@example.test', $4, 'granted', now() + interval '1 hour'), ($1, $2, $3, '\\x02', 'Send follow-up', 'ops@example.test', $5, 'pending', now() + interval '1 hour')", [tenantId, runId, capabilityId, randomUUID(), randomUUID()]);
      await pool.query("INSERT INTO spend_records (tenant_id, run_id, provider, model, cost_usd, tokens) VALUES ($1, $2, 'test', 'fixture', 0.010000, 100), ($1, $2, 'test', 'fixture', 0.002000, 23)", [tenantId, runId]);

      const receipt = await getRunReceipt({ connectionString: connectionString! }, { runId, tenantId });
      expect(receipt).toMatchObject({
        run: { runId, status: "completed" },
        finalMessage: { body: "Final result" },
        actions: [{ capability: capabilityId, tier: "T3_external", verdict: "require_approval", reason: "policy.requires_approval" }],
        unresolvedApprovals: [{ actionRender: "Send follow-up", status: "pending" }],
        spend: { kind: "actual", costUsd: 0.012, tokens: 123 },
      });
      expect(receipt?.approvals).toEqual(expect.arrayContaining([
        expect.objectContaining({ actionRender: "Send final report", status: "granted" }),
        expect.objectContaining({ actionRender: "Send follow-up", status: "pending" }),
      ]));
      await expect(getRunReceipt({ connectionString: connectionString! }, { runId, tenantId: `${tenantId}-other` })).resolves.toBeNull();
    } finally {
      await pool.query("DELETE FROM spend_records WHERE run_id = $1", [runId]);
      await pool.query("DELETE FROM approvals WHERE run_id = $1", [runId]);
      await pool.query("DELETE FROM messages WHERE run_id = $1", [runId]);
      await pool.query("DELETE FROM threads WHERE id = $1", [threadId]);
      await pool.query("DELETE FROM runs WHERE run_id = $1", [runId]);
      await pool.query("DELETE FROM tasks WHERE task_id = $1", [taskId]);
      await pool.query("DELETE FROM roles WHERE role_id = $1", [roleId]);
      await pool.query("DELETE FROM capabilities WHERE capability_id = $1", [capabilityId]);
    }
  });

  it("reports unavailable when the receipt has no spend rows", async () => {
    const tenantId = `task-242-${randomUUID()}`;
    const roleId = `task-242-role-${randomUUID()}`;
    const taskId = randomUUID();
    const runId = randomUUID();
    try {
      await pool.query("INSERT INTO roles (role_id, tenant_id, name, title, description, status) VALUES ($1, $2, 'Receipt bot', 'Receipt bot', '', 'active')", [roleId, tenantId]);
      await pool.query("INSERT INTO tasks (task_id, tenant_id, role_id, title, goal, requested_by) VALUES ($1, $2, $3, 'Receipt fixture', 'Test receipt', 'test')", [taskId, tenantId, roleId]);
      await pool.query("INSERT INTO runs (run_id, task_id, tenant_id, provider) VALUES ($1, $2, $3, 'test')", [runId, taskId, tenantId]);
      await expect(getRunReceipt({ connectionString: connectionString! }, { runId, tenantId })).resolves.toMatchObject({ spend: { kind: "unavailable" } });
    } finally {
      await pool.query("DELETE FROM runs WHERE run_id = $1", [runId]);
      await pool.query("DELETE FROM tasks WHERE task_id = $1", [taskId]);
      await pool.query("DELETE FROM roles WHERE role_id = $1", [roleId]);
    }
  });
});
