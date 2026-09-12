import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { defaultPoolConfig } from "./database.js";
import { listWorkspaceSummary } from "./workspaceSummary.js";

describe("listWorkspaceSummary (TASK-237)", () => {
  it("rejects a blank tenant before it can query", async () => {
    await expect(listWorkspaceSummary({ connectionString: "postgres://unused.invalid/test" }, " ")).rejects.toThrow(/tenantId/);
  });
});

const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

integration("listWorkspaceSummary ownership against real Postgres (TASK-237)", () => {
  const tenantId = "task-237-summary-tenant";
  const otherTenantId = "task-237-summary-other-tenant";
  const ownedRoleId = "task-237-summary-owned";
  const secondOwnedRoleId = "task-237-summary-owned-second";
  const foreignRoleId = "task-237-summary-foreign";
  const hiddenRoleId = "task-237-summary-hidden";
  const fixtureRoleIds = [ownedRoleId, secondOwnedRoleId, foreignRoleId, hiddenRoleId];
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString!, ...defaultPoolConfig, max: 1 });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("includes 1:1 and fully-owned groups, excluding foreign and hidden-role threads", async () => {
    const fixtureThreadIds: string[] = [];
    try {
      await pool.query("DELETE FROM thread_members WHERE role_id = ANY($1::text[])", [fixtureRoleIds]);
      await pool.query("DELETE FROM threads WHERE role_id = ANY($1::text[])", [fixtureRoleIds]);
      await pool.query("DELETE FROM roles WHERE role_id = ANY($1::text[])", [fixtureRoleIds]);
      await pool.query(
        `INSERT INTO roles (role_id, tenant_id, name, title, description, status)
         VALUES ($1, $2, 'Owned', 'Owned', '', 'active'),
                ($3, $2, 'Second owned', 'Second owned', '', 'active'),
                ($4, $5, 'Foreign', 'Foreign', '', 'active'),
                ($6, $2, 'Hidden', 'Hidden', '', 'hidden')`,
        [ownedRoleId, tenantId, secondOwnedRoleId, foreignRoleId, otherTenantId, hiddenRoleId],
      );
      const oneToOne = await pool.query<{ id: string }>(
        "INSERT INTO threads (role_id, title) VALUES ($1, 'TASK-237 owned') RETURNING id",
        [ownedRoleId],
      );
      const hidden = await pool.query<{ id: string }>(
        "INSERT INTO threads (role_id, title) VALUES ($1, 'TASK-237 hidden') RETURNING id",
        [hiddenRoleId],
      );
      const groupOwned = await pool.query<{ id: string }>("INSERT INTO threads (role_id, title) VALUES (NULL, 'TASK-237 group owned') RETURNING id");
      const groupForeign = await pool.query<{ id: string }>("INSERT INTO threads (role_id, title) VALUES (NULL, 'TASK-237 group foreign') RETURNING id");
      fixtureThreadIds.push(oneToOne.rows[0]!.id, hidden.rows[0]!.id, groupOwned.rows[0]!.id, groupForeign.rows[0]!.id);
      await pool.query(
        "INSERT INTO thread_members (thread_id, role_id) VALUES ($1, $2), ($1, $3), ($4, $2), ($4, $5)",
        [groupOwned.rows[0]!.id, ownedRoleId, secondOwnedRoleId, groupForeign.rows[0]!.id, foreignRoleId],
      );

      const summaries = await listWorkspaceSummary({ connectionString: connectionString! }, tenantId);
      const summaryByThreadId = new Map(summaries.map((summary) => [summary.threadId, summary]));
      expect([...summaryByThreadId.keys()]).toEqual(expect.arrayContaining([oneToOne.rows[0]!.id, groupOwned.rows[0]!.id]));
      expect(summaryByThreadId.has(groupForeign.rows[0]!.id)).toBe(false);
      expect(summaryByThreadId.has(hidden.rows[0]!.id)).toBe(false);
      expect(summaryByThreadId.get(oneToOne.rows[0]!.id)).toMatchObject({ latestRun: null, pendingApprovals: 0, lastActivityAt: expect.any(Date) });
    } finally {
      if (fixtureThreadIds.length > 0) {
        await pool.query("DELETE FROM messages WHERE thread_id = ANY($1::uuid[])", [fixtureThreadIds]);
        await pool.query("DELETE FROM thread_members WHERE thread_id = ANY($1::uuid[])", [fixtureThreadIds]);
        await pool.query("DELETE FROM threads WHERE id = ANY($1::uuid[])", [fixtureThreadIds]);
      }
      await pool.query("DELETE FROM roles WHERE role_id = ANY($1::text[])", [fixtureRoleIds]);
    }
  });
});
