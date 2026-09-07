import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { Database, type DatabaseOptions, type Skill } from "@oikonomos/db";

import { buildApp } from "./app.js";
import { createDatabaseBackedDeps, type ControlApiDeps } from "./ports.js";

/**
 * TASK-177 (G-01b) — Skills CRUD routes: GET/POST /skills, GET/PATCH
 * /skills/:id, PUT /roles/:roleId/skills/:skillId, GET
 * /roles/:roleId/skills. Auth-gated like every other route in this
 * service (no `public: true`).
 */
const TOKEN = "task-177-fixture-token";
const roleId = "chat-bot";

function authHeaders() {
  return { authorization: `Bearer ${TOKEN}` };
}

function makeSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    skillId: randomUUID(),
    tenantId: "basileia",
    name: "weekly-export",
    description: "Exports the weekly report",
    whenToUse: "When asked for the weekly export",
    body: "1. Gather data.\n2. Export CSV.",
    inputs: [],
    access: [],
    approvals: [],
    failurePolicy: {},
    version: 1,
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function createDeps(overrides: Partial<ControlApiDeps> = {}) {
  const calls: string[] = [];
  const deps: ControlApiDeps = {
    createTask: async (input) => ({
      taskId: randomUUID(), tenantId: "basileia", status: "draft",
      routineId: null, createdAt: new Date(), updatedAt: new Date(), ...input,
    }),
    createRoutine: async (input) => ({
      routineId: randomUUID(), tenantId: "basileia", schedule: "0 8 * * *", lane: "background",
      enabled: true, lastFireAt: null, nextFireAt: null, lastFireStatus: null, ...input,
    }),
    createRole: async (input) => ({
      tenantId: "basileia", description: "d", instructions: null, provider: null, model: null, status: "active",
      createdAt: new Date(), updatedAt: new Date(), ...input,
    }),
    listCapabilities: async () => [],
    upsertRoleGrant: async (input) => input,
    listRoleGrants: async () => [],
    revokeRoleGrant: async () => {},
    listRoles: async () => [],
    updateRoleInstructions: async () => null,
    listRoleMessages: async () => [],
    listRoutines: async () => [],
    getOrCreateThreadForRole: async (input) => ({ id: randomUUID(), roleId: input.roleId, title: null, createdAt: new Date(), updatedAt: new Date() }),
    listThreads: async () => [],
    createGroupThread: async (input) => ({ id: randomUUID(), title: input.title ?? null, memberRoleIds: input.roleIds, createdAt: new Date(), updatedAt: new Date() }),
    listAllThreadsWithMembers: async () => [],
    insertMessage: async (input) => ({ id: randomUUID(), threadId: input.threadId, role: input.role, body: input.body, runId: input.runId ?? null, createdAt: new Date() }),
    listMessages: async () => [],
    listTasks: async () => ({ tasks: [], nextCursor: null }),
    getTask: async () => null,
    listRuns: async () => ({ runs: [], nextCursor: null }),
    getRun: async () => null,
    listPendingApprovals: async () => [],
    decideApproval: async () => ({ decided: false, rowCount: 0 }),
    editApproval: async () => ({ edited: false, rowCount: 0 }),
    getAuditEventsForRun: async () => [],
    registerDeviceToken: async (input) => ({ ...input, createdAt: new Date(), lastSeenAt: new Date() }),
    runChatTask: async () => {},
    requestGroupFanout: async () => ({ runId: randomUUID() }),
    createSkill: async (input) => { calls.push("createSkill"); return makeSkill(input); },
    getSkill: async (skillId) => { calls.push("getSkill"); return makeSkill({ skillId }); },
    updateSkill: async (skillId, input) => { calls.push("updateSkill"); return makeSkill({ skillId, ...input }); },
    listSkills: async () => { calls.push("listSkills"); return [makeSkill()]; },
    setSkillEnabledForRole: async () => { calls.push("setSkillEnabledForRole"); },
    listEnabledSkillsForRole: async () => { calls.push("listEnabledSkillsForRole"); return [makeSkill()]; },
    ...overrides,
  };
  return { deps, calls };
}

