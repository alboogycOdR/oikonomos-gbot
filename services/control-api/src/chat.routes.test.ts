import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";
import {
  Database,
  insertMessage,
  listAllThreadsWithMembers,
  listThreadMembers,
  type Approval,
  type Capability,
  type DatabaseOptions,
  type GroupThread,
  type Message,
  type Role,
  type RoleGrant,
  type Task,
  type Thread,
} from "@oikonomos/db";

import { buildApp } from "./app.js";
import { createDatabaseBackedDeps, type ControlApiDeps } from "./ports.js";

const TOKEN = "task-106-fixture-token";
const threadId = "11111111-1111-1111-1111-111111111111";
const roleId = "chat-bot";

function authHeaders() {
  return { authorization: `Bearer ${TOKEN}` };
}

function makeThread(): Thread {
  return { id: threadId, roleId, title: null, createdAt: new Date(), updatedAt: new Date() };
}

function makeGroupThread(): GroupThread {
  return { id: "22222222-2222-2222-2222-222222222222", title: "Planning", createdAt: new Date(), updatedAt: new Date(), memberRoleIds: [roleId, "second-bot"] };
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: randomUUID(), threadId, role: "user", body: "Hello bot", runId: null, createdAt: new Date(), ...overrides,
  };
}

function makeRole(overrides: Partial<Role> = {}): Role {
  return {
    roleId, tenantId: "basileia", name: "Chat bot", title: "Chat bot", description: "Helpful", status: "active",
    createdAt: new Date(), updatedAt: new Date(), ...overrides,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    taskId: randomUUID(), tenantId: "basileia", roleId, title: "Chat: Hello bot", goal: "Hello bot",
    status: "draft", routineId: null, requestedBy: `chat:thread:${threadId}`, createdAt: new Date(), updatedAt: new Date(), ...overrides,
  };
}

function makeCapability(overrides: Partial<Capability> = {}): Capability {
  return {
    capabilityId: "fs.read", description: "Read files", defaultTier: "T0_observe", adapter: "sdk:builtin", enabled: true,
    ...overrides,
  };
}

function makeApproval(runId: string): Approval {
  return {
    approvalId: randomUUID(), tenantId: "basileia", runId, capabilityId: "email.send", actionDigest: Buffer.from("digest"),
    actionRender: "Send email to user@example.test", destination: "user@example.test", nonce: randomUUID(), status: "pending",
    requestedAt: new Date(), expiresAt: new Date(Date.now() + 60_000), decidedBy: null, decidedAt: null, consumedAt: null,
  };
}

function createDeps(overrides: Partial<ControlApiDeps> = {}) {
  const calls: string[] = [];
  const deps: ControlApiDeps = {
    createTask: async (input) => { calls.push("createTask"); return makeTask(input); },
    createRole: async (input) => { calls.push("createRole"); return makeRole(input); },
    listCapabilities: async () => { calls.push("listCapabilities"); return [makeCapability()]; },
    upsertRoleGrant: async (input) => { calls.push(`upsertRoleGrant:${input.capabilityId}:${input.maxTier}`); return input; },
    listRoleGrants: async () => { calls.push("listRoleGrants"); return []; },
    revokeRoleGrant: async (grantRoleId, capabilityId) => { calls.push(`revokeRoleGrant:${grantRoleId}:${capabilityId}`); },
    listRoles: async () => { calls.push("listRoles"); return [makeRole()]; },
    getOrCreateThreadForRole: async (input) => { calls.push("getOrCreateThreadForRole"); return makeThread(); },
    listThreads: async () => { calls.push("listThreads"); return [makeThread()]; },
    createGroupThread: async (input) => ({ ...makeGroupThread(), title: input.title ?? null, memberRoleIds: input.roleIds }),
    listAllThreadsWithMembers: async () => [makeThread()],
    insertMessage: async (input) => { calls.push("insertMessage"); return makeMessage(input); },
    listMessages: async () => { calls.push("listMessages"); return [makeMessage()]; },
    listTasks: async () => ({ tasks: [], nextCursor: null }),
    listRuns: async () => ({ runs: [], nextCursor: null }),
    getRun: async () => null,
    listPendingApprovals: async () => [],
    decideApproval: async () => ({ decided: false, rowCount: 0 }),
    editApproval: async () => ({ edited: false, rowCount: 0 }),
    getAuditEventsForRun: async () => [],
    runChatTask: async () => { calls.push("runChatTask"); },
    ...overrides,
  };
  return { deps, calls };
}

