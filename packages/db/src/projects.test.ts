import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { defaultPoolConfig, type DatabaseOptions } from "./database.js";
import {
  addProjectRoleMember,
  assignProjectTaskOwner,
  createProject,
  createProjectTask,
  createProjectWithRoster,
  getProjectOverview,
  linkProjectTaskRun,
  mirrorApprovalDecisionToProjects,
  updateProjectWithRoster,
  listProjectDecisions,
  listProjectTasks,
  listProjectRoleMembers,
  listProjectTaskRunIds,
  PROJECT_ROSTER_CAP,
  removeProjectRoleMember,
  setProjectManager,
} from "./projects.js";

const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

// TASK-298: roster (project_roles + thread_members) and project_task_runs
// against real Postgres. Own tenant so other suites' fixtures never collide.
integration("packages/db projects — roster, manager, task-run link (TASK-298)", () => {
  let pool: Pool;
  const options: DatabaseOptions = { connectionString: connectionString! };
  const tenantId = `task-298-${randomUUID()}`;
  const rolePrefix = `task-298-role-${randomUUID().slice(0, 8)}`;
  const roleIds = Array.from({ length: PROJECT_ROSTER_CAP + 1 }, (_, i) => `${rolePrefix}-${i}`);
  const assignmentOwnerRoleId = randomUUID();
  const threadIds: string[] = [];
  const projectIds: string[] = [];

  async function newProject(): Promise<{ projectId: string; threadId: string }> {
    const thread = await pool.query<{ id: string }>(
      "INSERT INTO threads (role_id, title) VALUES (NULL, 'task-298') RETURNING id",
    );
    const threadId = thread.rows[0]!.id;
    threadIds.push(threadId);
    const project = await createProject(options, {
      tenantId,
      threadId,
      name: "P",
      goal: "g",
      doneCriterion: "d",
      createdBy: "human:1",
    });
    projectIds.push(project.projectId);
    return { projectId: project.projectId, threadId };
  }

  async function threadMembers(threadId: string): Promise<string[]> {
    const r = await pool.query<{ role_id: string }>(
      "SELECT role_id FROM thread_members WHERE thread_id = $1 ORDER BY role_id",
      [threadId],
    );
    return r.rows.map((row) => row.role_id);
  }

  async function cleanup(): Promise<void> {
    await pool.query("DELETE FROM project_task_runs WHERE task_id IN (SELECT task_id FROM project_tasks WHERE project_id = ANY($1))", [projectIds]);
    await pool.query("DELETE FROM project_tasks WHERE project_id = ANY($1)", [projectIds]);
    await pool.query("DELETE FROM project_roles WHERE project_id = ANY($1)", [projectIds]);
    await pool.query("DELETE FROM projects WHERE project_id = ANY($1)", [projectIds]);
    await pool.query("DELETE FROM thread_members WHERE thread_id = ANY($1)", [threadIds]);
    await pool.query("DELETE FROM threads WHERE id = ANY($1)", [threadIds]);
    await pool.query("DELETE FROM runs WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM tasks WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM roles WHERE role_id LIKE $1", [`${rolePrefix}%`]);
    await pool.query("DELETE FROM roles WHERE role_id = $1", [assignmentOwnerRoleId]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString!, ...defaultPoolConfig });
    for (const roleId of roleIds) {
      await pool.query(
        "INSERT INTO roles (role_id, tenant_id, name, title, description, status) VALUES ($1, $2, $1, $1, '', 'active')",
        [roleId, tenantId],
      );
    }
    await pool.query(
      "INSERT INTO roles (role_id, tenant_id, name, title, description, status) VALUES ($1, $2, $1, $1, '', 'active')",
      [assignmentOwnerRoleId, tenantId],
    );
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("adds and removes roster members, keeping thread_members and project_roles in step", async () => {
    const { projectId, threadId } = await newProject();
    await addProjectRoleMember(options, { projectId, roleId: roleIds[0]!, responsibility: "research" });
    await addProjectRoleMember(options, { projectId, roleId: roleIds[1]! });
    expect((await listProjectRoleMembers(options, projectId)).map((m) => m.roleId)).toEqual([roleIds[0], roleIds[1]]);
    expect(await threadMembers(threadId)).toEqual([roleIds[0], roleIds[1]]);

    expect(await removeProjectRoleMember(options, { projectId, roleId: roleIds[0]! })).toBe(true);
    expect(await removeProjectRoleMember(options, { projectId, roleId: roleIds[0]! })).toBe(false);
    expect((await listProjectRoleMembers(options, projectId)).map((m) => m.roleId)).toEqual([roleIds[1]]);
    expect(await threadMembers(threadId)).toEqual([roleIds[1]]);
  });

  it("rejects a second is_manager=true row at the database", async () => {
    const { projectId } = await newProject();
    await addProjectRoleMember(options, { projectId, roleId: roleIds[0]!, isManager: true });
    // Raw insert proves the constraint itself, not just the accessor.
    await expect(
      pool.query("INSERT INTO project_roles (project_id, role_id, is_manager) VALUES ($1, $2, true)", [projectId, roleIds[1]]),
    ).rejects.toThrow(/project_roles_one_manager_idx/);
    await expect(
      addProjectRoleMember(options, { projectId, roleId: roleIds[1]!, isManager: true }),
    ).rejects.toThrow(/project_roles_one_manager_idx/);
  });

  it("a failure mid-transaction leaves neither thread_members nor project_roles changed", async () => {
    const { projectId, threadId } = await newProject();
    await addProjectRoleMember(options, { projectId, roleId: roleIds[0]!, isManager: true });
    // The thread_members insert succeeds first, then the manager index rejects
    // the project_roles insert: the rollback must undo the thread_members row.
    await expect(
      addProjectRoleMember(options, { projectId, roleId: roleIds[1]!, isManager: true }),
    ).rejects.toThrow();
    expect(await threadMembers(threadId)).toEqual([roleIds[0]]);
    expect((await listProjectRoleMembers(options, projectId)).map((m) => m.roleId)).toEqual([roleIds[0]]);
  });

  it("refuses a roster larger than PROJECT_ROSTER_CAP (6)", async () => {
    const { projectId, threadId } = await newProject();
    for (const roleId of roleIds.slice(0, PROJECT_ROSTER_CAP)) {
      await addProjectRoleMember(options, { projectId, roleId });
    }
    await expect(
      addProjectRoleMember(options, { projectId, roleId: roleIds[PROJECT_ROSTER_CAP]! }),
    ).rejects.toThrow(/at most 6/);
    expect(await threadMembers(threadId)).toHaveLength(PROJECT_ROSTER_CAP);
    // Re-adding an existing member (e.g. to change responsibility) is not growth.
    const updated = await addProjectRoleMember(options, { projectId, roleId: roleIds[0]!, responsibility: "new" });
    expect(updated.responsibility).toBe("new");
  });

  it("setProjectManager swaps and clears the manager; rejects a non-member", async () => {
    const { projectId } = await newProject();
    await addProjectRoleMember(options, { projectId, roleId: roleIds[0]! });
    await addProjectRoleMember(options, { projectId, roleId: roleIds[1]! });
    await setProjectManager(options, { projectId, roleId: roleIds[0]! });
    await setProjectManager(options, { projectId, roleId: roleIds[1]! });
    const managers = (await listProjectRoleMembers(options, projectId)).filter((m) => m.isManager);
    expect(managers.map((m) => m.roleId)).toEqual([roleIds[1]]);

    await expect(setProjectManager(options, { projectId, roleId: roleIds[2]! })).rejects.toThrow(/not on the roster/);
    // The failed promote rolled back the demote too.
    expect((await listProjectRoleMembers(options, projectId)).filter((m) => m.isManager)).toHaveLength(1);

    await setProjectManager(options, { projectId, roleId: null });
    expect((await listProjectRoleMembers(options, projectId)).filter((m) => m.isManager)).toHaveLength(0);
  });

  it("links a task to runs idempotently", async () => {
    const { projectId } = await newProject();
    const task = await createProjectTask(options, { projectId, title: "t", createdBy: "human:1" });
    const runtimeTaskId = randomUUID();
    const runId = randomUUID();
    await pool.query(
      "INSERT INTO tasks (task_id, tenant_id, role_id, title, goal, requested_by) VALUES ($1, $2, $3, 't', 'g', 'test')",
      [runtimeTaskId, tenantId, roleIds[0]],
    );
    await pool.query("INSERT INTO runs (run_id, task_id, tenant_id, provider) VALUES ($1, $2, $3, 'test')", [runId, runtimeTaskId, tenantId]);

    await linkProjectTaskRun(options, { taskId: task.taskId, runId });
    await linkProjectTaskRun(options, { taskId: task.taskId, runId });
    expect(await listProjectTaskRunIds(options, task.taskId)).toEqual([runId]);
    await expect(linkProjectTaskRun(options, { taskId: task.taskId, runId: randomUUID() })).rejects.toThrow();
  });

  it("assigns an existing task owner without imposing roster membership, and advances updated_at", async () => {
    const { projectId } = await newProject();
    const task = await createProjectTask(options, { projectId, title: "unassigned", createdBy: "human:1" });
    await pool.query("SELECT pg_sleep(0.01)");

    const assigned = await assignProjectTaskOwner(options, task.taskId, assignmentOwnerRoleId);
    expect(assigned).not.toBeNull();
    expect(assigned?.ownerRoleId).toBe(assignmentOwnerRoleId);
    expect(assigned?.updatedAt.getTime()).toBeGreaterThan(task.updatedAt.getTime());
    expect((await listProjectRoleMembers(options, projectId)).map((member) => member.roleId)).not.toContain(assignmentOwnerRoleId);
  });

  it("returns null when assigning a non-existent task", async () => {
    await expect(assignProjectTaskOwner(options, randomUUID(), assignmentOwnerRoleId)).resolves.toBeNull();
  });
});

