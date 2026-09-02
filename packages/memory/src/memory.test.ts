import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { defaultPoolConfig } from "./database.js";
import { getAgentFact, getUserFact, readProfileTier, writeMemoryFact } from "./facts.js";
import { resolve } from "./resolve.js";

const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

integration("packages/memory — three scopes, three tiers, conflict order (TASK-085)", () => {
  let pool: Pool;
  // Dedicated tenantId so this suite never collides with fixture rows other
  // concurrently-running suites insert under the same DATABASE_URL — same
  // isolation pattern packages/db/src/roles.test.ts documents.
  const tenantId = "task-085-memory-suite";
  const roleA = "task-085-memory-suite-role-a";
  const roleB = "task-085-memory-suite-role-b";
  const projectId = "task-085-memory-suite-project";

  async function cleanup(): Promise<void> {
    await pool.query(`DELETE FROM profile_facts WHERE tenant_id = $1`, [tenantId]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString!, ...defaultPoolConfig });
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("migration 005: an agent-scope row with a null role_id is rejected by the CHECK constraint", async () => {
    await expect(
      pool.query(
        `INSERT INTO profile_facts (tenant_id, scope, role_id, key, value, source)
         VALUES ($1, 'agent', NULL, 'x', 'x', 'x')`,
        [tenantId],
      ),
    ).rejects.toThrow(/check/i);
  });

  it("resolve(): agent > project > user when all three scopes hold the same key", async () => {
    const opts = { connectionString: connectionString! };
    await writeMemoryFact(opts, {
      tenantId,
      scope: "user",
      key: "greeting",
      value: "user-value",
      source: "test",
    });
    await writeMemoryFact(opts, {
      tenantId,
      scope: "project",
      projectId,
      key: "greeting",
      value: "project-value",
      source: "test",
    });
    await writeMemoryFact(opts, {
      tenantId,
      scope: "agent",
      roleId: roleA,
      key: "greeting",
      value: "agent-value",
      source: "test",
    });

    const full = await resolve(opts, { tenantId, roleId: roleA, projectId }, "greeting");
    expect(full?.value).toBe("agent-value");

    const noAgent = await resolve(opts, { tenantId, projectId }, "greeting");
    expect(noAgent?.value).toBe("project-value");

    const neither = await resolve(opts, { tenantId }, "greeting");
    expect(neither?.value).toBe("user-value");
  });

  it("only the profile tier enters the every-turn reader; log and note rows are excluded", async () => {
    const opts = { connectionString: connectionString! };
    await writeMemoryFact(opts, {
      tenantId,
      scope: "agent",
      roleId: roleA,
      key: "profile-key",
      value: "p",
      source: "test",
      tier: "profile",
    });
    await writeMemoryFact(opts, {
      tenantId,
      scope: "agent",
      roleId: roleA,
      key: "log-key",
      value: "l",
      source: "test",
      tier: "log",
    });
    await writeMemoryFact(opts, {
      tenantId,
      scope: "agent",
      roleId: roleA,
      key: "note-key",
      value: "n",
      source: "test",
      tier: "note",
    });

    const rows = await readProfileTier(opts, { tenantId, roleId: roleA });
    const keys = rows.map((r) => r.key);
    expect(keys).toContain("profile-key");
    expect(keys).not.toContain("log-key");
    expect(keys).not.toContain("note-key");
  });

  it("a note row carries a default TTL and an expired note is not returned", async () => {
    const opts = { connectionString: connectionString! };
    const written = await writeMemoryFact(opts, {
      tenantId,
      scope: "user",
      key: "ttl-key",
      value: "v",
      source: "test",
      tier: "note",
    });
    expect(written.expiresAt).not.toBeNull();
    expect(written.expiresAt!.getTime()).toBeGreaterThan(Date.now());

    // Force it into the past directly (writeMemoryFact never accepts a
    // caller-supplied expiresAt — only a ttlMs — so this simulates the
    // passage of time rather than testing a code path that doesn't exist).
    await pool.query(`UPDATE profile_facts SET expires_at = now() - interval '1 day' WHERE fact_id = $1`, [
      written.factId,
    ]);

    const result = await getUserFact(opts, { tenantId }, "ttl-key");
    expect(result).toBeNull();
  });

  it("a role cannot read another role's agent-scope memory: role A never sees role B's row for the same key", async () => {
    const opts = { connectionString: connectionString! };
    await writeMemoryFact(opts, {
      tenantId,
      scope: "agent",
      roleId: roleB,
      key: "shared-key",
      value: "role-b-value",
      source: "test",
    });

    const asRoleA = await getAgentFact(opts, { tenantId, roleId: roleA }, "shared-key");
    expect(asRoleA).toBeNull();

    const asRoleB = await getAgentFact(opts, { tenantId, roleId: roleB }, "shared-key");
    expect(asRoleB?.value).toBe("role-b-value");
  });

  it("a read, a resolve, and a failed write leave the store unchanged", async () => {
    const opts = { connectionString: connectionString! };
    const before = await pool.query(`SELECT count(*)::int AS n FROM profile_facts WHERE tenant_id = $1`, [
      tenantId,
    ]);

    await getAgentFact(opts, { tenantId, roleId: roleA }, "greeting");
    await resolve(opts, { tenantId, roleId: roleA }, "greeting");
    await expect(
      writeMemoryFact(opts, { tenantId, scope: "agent", key: "x", value: "x", source: "x" }),
    ).rejects.toThrow(/roleId/);

    const after = await pool.query(`SELECT count(*)::int AS n FROM profile_facts WHERE tenant_id = $1`, [
      tenantId,
    ]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("writes a new version rather than mutating an existing fact for the same key", async () => {
    const opts = { connectionString: connectionString! };
    const first = await writeMemoryFact(opts, {
      tenantId,
      scope: "user",
      key: "upsert-key",
      value: "v1",
      source: "test",
    });
    const second = await writeMemoryFact(opts, {
      tenantId,
      scope: "user",
      key: "upsert-key",
      value: "v2",
      source: "test",
    });
    expect(second.factId).not.toBe(first.factId);
    expect(second.value).toBe("v2");

    const versions = await pool.query<{ fact_id: string; value: string; superseded_by: string | null }>(
      `SELECT fact_id, value, superseded_by FROM profile_facts
       WHERE tenant_id = $1 AND key = 'upsert-key' ORDER BY value`,
      [tenantId],
    );
    expect(versions.rows).toEqual([
      { fact_id: first.factId, value: "v1", superseded_by: second.factId },
      { fact_id: second.factId, value: "v2", superseded_by: null },
    ]);
  });
});