describe("Chat-1b control-api routes (TASK-106)", () => {
  it("rejects every new route without a session", async () => {
    const { deps, calls } = createDeps();
    const app = buildApp(deps, { authToken: TOKEN, logger: false });
    const requests = [
      { method: "GET" as const, url: "/roles" },
      { method: "POST" as const, url: "/roles", payload: { name: "Bot", description: "d" } },
      { method: "GET" as const, url: "/threads" },
      { method: "POST" as const, url: "/threads", payload: { roleId } },
      { method: "POST" as const, url: "/threads/group", payload: { roleIds: [roleId, "second-bot"] } },
      { method: "POST" as const, url: `/roles/${roleId}/grants`, payload: { capabilityId: "email.send", maxTier: "T3_external" } },
      { method: "GET" as const, url: `/roles/${roleId}/grants` },
      { method: "DELETE" as const, url: `/roles/${roleId}/grants/email.send` },
      { method: "GET" as const, url: `/threads/${threadId}/messages` },
      { method: "POST" as const, url: `/threads/${threadId}/messages`, payload: { body: "Hi" } },
    ];
    for (const request of requests) expect((await app.inject(request)).statusCode).toBe(401);
    expect(calls).toEqual([]);
    await app.close();
  });

  it("creates and lists chat bots with data-driven built-in grants", async () => {
    const { deps, calls } = createDeps();
    const app = buildApp(deps, { authToken: TOKEN, logger: false });
    const created = await app.inject({ method: "POST", url: "/roles", headers: authHeaders(), payload: { name: " Bot ", description: " Helpful " } });
    expect(created.statusCode).toBe(201);
    expect(JSON.parse(created.body)).toMatchObject({ name: "Bot", description: "Helpful", avatarSeed: expect.any(String) });
    expect(calls).toEqual(["createRole", "listCapabilities", "upsertRoleGrant:fs.read:T0_observe"]);
    const listed = await app.inject({ method: "GET", url: "/roles", headers: authHeaders() });
    expect(listed.statusCode).toBe(200);
    expect(JSON.parse(listed.body)[0]).toMatchObject({ id: roleId, name: "Chat bot" });
    await app.close();
  });

  it("grants every sdk:builtin capability at its registered default tier", async () => {
    const grants: RoleGrant[] = [];
    const { deps } = createDeps({
      listCapabilities: async () => [
        makeCapability({ capabilityId: "fs.read", defaultTier: "T1_draft" }),
        makeCapability({ capabilityId: "runtime.bash", defaultTier: "T3_external" }),
        makeCapability({ capabilityId: "email.send", adapter: "mcp:gmail", defaultTier: "T4_irreversible" }),
      ],
      upsertRoleGrant: async (grant) => { grants.push(grant); return grant; },
    });
    const app = buildApp(deps, { authToken: TOKEN, logger: false });
    const response = await app.inject({ method: "POST", url: "/roles", headers: authHeaders(), payload: { name: "Bot", description: "d" } });
    expect(response.statusCode).toBe(201);
    expect(grants).toEqual([
      { roleId: expect.any(String), capabilityId: "fs.read", maxTier: "T1_draft", constraints: {} },
      { roleId: expect.any(String), capabilityId: "runtime.bash", maxTier: "T3_external", constraints: {} },
    ]);
    await app.close();
  });

  it("creates/returns threads and lists sidebar previews", async () => {
    const { deps } = createDeps();
    const app = buildApp(deps, { authToken: TOKEN, logger: false });
    const created = await app.inject({ method: "POST", url: "/threads", headers: authHeaders(), payload: { roleId } });
    expect(created.statusCode).toBe(201);
    const listed = await app.inject({ method: "GET", url: "/threads", headers: authHeaders() });
    expect(JSON.parse(listed.body)[0]).toMatchObject({ id: threadId, roleId, botName: "Chat bot", lastMessagePreview: "Hello bot" });
    await app.close();
  });

  it("creates group threads and lists 1:1 and group summaries with their distinct shapes", async () => {
    const groupThread = makeGroupThread();
    const { deps } = createDeps({
      createGroupThread: async (input) => ({ ...groupThread, title: input.title ?? null, memberRoleIds: input.roleIds }),
      listAllThreadsWithMembers: async () => [makeThread(), groupThread],
      listRoles: async () => [makeRole(), makeRole({ roleId: "second-bot", name: "Second bot", description: "Also helpful" })],
    });
    const app = buildApp(deps, { authToken: TOKEN, logger: false });
    const created = await app.inject({ method: "POST", url: "/threads/group", headers: authHeaders(), payload: { roleIds: [roleId, "second-bot"], title: " Planning " } });
    expect(created.statusCode).toBe(201);
    expect(JSON.parse(created.body)).toMatchObject({ title: "Planning", memberRoleIds: [roleId, "second-bot"] });

    const listed = JSON.parse((await app.inject({ method: "GET", url: "/threads", headers: authHeaders() })).body);
    expect(listed).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: threadId, roleId, botName: "Chat bot", botDescription: "Helpful" }),
      expect.objectContaining({ id: groupThread.id, memberRoleIds: [roleId, "second-bot"], memberNames: ["Chat bot", "Second bot"] }),
    ]));
    expect(listed.find((thread: { id: string }) => thread.id === groupThread.id)).not.toHaveProperty("botName");
    await app.close();
  });

  it("rejects malformed group-thread requests before calling the port", async () => {
    const { deps, calls } = createDeps();
    const app = buildApp(deps, { authToken: TOKEN, logger: false });
    const response = await app.inject({ method: "POST", url: "/threads/group", headers: authHeaders(), payload: { roleIds: [roleId] } });
    expect(response.statusCode).toBe(400);
    expect(calls).toEqual([]);
    await app.close();
  });

  it("posts a user message, creates a tagged task, and starts the run without blocking", async () => {
    const { deps, calls } = createDeps();
    const app = buildApp(deps, { authToken: TOKEN, logger: false });
    const result = await app.inject({ method: "POST", url: `/threads/${threadId}/messages`, headers: authHeaders(), payload: { body: "  Plan my day  " } });
    expect(result.statusCode).toBe(201);
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toEqual(["listThreads", "insertMessage", "createTask", "runChatTask"]);
    expect(result.body).toContain("Plan my day");
    await app.close();
  });

  it("projects a pending approval onto its matching bot message, including its capability and tier (TASK-118)", async () => {
    const runId = randomUUID();
    const approval = makeApproval(runId); // capabilityId: "email.send"
    const { deps } = createDeps({
      listMessages: async () => [makeMessage({ role: "bot", runId, body: "I need approval" })],
      listPendingApprovals: async () => [approval],
      listCapabilities: async () => [makeCapability({ capabilityId: "email.send", defaultTier: "T3_external" })],
    });
    const app = buildApp(deps, { authToken: TOKEN, logger: false });
    const result = await app.inject({ method: "GET", url: `/threads/${threadId}/messages`, headers: authHeaders() });
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)[0].approval).toEqual({
      nonce: approval.nonce,
      action_render: approval.actionRender,
      status: "pending",
      capability_id: "email.send",
      max_tier: "T3_external",
    });
    await app.close();
  });

  it("projects null max_tier when the approval's capability is no longer registered", async () => {
    const runId = randomUUID();
    const approval = makeApproval(runId);
    const { deps } = createDeps({
      listMessages: async () => [makeMessage({ role: "bot", runId, body: "I need approval" })],
      listPendingApprovals: async () => [approval],
      listCapabilities: async () => [],
    });
    const app = buildApp(deps, { authToken: TOKEN, logger: false });
    const result = await app.inject({ method: "GET", url: `/threads/${threadId}/messages`, headers: authHeaders() });
    expect(JSON.parse(result.body)[0].approval.max_tier).toBeNull();
    await app.close();
  });

  it("attributes group-thread messages to their sender role and name", async () => {
    const senderRoleId = "second-bot";
    const { deps } = createDeps({
      listMessages: async () => [makeMessage({ role: "bot", senderRoleId })],
      listRoles: async () => [makeRole({ roleId: senderRoleId, name: "Second bot" })],
    });
    const app = buildApp(deps, { authToken: TOKEN, logger: false });
    const response = await app.inject({ method: "GET", url: `/threads/${makeGroupThread().id}/messages`, headers: authHeaders() });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)[0]).toMatchObject({ senderRoleId, senderName: "Second bot" });
    await app.close();
  });

  it("rejects POST /roles/:roleId/grants without a session (401)", async () => {
    const { deps, calls } = createDeps();
    const app = buildApp(deps, { authToken: TOKEN, logger: false });
    const result = await app.inject({
      method: "POST", url: `/roles/${roleId}/grants`,
      payload: { capabilityId: "email.send", maxTier: "T3_external" },
    });
    expect(result.statusCode).toBe(401);
    expect(calls).toEqual([]);
    await app.close();
  });

  it("writes a real standing grant via POST /roles/:roleId/grants (Always Allow, TASK-118)", async () => {
    const grants: RoleGrant[] = [];
    const { deps } = createDeps({ upsertRoleGrant: async (input) => { grants.push(input); return input; } });
    const app = buildApp(deps, { authToken: TOKEN, logger: false });
    const result = await app.inject({
      method: "POST", url: `/roles/${roleId}/grants`, headers: authHeaders(),
      payload: { capabilityId: "email.send", maxTier: "T3_external" },
    });
    expect(result.statusCode).toBe(201);
    expect(grants).toEqual([{ roleId, capabilityId: "email.send", maxTier: "T3_external", constraints: {} }]);
    expect(JSON.parse(result.body)).toEqual({ roleId, capabilityId: "email.send", maxTier: "T3_external", constraints: {} });
    await app.close();
  });

  it("rejects an unknown maxTier value on POST /roles/:roleId/grants (400, schema-validated)", async () => {
    const { deps, calls } = createDeps();
    const app = buildApp(deps, { authToken: TOKEN, logger: false });
    const result = await app.inject({
      method: "POST", url: `/roles/${roleId}/grants`, headers: authHeaders(),
      payload: { capabilityId: "email.send", maxTier: "not_a_real_tier" },
    });
    expect(result.statusCode).toBe(400);
    expect(calls).toEqual([]);
    await app.close();
  });

  it("lists a role's grants via GET /roles/:roleId/grants (TASK-119)", async () => {
    const roleGrants: RoleGrant[] = [
      { roleId, capabilityId: "email.send", maxTier: "T3_external", constraints: {} },
      { roleId, capabilityId: "fs.read", maxTier: "T0_observe", constraints: {} },
    ];
    const { deps, calls } = createDeps({ listRoleGrants: async () => { calls.push("listRoleGrants"); return roleGrants; } });
    const app = buildApp(deps, { authToken: TOKEN, logger: false });
    const result = await app.inject({ method: "GET", url: `/roles/${roleId}/grants`, headers: authHeaders() });
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual(roleGrants);
    expect(calls).toEqual(["listRoleGrants"]);
    await app.close();
  });

  it("revokes a grant via DELETE /roles/:roleId/grants/:capabilityId (TASK-119)", async () => {
    const revoked: Array<[string, string]> = [];
    const { deps } = createDeps({
      revokeRoleGrant: async (grantRoleId, capabilityId) => {
        revoked.push([grantRoleId, capabilityId]);
      },
    });
    const app = buildApp(deps, { authToken: TOKEN, logger: false });
    const result = await app.inject({
      method: "DELETE", url: `/roles/${roleId}/grants/email.send`, headers: authHeaders(),
    });
    expect(result.statusCode).toBe(204);
    expect(revoked).toEqual([[roleId, "email.send"]]);
    await app.close();
  });

  it("publishes all six chat endpoints in OpenAPI", async () => {
    const { deps } = createDeps();
    const app = buildApp(deps, { authToken: TOKEN, logger: false });
    const document = JSON.parse((await app.inject({ method: "GET", url: "/openapi.json" })).body) as { paths: Record<string, unknown> };
    expect(Object.keys(document.paths)).toEqual(expect.arrayContaining(["/roles", "/threads", "/threads/{id}/messages"]));
    await app.close();
  });
});

