// TASK-119 (Grants-1c) — `Database.revokeRoleGrant` against real Postgres.
// listRoleGrants/upsertRoleGrant already had integration coverage via
// capabilities.test.ts's connector-registration suite; this file is the
// dedicated home for `Database`'s own grant-lifecycle methods (list,
// upsert, revoke) so the DELETE precision requirement (AC1) has a direct
// test, not one only reachable through the connector registration path.
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Database, defaultPoolConfig } from "./index.js";

const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

integration("Database role grants — list/upsert/revoke (TASK-119)", () => {
  let pool: Pool;
  let database: Database;
  const roleId = "task-119-grants-suite-role";
  const tenantId = "task-119-grants-suite";
  const capabilityA = "task-119.grants-suite.capability-a";
  const capabilityB = "task-119.grants-suite.capability-b";

  async function cleanup(): Promise<void> {
    await pool.query(`DELETE FROM role_grants WHERE role_id = $1`, [roleId]);
    await pool.query(`DELETE FROM roles WHERE role_id = $1`, [roleId]);
    await pool.query(`DELETE FROM capabilities WHERE capability_id = ANY($1)`, [
      [capabilityA, capabilityB],
    ]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString!, ...defaultPoolConfig });
    database = new Database({ connectionString: connectionString! });
    await cleanup();
    // role_grants.role_id FKs to roles, and role_grants.capability_id FKs
    // to capabilities — both must exist before a grant can reference them.
    await pool.query(
      `INSERT INTO roles (role_id, tenant_id, name, title, description, status)
       VALUES ($1, $2, 'TASK-119 grants suite', 'TASK-119 grants suite', 'fixture', 'active')
       ON CONFLICT (role_id) DO NOTHING`,
      [roleId, tenantId],
    );
    for (const capabilityId of [capabilityA, capabilityB]) {
      await pool.query(
        `INSERT INTO capabilities (capability_id, description, default_tier, adapter, enabled)
         VALUES ($1, 'TASK-119 grants suite fixture', 'T0_observe', 'sdk:builtin', true)
         ON CONFLICT (capability_id) DO NOTHING`,
        [capabilityId],
      );
    }
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
    await database.close();
  });

  it("upserts and lists grants for a role, tenant/role scoped by id", async () => {
    await database.upsertRoleGrant({
      roleId,
      capabilityId: capabilityA,
      maxTier: "T1_draft",
      constraints: {},
    });
    await database.upsertRoleGrant({
      roleId,
      capabilityId: capabilityB,
      maxTier: "T2_internal",
      constraints: {},
    });

    const grants = await database.listRoleGrants(roleId);
    expect(grants).toHaveLength(2);
    expect(grants.map((g) => g.capabilityId).sort()).toEqual([capabilityA, capabilityB].sort());
  });

  it("revokeRoleGrant deletes exactly the targeted (role_id, capability_id) row and no other", async () => {
    await database.upsertRoleGrant({
      roleId,
      capabilityId: capabilityA,
      maxTier: "T1_draft",
      constraints: {},
    });
    await database.upsertRoleGrant({
      roleId,
      capabilityId: capabilityB,
      maxTier: "T2_internal",
      constraints: {},
    });

    await database.revokeRoleGrant(roleId, capabilityA);

    const remaining = await database.listRoleGrants(roleId);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.capabilityId).toBe(capabilityB);

    const revoked = await database.getRoleGrant(roleId, capabilityA);
    expect(revoked).toBeNull();
  });

  it("revoking an already-absent grant is a no-op, not an error", async () => {
    await expect(
      database.revokeRoleGrant(roleId, "task-119.grants-suite.never-granted"),
    ).resolves.toBeUndefined();
  });
});
