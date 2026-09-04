import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";
import { Database, type Approval, type Capability, type DatabaseOptions, type Message, type Role, type RoleGrant, type Task, type Thread } from "@oikonomos/db";

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
    listRoles: async () => { calls.push("listRoles"); return [makeRole()]; },
    getOrCreateThreadForRole: async (input) => { calls.push("getOrCreateThreadForRole"); return makeThread(); },
    listThreads: async () => { calls.push("listThreads"); return [makeThread()]; },
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

  it("projects a pending approval onto its matching bot message", async () => {
    const runId = randomUUID();
    const approval = makeApproval(runId);
    const { deps } = createDeps({
      listMessages: async () => [makeMessage({ role: "bot", runId, body: "I need approval" })],
      listPendingApprovals: async () => [approval],
    });
    const app = buildApp(deps, { authToken: TOKEN, logger: false });
    const result = await app.inject({ method: "GET", url: `/threads/${threadId}/messages`, headers: authHeaders() });
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)[0].approval).toEqual({ nonce: approval.nonce, action_render: approval.actionRender, status: "pending" });
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