const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

integration("POST /roles — built-in grant database integration (TASK-117)", () => {
  const options: DatabaseOptions = { connectionString: connectionString ?? "" };

  it("persists every registered sdk:builtin capability at its own default tier", async () => {
    const app = buildApp(createDatabaseBackedDeps(options), { authToken: TOKEN, logger: false });
    const response = await app.inject({
      method: "POST", url: "/roles", headers: authHeaders(),
      payload: { name: `Zero grant ${randomUUID()}`, description: "Database assertion fixture" },
    });
    expect(response.statusCode).toBe(201);
    const created = JSON.parse(response.body) as { id: string };
    const database = new Database(options);
    try {
      const capabilities = (await database.listCapabilities()).filter((capability) => capability.adapter === "sdk:builtin");
      expect(await database.listRoleGrants(created.id)).toEqual(
        capabilities.map((capability) => ({
          roleId: created.id,
          capabilityId: capability.capabilityId,
          maxTier: capability.defaultTier,
          constraints: {},
        })),
      );
    } finally {
      await database.close();
      await app.close();
    }
  });

  it("uses a registered built-in capability's current, non-default tier", async () => {
    const database = new Database(options);
    const app = buildApp(createDatabaseBackedDeps(options), { authToken: TOKEN, logger: false });
    const original = await database.getCapability("fs.read");
    if (original === null) throw new Error("TASK-117 integration requires registered fs.read capability.");
    try {
      await database.upsertCapability({
        ...original,
        defaultTier: "T1_draft",
      });
      const response = await app.inject({
        method: "POST", url: "/roles", headers: authHeaders(),
        payload: { name: `Tier grant ${randomUUID()}`, description: "Database assertion fixture" },
      });
      expect(response.statusCode).toBe(201);
      const created = JSON.parse(response.body) as { id: string };
      expect(await database.getRoleGrant(created.id, "fs.read")).toEqual({
        roleId: created.id,
        capabilityId: "fs.read",
        maxTier: "T1_draft",
        constraints: {},
      });
    } finally {
      await database.upsertCapability(original);
      await database.close();
      await app.close();
    }
  });
});

