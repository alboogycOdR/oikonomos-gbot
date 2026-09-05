import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createRole,
  createSkill,
  defaultPoolConfig,
  getSkill,
  listEnabledForRole,
  listSkills,
  setEnabledForRole,
  updateSkill,
} from "./index.js";

const connectionString = process.env.DATABASE_URL;
const migrationApplied = await (async (): Promise<boolean> => {
  if (connectionString === undefined) return false;
  const pool = new Pool({ connectionString, ...defaultPoolConfig });
  try {
    const result = await pool.query<{ skills: string | null; role_skills: string | null }>(
      `SELECT to_regclass('public.skills') AS skills,
              to_regclass('public.role_skills') AS role_skills`,
    );
    const row = result.rows[0];
    return row?.skills === "skills" && row.role_skills === "role_skills";
  } finally {
    await pool.end();
  }
})();
const integration = migrationApplied ? describe : describe.skip;

integration("packages/db skills — migration-backed CRUD and role enablement (TASK-176)", () => {
  let pool: Pool;
  const tenantId = "task-176-skills-suite";
  const roleA = "task-176-skills-suite-role-a";
  const roleB = "task-176-skills-suite-role-b";
  const options = { connectionString: connectionString! };

  async function cleanup(): Promise<void> {
    await pool.query(
      `DELETE FROM role_skills WHERE role_id = ANY($1::text[])`,
      [[roleA, roleB]],
    );
    await pool.query(`DELETE FROM skills WHERE tenant_id = $1`, [tenantId]);
    await pool.query(`DELETE FROM roles WHERE role_id = ANY($1::text[])`, [[roleA, roleB]]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString!, ...defaultPoolConfig });
    await cleanup();
    await createRole(options, { roleId: roleA, tenantId, name: "Role A", title: "Role A" });
    await createRole(options, { roleId: roleB, tenantId, name: "Role B", title: "Role B" });
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("persists all frontmatter fields and updates the version", async () => {
    const created = await createSkill(options, {
      tenantId,
      name: "daily-brief",
      description: "Prepare the daily brief.",
      whenToUse: "When a daily brief is requested.",
      body: "# Steps\n1. Gather updates.",
      inputs: [{ name: "date", required: true, source: "user" }],
      access: ["browser"],
      approvals: ["publish"],
      failurePolicy: { no_data: "report_and_stop" },
    });

    expect(created.version).toBe(1);
    expect(created.inputs).toEqual([{ name: "date", required: true, source: "user" }]);
    expect(await getSkill(options, created.skillId)).toEqual(created);

    const updated = await updateSkill(options, created.skillId, { description: "Updated brief." });
    expect(updated?.description).toBe("Updated brief.");
    expect(updated?.version).toBe(2);
  });

  it("the database constraint rejects a non slash-token skill name", async () => {
    await expect(
      pool.query(
        `INSERT INTO skills (tenant_id, name, description, body) VALUES ($1, $2, 'd', 'b')`,
        [tenantId, "Invalid_name"],
      ),
    ).rejects.toThrow(/skills_name_slash_token_check|check constraint/i);
  });

  it("lists only enabled skills for the requested role", async () => {
    const enabledForA = await createSkill(options, {
      tenantId,
      name: "role-a-enabled",
      description: "d",
      body: "b",
    });
    const disabledForA = await createSkill(options, {
      tenantId,
      name: "role-a-disabled",
      description: "d",
      body: "b",
    });
    const enabledForB = await createSkill(options, {
      tenantId,
      name: "role-b-enabled",
      description: "d",
      body: "b",
    });
    await setEnabledForRole(options, roleA, enabledForA.skillId, true);
    await setEnabledForRole(options, roleA, disabledForA.skillId, false);
    await setEnabledForRole(options, roleB, enabledForB.skillId, true);

    expect((await listEnabledForRole(options, roleA)).map((skill) => skill.skillId)).toEqual([
      enabledForA.skillId,
    ]);
    expect((await listEnabledForRole(options, roleB)).map((skill) => skill.skillId)).toEqual([
      enabledForB.skillId,
    ]);
  });

  it("lists skills only within the requested tenant", async () => {
    const own = await createSkill(options, {
      tenantId,
      name: "tenant-local",
      description: "d",
      body: "b",
    });
    const other = await createSkill(options, {
      tenantId: "task-176-other-tenant",
      name: "tenant-remote",
      description: "d",
      body: "b",
    });
    expect((await listSkills(options, { tenantId })).map((skill) => skill.skillId)).toContain(own.skillId);
    expect((await listSkills(options, { tenantId })).map((skill) => skill.skillId)).not.toContain(other.skillId);
    await pool.query(`DELETE FROM skills WHERE skill_id = $1`, [other.skillId]);
  });
});