// TASK-304 (P-5): atomic project create / update, demotion, decision mirror,
// against real Postgres. Own tenant so other suites' fixtures never collide.
integration("packages/db projects — atomic create, demotion, mirror (TASK-304)", () => {
  let pool: Pool;
  const options: DatabaseOptions = { connectionString: connectionString! };
  const tenantId = `task-304-${randomUUID()}`;
  const prefix = `task-304-role-${randomUUID().slice(0, 8)}`;
  const roleIds = Array.from({ length: PROJECT_ROSTER_CAP + 1 }, (_, i) => `${prefix}-${i}`);
  const managerGrants = [
    { capabilityId: "project.read", maxTier: "T0_observe" as const },
    { capabilityId: "project.task_write", maxTier: "T2_internal" as const },
    { capabilityId: "workspace.create_bot", maxTier: "T3_external" as const },
  ];
  const projectIds: string[] = [];

  async function count(sql: string, params: unknown[]): Promise<number> {
    const result = await pool.query<{ n: string }>(sql, params);
    return Number(result.rows[0]!.n);
  }

  async function newRun(roleId: string): Promise<string> {
    const task = await pool.query<{ task_id: string }>(
      "INSERT INTO tasks (tenant_id, role_id, title, goal, requested_by) VALUES ($1, $2, 't', 'g', 'test') RETURNING task_id",
      [tenantId, roleId],
    );
    const run = await pool.query<{ run_id: string }>(
      "INSERT INTO runs (task_id, tenant_id, provider) VALUES ($1, $2, 'test') RETURNING run_id",
      [task.rows[0]!.task_id, tenantId],
    );
    return run.rows[0]!.run_id;
  }

  async function newApproval(runId: string, capabilityId: string, render = "r"): Promise<{ approvalId: string; nonce: string }> {
    const inserted = await pool.query<{ approval_id: string; nonce: string }>(
      `INSERT INTO approvals (tenant_id, run_id, capability_id, action_digest, action_render, destination, expires_at)
       VALUES ($1, $2, $3, '\\x00', $4, 'd', now() + interval '1 hour') RETURNING approval_id, nonce`,
      [tenantId, runId, capabilityId, render],
    );
    return { approvalId: inserted.rows[0]!.approval_id, nonce: inserted.rows[0]!.nonce };
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString!, ...defaultPoolConfig });
    for (const roleId of roleIds) {
      await pool.query(
        "INSERT INTO roles (role_id, tenant_id, name, title, description, status) VALUES ($1, $2, $1, $1, '', 'active')",
        [roleId, tenantId],
      );
    }
    for (const cap of ["project.read", "project.task_write", "project.request_grant", "workspace.create_bot", "workspace.retire_bot", "gmail.send"]) {
      await pool.query(
        "INSERT INTO capabilities (capability_id, description, default_tier, adapter, enabled) VALUES ($1, 't', 'T2_internal', 'test', true) ON CONFLICT DO NOTHING",
        [cap],
      );
    }
  });

  afterAll(async () => {
    const ids = projectIds;
    const threads = (await pool.query<{ thread_id: string }>("SELECT thread_id FROM projects WHERE project_id = ANY($1::uuid[])", [ids])).rows.map((r) => r.thread_id);
    await pool.query("DELETE FROM project_decisions WHERE project_id = ANY($1::uuid[])", [ids]);
    await pool.query("DELETE FROM project_task_runs WHERE task_id IN (SELECT task_id FROM project_tasks WHERE project_id = ANY($1::uuid[]))", [ids]);
    await pool.query("DELETE FROM project_tasks WHERE project_id = ANY($1::uuid[])", [ids]);
    await pool.query("DELETE FROM project_roles WHERE project_id = ANY($1::uuid[])", [ids]);
    await pool.query("DELETE FROM profile_facts WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM approvals WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM runs WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM tasks WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM projects WHERE project_id = ANY($1::uuid[])", [ids]);
    await pool.query("DELETE FROM thread_members WHERE thread_id = ANY($1::uuid[])", [threads]);
    await pool.query("DELETE FROM threads WHERE id = ANY($1::uuid[])", [threads]);
    await pool.query("DELETE FROM role_grants WHERE role_id = ANY($1::text[])", [roleIds]);
    await pool.query("DELETE FROM roles WHERE role_id = ANY($1::text[])", [roleIds]);
    await pool.end();
  });

  it("creates thread, roster, one manager, charter facts and grants in one transaction", async () => {
    const created = await createProjectWithRoster(options, {
      tenantId,
      name: "P",
      goal: "ship it",
      doneCriterion: "shipped",
      charter: { boundaries: "no prod", checkWithMeBefore: "spending" },
      createdBy: "human:1",
      roster: [
        { roleId: roleIds[0]!, isManager: true, responsibility: "lead" },
        { roleId: roleIds[1]! },
        { roleId: roleIds[2]! },
      ],
      managerGrants,
    });
    projectIds.push(created.project.projectId);
    expect(await count("SELECT count(*) AS n FROM thread_members WHERE thread_id = $1", [created.project.threadId])).toBe(3);
    expect(created.roster.filter((m) => m.isManager).map((m) => m.roleId)).toEqual([roleIds[0]]);
    const overview = await getProjectOverview(options, { tenantId, projectId: created.project.projectId });
    expect(overview.charter).toEqual({
      "charter.goal": "ship it",
      "charter.done_criterion": "shipped",
      "charter.boundaries": "no prod",
      "charter.check_with_me_before": "spending",
    });
    const facts = await pool.query<{ scope: string; tier: string; visible_to: string[] }>(
      "SELECT scope, tier, visible_to FROM profile_facts WHERE tenant_id = $1 AND project_id = $2",
      [tenantId, created.project.projectId],
    );
    expect(facts.rows).toHaveLength(4);
    for (const row of facts.rows) {
      expect(row.scope).toBe("project");
      expect(row.tier).toBe("profile");
      expect([...row.visible_to].sort()).toEqual([roleIds[0], roleIds[1], roleIds[2]].sort());
    }
    const granted = await pool.query<{ capability_id: string }>(
      "SELECT capability_id FROM role_grants WHERE role_id = $1 ORDER BY capability_id",
      [roleIds[0]],
    );
    expect(granted.rows.map((r) => r.capability_id)).toEqual(["project.read", "project.task_write", "workspace.create_bot"]);
  });

  it("rolls the whole create back as a unit when any step fails", async () => {
    // A grant for a capability that does not exist fails at the very last step,
    // after the thread, roster, project and charter were already written.
    await expect(
      createProjectWithRoster(options, {
        tenantId,
        name: "rollback-304",
        goal: "g-rollback",
        doneCriterion: "d",
        createdBy: "human:1",
        roster: [{ roleId: roleIds[3]!, isManager: true }, { roleId: roleIds[4]! }],
        managerGrants: [{ capabilityId: "project.does_not_exist", maxTier: "T0_observe" }],
      }),
    ).rejects.toThrow();
    expect(await count("SELECT count(*) AS n FROM threads WHERE title = 'rollback-304'", [])).toBe(0);
    expect(await count("SELECT count(*) AS n FROM projects WHERE name = 'rollback-304' AND tenant_id = $1", [tenantId])).toBe(0);
    expect(await count("SELECT count(*) AS n FROM profile_facts WHERE tenant_id = $1 AND value = 'g-rollback'", [tenantId])).toBe(0);
    expect(await count("SELECT count(*) AS n FROM thread_members WHERE role_id = ANY($1::text[]) AND thread_id NOT IN (SELECT thread_id FROM projects)", [[roleIds[3], roleIds[4]]])).toBe(0);
    expect(await count("SELECT count(*) AS n FROM role_grants WHERE role_id = ANY($1::text[])", [[roleIds[3], roleIds[4]]])).toBe(0);
  });

  it("enforces roster shape: 2..6, at most one manager, tenant-owned roles, forbidden manager grants", async () => {
    const base = { tenantId, name: "bad", goal: "g", doneCriterion: "d", createdBy: "human:1" };
    await expect(createProjectWithRoster(options, { ...base, roster: [{ roleId: roleIds[0]! }] })).rejects.toThrow(/at least two/);
    await expect(
      createProjectWithRoster(options, { ...base, roster: roleIds.map((roleId) => ({ roleId })) }),
    ).rejects.toThrow(/at most 6/);
    await expect(
      createProjectWithRoster(options, {
        ...base,
        roster: [{ roleId: roleIds[0]!, isManager: true }, { roleId: roleIds[1]!, isManager: true }],
      }),
    ).rejects.toThrow(/at most one manager/);
    await expect(
      createProjectWithRoster(options, { ...base, roster: [{ roleId: roleIds[0]! }, { roleId: "not-a-role" }] }),
    ).rejects.toThrow(/tenant/);
    for (const capabilityId of ["project.request_grant", "project.create_role", "workspace.retire_bot", "roles.write"]) {
      await expect(
        createProjectWithRoster(options, {
          ...base,
          roster: [{ roleId: roleIds[0]!, isManager: true }, { roleId: roleIds[1]! }],
          managerGrants: [{ capabilityId, maxTier: "T0_observe" }],
        }),
      ).rejects.toThrow(/may not be granted/);
    }
    expect(await count("SELECT count(*) AS n FROM projects WHERE name = 'bad' AND tenant_id = $1", [tenantId])).toBe(0);
  });

  it("demotion revokes the grants and invalidates the role's create_bot approvals in one transaction", async () => {
    const created = await createProjectWithRoster(options, {
      tenantId,
      name: "demote",
      goal: "g",
      doneCriterion: "d",
      createdBy: "human:1",
      roster: [{ roleId: roleIds[3]!, isManager: true }, { roleId: roleIds[4]! }],
      managerGrants,
    });
    const projectId = created.project.projectId;
    projectIds.push(projectId);
    const runId = await newRun(roleIds[3]!);
    const nonces: string[] = [];
    for (const capability of ["workspace.create_bot", "workspace.create_bot", "workspace.retire_bot"]) {
      nonces.push((await newApproval(runId, capability)).nonce);
    }
    // the second create_bot approval was already granted but never consumed
    await pool.query("UPDATE approvals SET status = 'granted' WHERE nonce = $1", [nonces[1]]);

    const result = await updateProjectWithRoster(options, { projectId, managerRoleId: null });
    expect(result?.roster.some((m) => m.isManager)).toBe(false);
    expect(await count("SELECT count(*) AS n FROM role_grants WHERE role_id = $1", [roleIds[3]])).toBe(0);
    const statuses = await pool.query<{ nonce: string; status: string; consumed_at: Date | null }>(
      "SELECT nonce, status, consumed_at FROM approvals WHERE nonce = ANY($1::uuid[])",
      [nonces],
    );
    const byNonce = new Map(statuses.rows.map((r) => [r.nonce, r]));
    expect(byNonce.get(nonces[0]!)).toMatchObject({ status: "invalidated", consumed_at: null });
    expect(byNonce.get(nonces[1]!)).toMatchObject({ status: "invalidated", consumed_at: null });
    // retire_bot is not create_bot: untouched
    expect(byNonce.get(nonces[2]!)?.status).toBe("pending");

    // a grant or consume attempt on the invalidated approval affects no row
    const grant = await pool.query(
      "UPDATE approvals SET status = 'granted', decided_by = 'human' WHERE nonce = $1 AND status = 'pending' AND expires_at > now()",
      [nonces[0]],
    );
    expect(grant.rowCount).toBe(0);
    const consume = await pool.query(
      "UPDATE approvals SET status = 'consumed', consumed_at = now() WHERE nonce = $1 AND status = 'granted' AND consumed_at IS NULL",
      [nonces[1]],
    );
    expect(consume.rowCount).toBe(0);
  });

  it("removing the manager from the roster also demotes; a role managing another project keeps its grants", async () => {
    const make = async (name: string) =>
      createProjectWithRoster(options, {
        tenantId,
        name,
        goal: "g",
        doneCriterion: "d",
        createdBy: "human:1",
        roster: [{ roleId: roleIds[5]!, isManager: true }, { roleId: roleIds[6]! }],
        managerGrants,
      });
    const a = await make("A");
    const b = await make("B");
    projectIds.push(a.project.projectId, b.project.projectId);
    // role 5 still manages B, so removing it from A must not strip its grants
    await updateProjectWithRoster(options, { projectId: a.project.projectId, removeRoleIds: [roleIds[5]!] });
    expect(await count("SELECT count(*) AS n FROM role_grants WHERE role_id = $1", [roleIds[5]])).toBe(3);
    await updateProjectWithRoster(options, { projectId: b.project.projectId, managerRoleId: roleIds[6]!, managerGrants });
    expect(await count("SELECT count(*) AS n FROM role_grants WHERE role_id = $1", [roleIds[5]])).toBe(0);
    expect(await count("SELECT count(*) AS n FROM role_grants WHERE role_id = $1", [roleIds[6]])).toBe(3);
  });

  it("updates status, budget and roster; keeps the charter ACL equal to the roster; caps at 6", async () => {
    const created = await createProjectWithRoster(options, {
      tenantId,
      name: "patch",
      goal: "g",
      doneCriterion: "d",
      createdBy: "human:1",
      roster: [{ roleId: roleIds[0]! }, { roleId: roleIds[1]! }],
    });
    const projectId = created.project.projectId;
    projectIds.push(projectId);
    const patched = await updateProjectWithRoster(options, {
      projectId,
      status: "paused",
      budgetUsd: 12.5,
      addMembers: [{ roleId: roleIds[2]!, responsibility: "qa" }],
      removeRoleIds: [roleIds[0]!],
    });
    expect(patched?.project).toMatchObject({ status: "paused", budgetUsd: 12.5 });
    expect(patched?.roster.map((m) => m.roleId)).toEqual([roleIds[1], roleIds[2]]);
    const acl = await pool.query<{ visible_to: string[] }>(
      "SELECT visible_to FROM profile_facts WHERE tenant_id = $1 AND project_id = $2 LIMIT 1",
      [tenantId, projectId],
    );
    expect([...acl.rows[0]!.visible_to].sort()).toEqual([roleIds[1], roleIds[2]].sort());
    await expect(
      updateProjectWithRoster(options, {
        projectId,
        addMembers: [roleIds[0]!, roleIds[3]!, roleIds[4]!, roleIds[5]!, roleIds[6]!].map((roleId) => ({ roleId })),
      }),
    ).rejects.toThrow(/at most 6/);
    // the failed patch rolled back as a unit
    expect(await listProjectRoleMembers(options, projectId)).toHaveLength(2);
    await expect(updateProjectWithRoster(options, { projectId: randomUUID(), status: "done" })).resolves.toBeNull();
  });

  it("mirrors an approval decided on a project-attributed run by approval_id, idempotently", async () => {
    const created = await createProjectWithRoster(options, {
      tenantId,
      name: "mirror",
      goal: "g",
      doneCriterion: "d",
      createdBy: "human:1",
      roster: [{ roleId: roleIds[0]! }, { roleId: roleIds[1]! }],
    });
    const projectId = created.project.projectId;
    projectIds.push(projectId);
    const item = await createProjectTask(options, { projectId, title: "t", createdBy: "human:1" });
    const runId = await newRun(roleIds[0]!);
    await linkProjectTaskRun(options, { taskId: item.taskId, runId });
    const { approvalId, nonce } = await newApproval(runId, "gmail.send", "SECRET RENDER");
    expect(await mirrorApprovalDecisionToProjects(options, { nonce, decision: "granted", decidedBy: "human:1" })).toBe(1);
    expect(await mirrorApprovalDecisionToProjects(options, { nonce, decision: "granted", decidedBy: "human:1" })).toBe(0);
    const decisions = await listProjectDecisions(options, { projectId });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ kind: "approval", approvalId, taskId: item.taskId });
    expect(JSON.stringify(decisions[0])).not.toContain("SECRET RENDER");

    // a run with no project attribution is not mirrored anywhere
    const other = await newApproval(await newRun(roleIds[1]!), "gmail.send");
    expect(await mirrorApprovalDecisionToProjects(options, { nonce: other.nonce, decision: "rejected", decidedBy: "human:1" })).toBe(0);
  });

  it("creates a task blocked only with a reason, and lists it", async () => {
    const created = await createProjectWithRoster(options, {
      tenantId,
      name: "tasks",
      goal: "g",
      doneCriterion: "d",
      createdBy: "human:1",
      roster: [{ roleId: roleIds[0]! }, { roleId: roleIds[1]! }],
    });
    const projectId = created.project.projectId;
    projectIds.push(projectId);
    await expect(createProjectTask(options, { projectId, title: "t", state: "blocked", createdBy: "human:1" })).rejects.toThrow(/blockedReason/);
    const blocked = await createProjectTask(options, { projectId, title: "t", state: "blocked", blockedReason: "waiting", createdBy: "human:1" });
    expect(blocked).toMatchObject({ state: "blocked", blockedReason: "waiting" });
    expect(await listProjectTasks(options, { projectId, state: "blocked" })).toHaveLength(1);
  });
});

describe("packages/db projects — roster input validation (no DB, TASK-298)", () => {
  const options: DatabaseOptions = { connectionString: "postgres://unused" };
  it("rejects a malformed projectId before touching the pool", async () => {
    await expect(addProjectRoleMember(options, { projectId: "nope", roleId: "r" })).rejects.toThrow(/UUID/);
    await expect(removeProjectRoleMember(options, { projectId: "nope", roleId: "r" })).rejects.toThrow(/UUID/);
  });

  it("validates taskId and ownerRoleId as UUIDs before touching the pool", async () => {
    await expect(assignProjectTaskOwner(options, "nope", randomUUID())).rejects.toThrow(/UUID/);
    await expect(assignProjectTaskOwner(options, randomUUID(), "nope")).rejects.toThrow(/UUID/);
  });
});