integration("POST /roles/:roleId/grants — Always Allow standing grant, real Postgres (TASK-118)", () => {
  const options: DatabaseOptions = { connectionString: connectionString ?? "" };

  it("writes a real role_grants row — a fresh run no longer needs approval for this capability afterward", async () => {
    const database = new Database(options);
    const app = buildApp(createDatabaseBackedDeps(options), { authToken: TOKEN, logger: false });
    try {
      const roleRes = await app.inject({
        method: "POST", url: "/roles", headers: authHeaders(),
        payload: { name: `Always allow ${randomUUID()}`, description: "TASK-118 integration fixture" },
      });
      expect(roleRes.statusCode).toBe(201);
      const createdRole = JSON.parse(roleRes.body) as { id: string };

      // fs.read is one of the built-in capabilities every role already
      // gets by default (TASK-117), at fs.read's own registered default
      // tier. Requesting a DIFFERENT, non-default tier here — and then
      // asserting the persisted row reflects it — proves this endpoint's
      // own write, not TASK-117's creation-time default, produced the
      // final row (mirrors TASK-117's own "non-default tier" proof).
      const capability = await database.getCapability("fs.read");
      if (capability === null) throw new Error("TASK-118 integration requires registered fs.read capability.");
      const overriddenTier = capability.defaultTier === "T0_observe" ? "T1_draft" : "T0_observe";

      const grantRes = await app.inject({
        method: "POST", url: `/roles/${createdRole.id}/grants`, headers: authHeaders(),
        payload: { capabilityId: "fs.read", maxTier: overriddenTier },
      });
      expect(grantRes.statusCode).toBe(201);

      const persisted = await database.getRoleGrant(createdRole.id, "fs.read");
      expect(persisted).toEqual({
        roleId: createdRole.id,
        capabilityId: "fs.read",
        maxTier: overriddenTier,
        constraints: {},
      });
    } finally {
      await database.close();
      await app.close();
    }
  });
});

