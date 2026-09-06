import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createRole, createSecretRequest, defaultPoolConfig, fulfillSecretRequest, getSecretRequest, type DatabaseOptions } from "./index.js";

const connectionString = process.env.DATABASE_URL;
const secretRequestsMigrated = connectionString === undefined ? false : await (async () => {
  const pool = new Pool({ connectionString, ...defaultPoolConfig });
  try {
    const result = await pool.query<{ exists: string | null }>("SELECT to_regclass('public.secret_requests') AS exists");
    return result.rows[0]?.exists !== null;
  } finally { await pool.end(); }
})();
const integration = secretRequestsMigrated ? describe : describe.skip;

integration("packages/db secret requests — metadata only (TASK-184)", () => {
  const tenantId = "task-184-secret-requests";
  const roleId = "task-184-secret-requests-role";
  const runId = "11111111-1111-4111-8111-111111111184";
  let pool: Pool;
  let options: DatabaseOptions;

  async function cleanup(): Promise<void> {
    await pool.query("DELETE FROM secret_requests WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM audit_events WHERE run_id = $1", [runId]);
    await pool.query("DELETE FROM runs WHERE run_id = $1", [runId]);
    await pool.query("DELETE FROM tasks WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM roles WHERE role_id = $1", [roleId]);
  }

  beforeAll(async () => {
    options = { connectionString: connectionString! };
    pool = new Pool({ connectionString: connectionString!, ...defaultPoolConfig });
    await cleanup();
    await createRole(options, { roleId, tenantId, name: "Secret requests", title: "Secret requests" });
    const task = await pool.query<{ task_id: string }>("INSERT INTO tasks (tenant_id, role_id, title, goal, requested_by) VALUES ($1, $2, 'secret request', 'secret request', 'test') RETURNING task_id", [tenantId, roleId]);
    await pool.query("INSERT INTO runs (run_id, task_id, tenant_id, provider) VALUES ($1, $2, $3, 'test')", [runId, task.rows[0]!.task_id, tenantId]);
  });

  afterAll(async () => { await cleanup(); await pool.end(); });

  it("persists request metadata and fulfils it with only an opaque ref", async () => {
    const created = await createSecretRequest(options, { tenantId, roleId, runId, label: "API token", purpose: "call the release API" });
    expect(created).toMatchObject({ tenantId, roleId, runId, status: "pending", secretRef: null });
    const fulfilled = await fulfillSecretRequest(options, created.requestId, "secret://11111111-1111-4111-8111-111111111192");
    expect(fulfilled).toMatchObject({ status: "fulfilled", secretRef: "secret://11111111-1111-4111-8111-111111111192", fulfilledAt: expect.any(Date) });
    expect(await getSecretRequest(options, created.requestId)).toEqual(fulfilled);
  });

  it("rejects values where a ref is expected", async () => {
    await expect(createSecretRequest(options, { tenantId, roleId, runId, label: " ", purpose: "p" })).rejects.toThrow(/label/);
  });
});
