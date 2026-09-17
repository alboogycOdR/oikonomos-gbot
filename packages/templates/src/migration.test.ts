import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Real Postgres-backed test for the `role_template_installs` migration
 * (TASK-280's own Acceptance_Criteria: "Real Postgres-backed test for the
 * new migration; pure unit tests for everything else"). This package has
 * no `packages/db` accessor layer of its own -- `packages/db` is outside
 * this task's `Owned_Paths` -- so this file talks to Postgres directly with
 * its own short-lived `pg.Pool`, the same pattern `packages/db/src/
 * threads.test.ts` uses for its own migration-shape and round-trip
 * assertions (a `.test.ts` file is exempt from the "accessor modules never
 * construct their own Pool" liveness rule; only real accessor modules are
 * bound by it).
 *
 * Skipped entirely when `DATABASE_URL` is unset, same gate every other real
 * Postgres suite in this repo uses.
 */
const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;
const migrationDirectory = fileURLToPath(new URL("../../../infra/postgres/migrations/", import.meta.url));

integration("packages/templates -- role_template_installs migration (TASK-280)", () => {
  let pool: Pool;
  const tenantId = "task-280-role-template-installs-suite";
  const roleId = "task-280-rti-suite-role";

  async function cleanup(): Promise<void> {
    await pool.query("DELETE FROM role_template_installs WHERE role_id = $1", [roleId]);
    await pool.query("DELETE FROM bot_templates WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM roles WHERE role_id = $1", [roleId]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString! });
    // Idempotent (CREATE TABLE IF NOT EXISTS) -- safe even when -Init has
    // already applied every migration in the isolated test database.
    const up = await readFile(`${migrationDirectory}028_role_template_installs.up.sql`, "utf8");
    await pool.query(up);
    await cleanup();
    await pool.query(
      `INSERT INTO roles (role_id, tenant_id, name, title) VALUES ($1, $2, 'Suite', 'Suite')
       ON CONFLICT (role_id) DO NOTHING`,
      [roleId, tenantId],
    );
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("creates role_template_installs with exactly the spec's columns (§4)", async () => {
    const columns = await pool.query<{ column_name: string; data_type: string; is_nullable: string }>(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'role_template_installs'
       ORDER BY ordinal_position`,
    );
    expect(columns.rows).toEqual([
      { column_name: "role_id", data_type: "text", is_nullable: "NO" },
      { column_name: "template_id", data_type: "uuid", is_nullable: "NO" },
      { column_name: "version", data_type: "integer", is_nullable: "NO" },
      { column_name: "digest", data_type: "text", is_nullable: "NO" },
      { column_name: "installed_at", data_type: "timestamp with time zone", is_nullable: "NO" },
      { column_name: "baseline_manifest", data_type: "jsonb", is_nullable: "YES" },
    ]);
  });

  it("rejects an insert whose role_id does not reference an existing role (FK to roles)", async () => {
    await expect(
      pool.query(
        `INSERT INTO role_template_installs (role_id, template_id, version, digest)
         VALUES ($1, '11111111-1111-1111-1111-111111111111', 1, 'd')`,
        ["task-280-nonexistent-role"],
      ),
    ).rejects.toThrow();
  });

  it("rejects an insert whose (template_id, version) does not exist in bot_templates", async () => {
    await expect(
      pool.query(
        `INSERT INTO role_template_installs (role_id, template_id, version, digest)
         VALUES ($1, '22222222-2222-2222-2222-222222222222', 1, 'd')`,
        [roleId],
      ),
    ).rejects.toThrow();
  });

  it("accepts an insert once both parents exist, and enforces role_id as the primary key", async () => {
    const created = await pool.query<{ template_id: string; version: number }>(
      `INSERT INTO bot_templates (template_id, version, tenant_id, name, manifest, digest, created_by)
       VALUES (gen_random_uuid(), 1, $1, 'T', '{}'::jsonb, 'digest-1', 'human:1')
       RETURNING template_id, version`,
      [tenantId],
    );
    const { template_id: templateId, version } = created.rows[0]!;

    await pool.query(
      `INSERT INTO role_template_installs (role_id, template_id, version, digest)
       VALUES ($1, $2, $3, 'digest-1')`,
      [roleId, templateId, version],
    );

    const row = await pool.query<{ template_id: string }>(
      `SELECT template_id FROM role_template_installs WHERE role_id = $1`,
      [roleId],
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]!.template_id).toBe(templateId);

    // role_id is the PRIMARY KEY: installing a second template for the same
    // role must fail rather than silently overwrite the install record.
    await expect(
      pool.query(
        `INSERT INTO role_template_installs (role_id, template_id, version, digest)
         VALUES ($1, $2, $3, 'digest-2')`,
        [roleId, templateId, version],
      ),
    ).rejects.toThrow();
  });

  // Dropping and recreating a real table is unsafe to run unconditionally
  // under the full recursive suite's concurrent, cross-package execution
  // (packages/db/src/threads.test.ts's own MIGRATION_ROUND_TRIP gate sets
  // this precedent) -- opt in explicitly with MIGRATION_ROUND_TRIP=1.
  const roundTrip = process.env.MIGRATION_ROUND_TRIP === "1" ? it : it.skip;
  roundTrip("down cleanly removes role_template_installs; up recreates it", async () => {
    await cleanup();
    const down = await readFile(`${migrationDirectory}028_role_template_installs.down.sql`, "utf8");
    await pool.query(down);
    const absent = await pool.query<{ t: string | null }>("SELECT to_regclass('public.role_template_installs') AS t");
    expect(absent.rows[0]).toEqual({ t: null });

    const up = await readFile(`${migrationDirectory}028_role_template_installs.up.sql`, "utf8");
    await pool.query(up);
    const present = await pool.query<{ t: string | null }>("SELECT to_regclass('public.role_template_installs') AS t");
    expect(present.rows[0]!.t).not.toBeNull();
  });
});