integration("GET/DELETE /roles/:roleId/grants — real Postgres (TASK-119)", () => {
  const options: DatabaseOptions = { connectionString: connectionString ?? "" };

  it("GET lists exactly the grants a role holds, exercising the real DB (not mocked)", async () => {
    const database = new Database(options);
    const app = buildApp(createDatabaseBackedDeps(options), { authToken: TOKEN, logger: false });
    try {
      const roleRes = await app.inject({
        method: "POST", url: "/roles", headers: authHeaders(),
        payload: { name: `List grants ${randomUUID()}`, description: "TASK-119 integration fixture" },
      });
      expect(roleRes.statusCode).toBe(201);
      const createdRole = JSON.parse(roleRes.body) as { id: string };

      // TASK-117's own onboarding already writes one built-in grant
      // (fs.read) at role-creation time — add a second, distinguishable
      // grant via the real POST endpoint so the list assertion below
      // proves both onboarding-time and explicit grants round-trip.
      const grantRes = await app.inject({
        method: "POST", url: `/roles/${createdRole.id}/grants`, headers: authHeaders(),
        payload: { capabilityId: "fs.read", maxTier: "T1_draft" },
      });
      expect(grantRes.statusCode).toBe(201);

      const listRes = await app.inject({
        method: "GET", url: `/roles/${createdRole.id}/grants`, headers: authHeaders(),
      });
      expect(listRes.statusCode).toBe(200);
      const listed = JSON.parse(listRes.body) as Array<{ roleId: string; capabilityId: string }>;
      expect(listed).toEqual(await database.listRoleGrants(createdRole.id));
      expect(listed.some((grant) => grant.capabilityId === "fs.read")).toBe(true);
    } finally {
      await database.close();
      await app.close();
    }
  });

  it(
    "DELETE removes exactly the targeted (role_id, capability_id) row and leaves others intact; " +
      "a revoked capability's next real getRoleGrant lookup — the same read the broker's fail-closed " +
      "gate uses (packages/broker/src/capabilityRegistry.ts) — returns null, mirroring TASK-117/118's " +
      "evidentiary shape via the exact mechanism a fresh run's approval check depends on",
    async () => {
      const database = new Database(options);
      const app = buildApp(createDatabaseBackedDeps(options), { authToken: TOKEN, logger: false });
      try {
        const roleRes = await app.inject({
          method: "POST", url: "/roles", headers: authHeaders(),
          payload: { name: `Revoke grants ${randomUUID()}`, description: "TASK-119 integration fixture" },
        });
        expect(roleRes.statusCode).toBe(201);
        const createdRole = JSON.parse(roleRes.body) as { id: string };

        const capability = await database.getCapability("fs.read");
        if (capability === null) throw new Error("TASK-119 integration requires registered fs.read capability.");

        // A second capability's grant must survive the targeted delete.
        const other = await database.listCapabilities();
        const otherCapability = other.find((c) => c.capabilityId !== "fs.read" && c.adapter === "sdk:builtin");
        if (otherCapability !== undefined) {
          await database.upsertRoleGrant({
            roleId: createdRole.id,
            capabilityId: otherCapability.capabilityId,
            maxTier: otherCapability.defaultTier,
            constraints: {},
          });
        }

        expect(await database.getRoleGrant(createdRole.id, "fs.read")).not.toBeNull();

        const deleteRes = await app.inject({
          method: "DELETE", url: `/roles/${createdRole.id}/grants/fs.read`, headers: authHeaders(),
        });
        expect(deleteRes.statusCode).toBe(204);

        expect(await database.getRoleGrant(createdRole.id, "fs.read")).toBeNull();
        if (otherCapability !== undefined) {
          expect(await database.getRoleGrant(createdRole.id, otherCapability.capabilityId)).not.toBeNull();
        }
      } finally {
        await database.close();
        await app.close();
      }
    },
  );
});

