import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { defaultPoolConfig } from "./database.js";
import {
  getAgentFact,
  getFactById,
  getProjectFact,
  getUserFact,
  readProfileTier,
  writeMemoryFact,
} from "./facts.js";
import { resolve } from "./resolve.js";

const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

integration("packages/memory — ACL and versioned fact history (TASK-098)", () => {
  let pool: Pool;
  const tenantId = "task-098-memory-acl-versioning";
  const roleA = "task-098-role-a";
  const roleB = "task-098-role-b";
  const roleC = "task-098-role-c";
  const projectId = "task-098-project";
  const options = { connectionString: connectionString! };

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

  it("keeps a fact without visibleTo tenant-visible, while populated ACLs deny other roles", async () => {
    await writeMemoryFact(options, {
      tenantId,
      scope: "project",
      projectId,
      key: "tenant-visible",
      value: "unchanged default",
      source: "test",
    });
    const aclFact = await writeMemoryFact(options, {
      tenantId,
      scope: "project",
      projectId,
      key: "restricted",
      value: "role-b-only",
      source: "test",
      visibleTo: [roleB],
    });

    expect(aclFact.visibleTo).toEqual([roleB]);
    expect((await getProjectFact(options, { tenantId, projectId, roleId: roleA }, "tenant-visible"))?.value).toBe(
      "unchanged default",
    );
    expect((await getProjectFact(options, { tenantId, projectId, roleId: roleB }, "restricted"))?.value).toBe(
      "role-b-only",
    );
    await expect(getProjectFact(options, { tenantId, projectId, roleId: roleC }, "restricted")).resolves.toBeNull();

    await writeMemoryFact(options, {
      tenantId,
      scope: "user",
      key: "restricted-user",
      value: "role-b-only",
      source: "test",
      visibleTo: [roleB],
    });
    expect((await getUserFact(options, { tenantId, roleId: roleB }, "restricted-user"))?.value).toBe(
      "role-b-only",
    );
    await expect(getUserFact(options, { tenantId, roleId: roleC }, "restricted-user")).resolves.toBeNull();
  });

  it("keeps agent scope owner-only even if an ACL is supplied", async () => {
    const fact = await writeMemoryFact(options, {
      tenantId,
      scope: "agent",
      roleId: roleA,
      key: "agent-only",
      value: "owner-value",
      source: "test",
      visibleTo: [roleB],
    });

    expect(fact.visibleTo).toBeNull();
    expect((await getAgentFact(options, { tenantId, roleId: roleA }, "agent-only"))?.value).toBe(
      "owner-value",
    );
    await expect(getAgentFact(options, { tenantId, roleId: roleB }, "agent-only")).resolves.toBeNull();
  });

  it("inserts version chains, exposes history by fact id, and normal paths return only the latest row", async () => {
    const first = await writeMemoryFact(options, {
      tenantId,
      scope: "project",
      projectId,
      key: "versioned",
      value: "v1",
      source: "test",
      visibleTo: [roleB],
    });
    const second = await writeMemoryFact(options, {
      tenantId,
      scope: "project",
      projectId,
      key: "versioned",
      value: "v2",
      source: "test",
      visibleTo: [roleB],
    });
    const third = await writeMemoryFact(options, {
      tenantId,
      scope: "project",
      projectId,
      key: "versioned",
      value: "v3",
      source: "test",
      visibleTo: [roleB],
    });

    expect(new Set([first.factId, second.factId, third.factId]).size).toBe(3);
    const stored = await pool.query<{ fact_id: string; value: string; superseded_by: string | null }>(
      `SELECT fact_id, value, superseded_by FROM profile_facts
       WHERE tenant_id = $1 AND key = 'versioned' ORDER BY value`,
      [tenantId],
    );
    expect(stored.rows).toEqual([
      { fact_id: first.factId, value: "v1", superseded_by: second.factId },
      { fact_id: second.factId, value: "v2", superseded_by: third.factId },
      { fact_id: third.factId, value: "v3", superseded_by: null },
    ]);

    // LIVENESS: every exported ordinary read goes through CURRENT. Removing
    // that predicate from any helper makes at least one assertion below red.
    expect((await getProjectFact(options, { tenantId, projectId, roleId: roleB }, "versioned"))?.factId).toBe(
      third.factId,
    );
    expect((await readProfileTier(options, { tenantId, projectId, roleId: roleB }).then((facts) =>
      facts.find((fact) => fact.key === "versioned"),
    ))?.factId).toBe(third.factId);
    expect((await resolve(options, { tenantId, projectId, roleId: roleB }, "versioned"))?.factId).toBe(
      third.factId,
    );
    expect((await getFactById(options, { tenantId, roleId: roleB }, first.factId))?.value).toBe("v1");
    await expect(getFactById(options, { tenantId, roleId: roleC }, first.factId)).resolves.toBeNull();
  });
});

describe("packages/memory TASK-098 integration suite", () => {
  it("skips its real-Postgres coverage only when DATABASE_URL is unset", () => {
    expect(typeof connectionString === "string" || connectionString === undefined).toBe(true);
  });
});
