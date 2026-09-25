import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { defaultPoolConfig } from "@oikonomos/db";
import { mintBrokerToken } from "@oikonomos/broker";

import { buildApp, createDatabaseAutoReviewPort, type AutoReviewPort } from "./app.js";
import { buildSessionCookie, createSessionToken } from "./auth.js";
import { BROKER_PRE_TOOL_USE_PATH, buildDatabaseBrokerHttpApp } from "./brokerHttpRoute.js";
import type { ControlApiDeps } from "./ports.js";

const TOKEN = "task-350-token";
const ROLE_ID = "role-a";
const rule = {
  ruleId: "11111111-1111-1111-1111-111111111111", tenantId: "tenant-a", roleId: ROLE_ID,
  capabilityId: "shell.exec", targetPredicate: {}, enabled: true, createdBy: "auto-review", createdAt: new Date(),
};

function appWith(port: Partial<AutoReviewPort> = {}) {
  const autoReview: AutoReviewPort = {
    listRules: vi.fn(async () => [rule]),
    setEnabled: vi.fn(async () => [rule]),
    createRule: vi.fn(async () => ({ ...rule, createdBy: "manual" })),
    disableRule: vi.fn(async () => rule),
    ...port,
  };
  const deps = {
    listRoles: async ({ tenantId }: { tenantId: string }) => tenantId === "tenant-a" ? [{ roleId: ROLE_ID }] : [],
    listRoleGrants: async () => [{ roleId: ROLE_ID, capabilityId: "shell.exec", maxTier: "T1_draft", constraints: {} }],
  } as unknown as ControlApiDeps;
  return { app: buildApp(deps, { authToken: TOKEN, logger: false, autoReview }), autoReview };
}

const auth = { cookie: buildSessionCookie(createSessionToken(TOKEN, "tenant-a")) };

describe("TASK-350 auto-review routes", () => {
  it("gets, toggles, lists, creates and disables only through the supplied port", async () => {
    const { app, autoReview } = appWith();
    try {
      expect((await app.inject({ method: "GET", url: `/roles/${ROLE_ID}/auto-review`, headers: auth })).json()).toMatchObject({ enabled: true, rules: [{ createdBy: "auto-review" }] });
      expect((await app.inject({ method: "PUT", url: `/roles/${ROLE_ID}/auto-review`, headers: auth, payload: { enabled: false } })).statusCode).toBe(200);
      expect(autoReview.setEnabled).toHaveBeenCalledWith({ tenantId: "tenant-a", roleId: ROLE_ID, enabled: false });
      expect((await app.inject({ method: "GET", url: `/roles/${ROLE_ID}/review-rules`, headers: auth })).statusCode).toBe(200);
      expect((await app.inject({ method: "POST", url: `/roles/${ROLE_ID}/review-rules`, headers: auth, payload: { capabilityId: "shell.exec" } })).statusCode).toBe(201);
      expect((await app.inject({ method: "DELETE", url: `/roles/${ROLE_ID}/review-rules/${rule.ruleId}`, headers: auth })).statusCode).toBe(204);
    } finally { await app.close(); }
  });

  it("refuses every new route for a role outside the authenticated tenant", async () => {
    const { app, autoReview } = appWith();
    try {
      expect((await app.inject({ method: "GET", url: "/roles/other/auto-review", headers: auth })).statusCode).toBe(404);
      expect((await app.inject({ method: "PUT", url: "/roles/other/auto-review", headers: auth, payload: { enabled: true } })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: "/roles/other/review-rules", headers: auth })).statusCode).toBe(404);
      expect((await app.inject({ method: "POST", url: "/roles/other/review-rules", headers: auth, payload: { capabilityId: "shell.exec" } })).statusCode).toBe(404);
      expect((await app.inject({ method: "DELETE", url: `/roles/other/review-rules/${rule.ruleId}`, headers: auth })).statusCode).toBe(404);
      expect(autoReview.listRules).toHaveBeenCalledTimes(0);
    } finally { await app.close(); }
  });
});

const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