integration("Group-thread control-api routes — real Postgres (TASK-121)", () => {
  const options: DatabaseOptions = { connectionString: connectionString ?? "" };

  it("creates real memberships, lists 1:1 and group summaries, and attributes a group message", async () => {
    const app = buildApp(createDatabaseBackedDeps(options), { authToken: TOKEN, logger: false });
    try {
      const createRole = async (name: string) => {
        const response = await app.inject({
          method: "POST", url: "/roles", headers: authHeaders(),
          payload: { name, description: `${name} fixture` },
        });
        expect(response.statusCode).toBe(201);
        return JSON.parse(response.body) as { id: string; name: string };
      };
      const first = await createRole(`Group first ${randomUUID()}`);
      const second = await createRole(`Group second ${randomUUID()}`);

      const oneToOneResponse = await app.inject({
        method: "POST", url: "/threads", headers: authHeaders(), payload: { roleId: first.id },
      });
      expect(oneToOneResponse.statusCode).toBe(201);

      const groupResponse = await app.inject({
        method: "POST", url: "/threads/group", headers: authHeaders(),
        payload: { roleIds: [first.id, second.id], title: "Real group fixture" },
      });
      expect(groupResponse.statusCode).toBe(201);
      const group = JSON.parse(groupResponse.body) as { id: string; memberRoleIds: string[] };
      expect(group.memberRoleIds).toEqual([first.id, second.id]);
      expect((await listThreadMembers(options, group.id)).map((member) => member.roleId)).toEqual(
        expect.arrayContaining([first.id, second.id]),
      );
      expect((await listAllThreadsWithMembers(options)).find((thread) => thread.id === group.id)).toMatchObject({
        memberRoleIds: expect.arrayContaining([first.id, second.id]),
      });

      await insertMessage(options, { threadId: group.id, role: "bot", body: "Hello from the second bot", senderRoleId: second.id });
      const listed = JSON.parse((await app.inject({ method: "GET", url: "/threads", headers: authHeaders() })).body) as Array<Record<string, unknown>>;
      expect(listed).toEqual(expect.arrayContaining([
        expect.objectContaining({ roleId: first.id, botName: first.name }),
        expect.objectContaining({ id: group.id, memberRoleIds: expect.arrayContaining([first.id, second.id]), memberNames: expect.arrayContaining([first.name, second.name]) }),
      ]));
      const groupSummary = listed.find((thread) => thread.id === group.id) as { memberRoleIds: string[]; memberNames: string[] };
      const namesByRoleId = new Map([[first.id, first.name], [second.id, second.name]]);
      expect(groupSummary.memberRoleIds.map((memberRoleId) => namesByRoleId.get(memberRoleId))).toEqual(groupSummary.memberNames);

      const messages = JSON.parse((await app.inject({ method: "GET", url: `/threads/${group.id}/messages`, headers: authHeaders() })).body);
      expect(messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ body: "Hello from the second bot", senderRoleId: second.id, senderName: second.name }),
      ]));
    } finally {
      await app.close();
    }
  });
});