describe("Skills CRUD routes (TASK-177)", () => {
  it("rejects every skills route without a session (401)", async () => {
    const { deps, calls } = createDeps();
    const app = buildApp(deps, { authToken: TOKEN, logger: false });
    const skillId = randomUUID();
    const requests = [
      { method: "GET" as const, url: "/skills" },
      { method: "POST" as const, url: "/skills", payload: { name: "weekly-export", description: "d", body: "b" } },
      { method: "GET" as const, url: `/skills/${skillId}` },
      { method: "PATCH" as const, url: `/skills/${skillId}`, payload: { description: "d2" } },
      { method: "PUT" as const, url: `/roles/${roleId}/skills/${skillId}`, payload: { enabled: true } },
      { method: "GET" as const, url: `/roles/${roleId}/skills` },
    ];
    for (const request of requests) expect((await app.inject(request)).statusCode).toBe(401);
    expect(calls).toEqual([]);
    await app.close();
  });

  it("creates a skill and lists it", async () => {
    const { deps, calls } = createDeps();
    const app = buildApp(deps, { authToken: TOKEN, logger: false });
    const created = await app.inject({
      method: "POST", url: "/skills", headers: authHeaders(),
      payload: { name: "weekly-export", description: "Exports the weekly report", body: "1. Gather data." },
    });
    expect(created.statusCode).toBe(201);
    expect(JSON.parse(created.body)).toMatchObject({ name: "weekly-export", description: "Exports the weekly report" });

    const listed = await app.inject({ method: "GET", url: "/skills", headers: authHeaders() });
    expect(listed.statusCode).toBe(200);
    expect(JSON.parse(listed.body)).toHaveLength(1);
    expect(calls).toEqual(["createSkill", "listSkills"]);
    await app.close();
  });

  it("passes the status filter through GET /skills", async () => {
    let observed: unknown;
    const { deps } = createDeps({ listSkills: async (filter) => { observed = filter; return []; } });
    const app = buildApp(deps, { authToken: TOKEN, logger: false });
    const response = await app.inject({ method: "GET", url: "/skills?status=archived", headers: authHeaders() });
    expect(response.statusCode).toBe(200);
    expect(observed).toEqual({ tenantId: "basileia", status: "archived" });
    await app.close();
  });

  it("rejects a malformed create-skill body before calling the port", async () => {
    const { deps, calls } = createDeps();
    const app = buildApp(deps, { authToken: TOKEN, logger: false });
    const response = await app.inject({ method: "POST", url: "/skills", headers: authHeaders(), payload: { name: "weekly-export" } });
    expect(response.statusCode).toBe(400);
    expect(calls).not.toContain("createSkill");
    await app.close();
  });

  it("gets a skill by id and 404s when missing", async () => {
    const skillId = randomUUID();
    const { deps } = createDeps({ getSkill: async (id) => (id === skillId ? makeSkill({ skillId: id }) : null) });
    const app = buildApp(deps, { authToken: TOKEN, logger: false });
    const found = await app.inject({ method: "GET", url: `/skills/${skillId}`, headers: authHeaders() });
    expect(found.statusCode).toBe(200);
    expect(JSON.parse(found.body)).toMatchObject({ skillId });

    const notFound = await app.inject({ method: "GET", url: `/skills/${randomUUID()}`, headers: authHeaders() });
    expect(notFound.statusCode).toBe(404);
    await app.close();
  });

  it("patches a skill and 404s when missing", async () => {
    const skillId = randomUUID();
    const updates: Array<[string, unknown]> = [];
    const { deps } = createDeps({
      updateSkill: async (id, input) => {
        updates.push([id, input]);
        return id === skillId ? makeSkill({ skillId: id, description: input.description ?? "d" }) : null;
      },
    });
    const app = buildApp(deps, { authToken: TOKEN, logger: false });
    const patched = await app.inject({
      method: "PATCH", url: `/skills/${skillId}`, headers: authHeaders(), payload: { description: "Updated" },
    });
    expect(patched.statusCode).toBe(200);
    expect(JSON.parse(patched.body)).toMatchObject({ skillId, description: "Updated" });
    expect(updates).toEqual([[skillId, { description: "Updated" }]]);

    const missing = await app.inject({
      method: "PATCH", url: `/skills/${randomUUID()}`, headers: authHeaders(), payload: { description: "Updated" },
    });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });

  it("enables a skill for a role via PUT /roles/:roleId/skills/:skillId", async () => {
    const skillId = randomUUID();
    const enabled: Array<[string, string, boolean]> = [];
    const { deps } = createDeps({
      setSkillEnabledForRole: async (rid, sid, isEnabled) => { enabled.push([rid, sid, isEnabled]); },
    });
    const app = buildApp(deps, { authToken: TOKEN, logger: false });
    const response = await app.inject({
      method: "PUT", url: `/roles/${roleId}/skills/${skillId}`, headers: authHeaders(), payload: { enabled: true },
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ roleId, skillId, enabled: true });
    expect(enabled).toEqual([[roleId, skillId, true]]);
    await app.close();
  });

  it("rejects a PUT enable request missing the required field", async () => {
    const { deps, calls } = createDeps();
    const app = buildApp(deps, { authToken: TOKEN, logger: false });
    const response = await app.inject({
      method: "PUT", url: `/roles/${roleId}/skills/${randomUUID()}`, headers: authHeaders(), payload: {},
    });
    expect(response.statusCode).toBe(400);
    expect(calls).not.toContain("setSkillEnabledForRole");
    await app.close();
  });

  it("lists exactly the skills enabled for a role", async () => {
    const enabledSkills = [makeSkill({ name: "weekly-export" }), makeSkill({ name: "daily-brief" })];
    const { deps, calls } = createDeps({ listEnabledSkillsForRole: async () => { calls.push("listEnabledSkillsForRole"); return enabledSkills; } });
    const app = buildApp(deps, { authToken: TOKEN, logger: false });
    const response = await app.inject({ method: "GET", url: `/roles/${roleId}/skills`, headers: authHeaders() });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toHaveLength(2);
    expect(calls).toEqual(["listEnabledSkillsForRole"]);
    await app.close();
  });

  it("publishes all skills endpoints in OpenAPI", async () => {
    const { deps } = createDeps();
    const app = buildApp(deps, { authToken: TOKEN, logger: false });
    const document = JSON.parse((await app.inject({ method: "GET", url: "/openapi.json" })).body) as { paths: Record<string, unknown> };
    expect(Object.keys(document.paths)).toEqual(expect.arrayContaining([
      "/skills", "/skills/{id}", "/roles/{roleId}/skills/{skillId}", "/roles/{roleId}/skills",
    ]));
    await app.close();
  });
});

