import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";
import { Database, type Approval, type DatabaseOptions, type Message, type Role, type Task, type Thread } from "@oikonomos/db";

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

  it("creates and lists zero-grant chat bots without a client-controlled capability", async () => {
    const { deps, calls } = createDeps();
    const app = buildApp(deps, { authToken: TOKEN, logger: false });
    const created = await app.inject({ method: "POST", url: "/roles", headers: authHeaders(), payload: { name: " Bot ", description: " Helpful " } });
    expect(created.statusCode).toBe(201);
    expect(JSON.parse(created.body)).toMatchObject({ name: "Bot", description: "Helpful", avatarSeed: expect.any(String) });
    expect(calls).toEqual(["createRole"]);
    const listed = await app.inject({ method: "GET", url: "/roles", headers: authHeaders() });
    expect(listed.statusCode).toBe(200);
    expect(JSON.parse(listed.body)[0]).toMatchObject({ id: roleId, name: "Chat bot" });
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

  it("posts a user message and creates a tagged task without starting a run", async () => {
    const { deps, calls } = createDeps();
    const app = buildApp(deps, { authToken: TOKEN, logger: false });
    const result = await app.inject({ method: "POST", url: `/threads/${threadId}/messages`, headers: authHeaders(), payload: { body: "  Plan my day  " } });
    expect(result.statusCode).toBe(201);
    expect(calls).toEqual(["listThreads", "insertMessage", "createTask"]);
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

integration("POST /roles — zero-grant database integration (TASK-106)", () => {
  const options: DatabaseOptions = { connectionString: connectionString ?? "" };

  it("persists the role with no role_grants rows", async () => {
    const app = buildApp(createDatabaseBackedDeps(options), { authToken: TOKEN, logger: false });
    const response = await app.inject({
      method: "POST", url: "/roles", headers: authHeaders(),
      payload: { name: `Zero grant ${randomUUID()}`, description: "Database assertion fixture" },
    });
    expect(response.statusCode).toBe(201);
    const created = JSON.parse(response.body) as { id: string };
    const database = new Database(options);
    try {
      expect(await database.listRoleGrants(created.id)).toEqual([]);
    } finally {
      await database.close();
      await app.close();
    }
  });
});
