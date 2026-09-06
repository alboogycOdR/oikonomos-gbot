// TASK-119 (Grants-1c) — `Database.revokeRoleGrant` against real Postgres.
// listRoleGrants/upsertRoleGrant already had integration coverage via
// capabilities.test.ts's connector-registration suite; this file is the
// dedicated home for `Database`'s own grant-lifecycle methods (list,
// upsert, revoke) so the DELETE precision requirement (AC1) has a direct
// test, not one only reachable through the connector registration path.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closeSharedPools,
  getSharedPool,
  withPool,
} from "./database.js";
import { Database, defaultPoolConfig } from "./index.js";

describe("shared accessor pool (TASK-199)", () => {
  afterAll(async () => {
    await closeSharedPools();
  });

  it("reuses one Pool across withPool calls with equivalent DatabaseOptions", async () => {
    const options = { connectionString: "postgres://task-199-shared/db" };
    const seen: Pool[] = [];
    await withPool(options, async (pool) => {
      seen.push(pool);
    });
    await withPool({ connectionString: "postgres://task-199-shared/db" }, async (pool) => {
      seen.push(pool);
    });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
    expect(getSharedPool(options)).toBe(seen[0]);
    expect(seen[0]?.ended).toBe(false);
  });

  it("does not share pools that differ in poolConfig.max", () => {
    const connectionString = "postgres://task-199-shared-max/db";
    const a = getSharedPool({ connectionString, poolConfig: { max: 1 } });
    const b = getSharedPool({ connectionString, poolConfig: { max: 2 } });
    expect(a).not.toBe(b);
  });

  it("rejects an empty connection string before opening a pool", () => {
    expect(() => getSharedPool({ connectionString: "   " })).toThrow(/connectionString/);
  });

  it("closeSharedPools ends cached pools so a later lookup constructs a new one", async () => {
    const options = { connectionString: "postgres://task-199-shared-end/db" };
    const first = getSharedPool(options);
    await closeSharedPools();
    expect(first.ended).toBe(true);
    const second = getSharedPool(options);
    expect(second).not.toBe(first);
    expect(second.ended).toBe(false);
  });

  it("accessor modules do not construct their own Pool (liveness)", async () => {
    const srcDir = path.dirname(fileURLToPath(import.meta.url));
    const files = (await readdir(srcDir)).filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && name !== "database.ts",
    );
    const offenders: string[] = [];
    for (const name of files) {
      const src = await readFile(path.join(srcDir, name), "utf8");
      if (/new Pool\s*\(/.test(src)) {
        offenders.push(name);
      }
    }
    expect(offenders).toEqual([]);
  });
});

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

integration("Database capability enable switches (TASK-140)", () => {
  let pool: Pool;
  let database: Database;
  const capabilityA = "task-140.database-switch.a";
  const capabilityB = "task-140.database-switch.b";

  async function cleanup(): Promise<void> {
    await pool.query(`DELETE FROM capabilities WHERE capability_id = ANY($1)`, [[capabilityA, capabilityB]]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString!, ...defaultPoolConfig });
    database = new Database({ connectionString: connectionString! });
    await cleanup();
    for (const capabilityId of [capabilityA, capabilityB]) {
      await database.upsertCapability({
        capabilityId,
        description: "TASK-140 database enable-switch fixture",
        defaultTier: "T0_observe",
        adapter: "mcp:task-140-database-switch",
        enabled: true,
      });
    }
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
    await database.close();
  });

  it("flips exactly one capability without changing another capability", async () => {
    await database.setCapabilityEnabled(capabilityA, false);

    await expect(database.getCapability(capabilityA)).resolves.toMatchObject({ enabled: false });
    await expect(database.getCapability(capabilityB)).resolves.toMatchObject({ enabled: true });
    await expect(database.setCapabilityEnabled("task-140.database-switch.absent", false)).resolves.toBeNull();
  });

  it("flips every registered capability platform-wide", async () => {
    await database.setCapabilityEnabled(capabilityA, true);
    await database.setCapabilityEnabled(capabilityB, true);

    const before = await database.listCapabilities();
    try {
      await expect(database.setAllCapabilitiesEnabled(false)).resolves.toBe(before.length);
      const disabled = await database.listCapabilities();
      expect(disabled.every((capability) => capability.enabled === false)).toBe(true);
    } finally {
      await Promise.all(before.map((capability) =>
        database.setCapabilityEnabled(capability.capabilityId, capability.enabled),
      ));
    }
  });
});