const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

integration("Skills CRUD — real Postgres (TASK-177)", () => {
  const options: DatabaseOptions = { connectionString: connectionString ?? "" };

  // TASK-177 discovered a genuine pre-existing bug OUT OF THIS TASK'S
  // TERRITORY: packages/db/src/skills.ts's `UUID_RE` was missing one of
  // the standard UUID's five hex groups (8-4-4-4-12, it only had
  // 8-4-4-12), so `requireUuid()` rejected every real, well-formed skill
  // id `getSkill`, `updateSkill`, and `setEnabledForRole` are called
  // with, breaking GET/PATCH /skills/:id and PUT
  // /roles/:roleId/skills/:skillId against a real database. Fixed by
  // ORCH 2026-09-06 (commit 1daec39, packages/db/src/skills.ts) — flipped
  // back to a real test, proving the fix, per this test's own original
  // intent.
  it("creates, updates, lists, and enables a skill for a role end to end", async () => {
    const database = new Database(options);
    const app = buildApp(createDatabaseBackedDeps(options), { authToken: TOKEN, logger: false });
    const roleName = `Skills role ${randomUUID()}`;
    const skillName = `test-skill-${randomUUID().slice(0, 8)}`;
    let createdRoleId: string | undefined;
    let createdSkillId: string | undefined;
    try {
      const roleRes = await app.inject({
        method: "POST", url: "/roles", headers: authHeaders(), payload: { name: roleName, description: "TASK-177 fixture" },
      });
      expect(roleRes.statusCode).toBe(201);
      const role = JSON.parse(roleRes.body) as { id: string };
      createdRoleId = role.id;

      const created = await app.inject({
        method: "POST", url: "/skills", headers: authHeaders(),
        payload: { name: skillName, description: "A test skill", body: "Do the thing." },
      });
      expect(created.statusCode).toBe(201);
      const skill = JSON.parse(created.body) as { skillId: string };
      createdSkillId = skill.skillId;

      const updated = await app.inject({
        method: "PATCH", url: `/skills/${skill.skillId}`, headers: authHeaders(), payload: { description: "Updated description" },
      });
      expect(updated.statusCode).toBe(200);
      expect(JSON.parse(updated.body)).toMatchObject({ description: "Updated description" });

      const enabled = await app.inject({
        method: "PUT", url: `/roles/${role.id}/skills/${skill.skillId}`, headers: authHeaders(), payload: { enabled: true },
      });
      expect(enabled.statusCode).toBe(200);

      const roleSkills = await app.inject({ method: "GET", url: `/roles/${role.id}/skills`, headers: authHeaders() });
      expect(roleSkills.statusCode).toBe(200);
      expect(JSON.parse(roleSkills.body)).toEqual(
        expect.arrayContaining([expect.objectContaining({ skillId: skill.skillId, name: skillName })]),
      );

      const disabled = await app.inject({
        method: "PUT", url: `/roles/${role.id}/skills/${skill.skillId}`, headers: authHeaders(), payload: { enabled: false },
      });
      expect(disabled.statusCode).toBe(200);
      const roleSkillsAfterDisable = await app.inject({ method: "GET", url: `/roles/${role.id}/skills`, headers: authHeaders() });
      expect(JSON.parse(roleSkillsAfterDisable.body)).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ skillId: skill.skillId })]),
      );
    } finally {
      // Fixture cleanup: role_skills before skills/roles (FK order), same
      // convention as roles.test.ts/skills.test.ts's cleanup(). Without
      // this, every run leaves rows in the shared dev Postgres — the exact
      // class of bug TASK-121/172's reviews caught this session.
      const pool = new Pool({ connectionString: options.connectionString });
      try {
        if (createdRoleId !== undefined && createdSkillId !== undefined) {
          await pool.query("DELETE FROM role_skills WHERE role_id = $1 AND skill_id = $2", [createdRoleId, createdSkillId]);
        }
        if (createdSkillId !== undefined) {
          await pool.query("DELETE FROM skills WHERE skill_id = $1", [createdSkillId]);
        }
        if (createdRoleId !== undefined) {
          await pool.query("DELETE FROM role_grants WHERE role_id = $1", [createdRoleId]);
          await pool.query("DELETE FROM roles WHERE role_id = $1", [createdRoleId]);
        }
      } finally {
        await pool.end();
      }
      await database.close();
      await app.close();
    }
  });
});