integration("TASK-350 Auto-review route-to-broker liveness", () => {
  const tenantId = `task-350-${randomUUID()}`;
  const roleId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();
  const signingKey = "task-350-live-broker-key";
  let pool: Pool;

  async function cleanup(): Promise<void> {
    await pool.query("DELETE FROM approvals WHERE run_id = $1", [runId]);
    await pool.query("DELETE FROM audit_events WHERE run_id = $1", [runId]);
    await pool.query("DELETE FROM runs WHERE run_id = $1", [runId]);
    await pool.query("DELETE FROM tasks WHERE task_id = $1", [taskId]);
    await pool.query("DELETE FROM require_approval_rules WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM role_grants WHERE role_id = $1", [roleId]);
    await pool.query("DELETE FROM roles WHERE role_id = $1", [roleId]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString!, ...defaultPoolConfig });
    await cleanup();
    await pool.query(
      `INSERT INTO capabilities (capability_id, description, default_tier, adapter, enabled)
       VALUES ('workspace.send_to_role', 'Send an asynchronous role handoff.', 'T1_draft', 'mcp:workspace', true)
       ON CONFLICT (capability_id) DO NOTHING`,
    );
    await pool.query(
      `INSERT INTO roles (role_id, tenant_id, name, title, description)
       VALUES ($1, $2, 'TASK-350 broker fixture', 'TASK-350 broker fixture', 'Broker liveness fixture')`,
      [roleId, tenantId],
    );
    await pool.query(
      `INSERT INTO role_grants (role_id, capability_id, max_tier, constraints)
       VALUES ($1, 'workspace.send_to_role', 'T1_draft', '{}'::jsonb)`,
      [roleId],
    );
    await pool.query(
      `INSERT INTO tasks (task_id, tenant_id, role_id, title, goal, requested_by)
       VALUES ($1, $2, $3, 'TASK-350 broker fixture', 'Exercise Auto-review', 'test:task-350')`,
      [taskId, tenantId, roleId],
    );
    await pool.query(
      `INSERT INTO runs (run_id, tenant_id, task_id, provider)
       VALUES ($1, $2, $3, 'claude')`,
      [runId, tenantId, taskId],
    );
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("requires approval while enabled and allows the same granted T1 action once disabled", async () => {
    const management = buildApp({
      listRoles: async ({ tenantId: requestedTenant }: { tenantId: string }) => {
        const result = await pool.query(
          "SELECT role_id AS \"roleId\" FROM roles WHERE tenant_id = $1 AND role_id = $2",
          [requestedTenant, roleId],
        );
        return result.rows;
      },
      listRoleGrants: async (requestedRoleId: string) => {
        const result = await pool.query(
          `SELECT role_id AS \"roleId\", capability_id AS \"capabilityId\", max_tier AS \"maxTier\", constraints
           FROM role_grants WHERE role_id = $1`,
          [requestedRoleId],
        );
        return result.rows;
      },
    } as unknown as ControlApiDeps, {
      authToken: signingKey,
      logger: false,
      autoReview: createDatabaseAutoReviewPort({ connectionString: connectionString! }),
    });
    const previousCapabilities = process.env.OIKONOMOS_CAPABILITIES_ENABLED;
    process.env.OIKONOMOS_CAPABILITIES_ENABLED = "true";
    const broker = await buildDatabaseBrokerHttpApp({ connectionString: connectionString! }, { signingKey });
    const session = { cookie: buildSessionCookie(createSessionToken(signingKey, tenantId)) };
    const brokerToken = mintBrokerToken({
      runId,
      roleId,
      tenantId,
      agentRef: { provider: "claude", sessionRef: "task-350-live", isSubagent: false },
    }, 60_000, signingKey);
    const preToolUse = (toolUseId: string) => broker.inject({
      method: "POST",
      url: BROKER_PRE_TOOL_USE_PATH,
      headers: { authorization: `Bearer ${brokerToken}` },
      payload: {
        toolUseId,
        runId,
        roleId,
        tenantId,
        toolName: "mcp__workspace__send_to_role",
        input: { toRoleId: "recipient", body: "Please review this." },
        agentRef: { provider: "claude", sessionRef: "task-350-live", isSubagent: false },
      },
    });

    try {
      // LIVENESS: removing the Auto-review rule write makes this first, real
      // broker decision allow, so the assertion cannot pass inertly.
      expect((await management.inject({
        method: "PUT", url: `/roles/${roleId}/auto-review`, headers: session, payload: { enabled: true },
      })).statusCode).toBe(200);
      expect((await preToolUse("task-350-auto-on")).json()).toMatchObject({
        decision: "deny", reason: "approval_pending",
      });

      expect((await management.inject({
        method: "PUT", url: `/roles/${roleId}/auto-review`, headers: session, payload: { enabled: false },
      })).statusCode).toBe(200);
      expect((await preToolUse("task-350-auto-off")).json()).toMatchObject({
        decision: "allow", tier: "T1_draft",
      });
    } finally {
      if (previousCapabilities === undefined) delete process.env.OIKONOMOS_CAPABILITIES_ENABLED;
      else process.env.OIKONOMOS_CAPABILITIES_ENABLED = previousCapabilities;
      await Promise.all([management.close(), broker.close()]);
    }
  });
});
