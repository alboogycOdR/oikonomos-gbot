import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";
import {
  Database,
  defaultPoolConfig,
  createTask,
  getRole,
  insertApproval,
  insertMessage,
  listMessages,
  listRuns,
  parkRun,
  startRun,
  listAllThreadsWithMembers,
  listRoutines,
  sendRoleMessage,
  listThreadMembers,
  type Approval,
  type Capability,
  type DatabaseOptions,
  type GroupThread,
  type Message,
  type Role,
  type RoleMessage,
  type RoleGrant,
  type Routine,
  type Task,
  type Thread,
} from "@oikonomos/db";
import { Pool } from "pg";

import { buildApp } from "./app.js";
import {
  ATTACHMENT_ALLOWED_CONTENT_TYPES,
  ATTACHMENT_MAX_BYTES,
  createDatabaseBackedDeps,
  createFilesystemAttachmentStore,
  type ControlApiDeps,
} from "./ports.js";

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
    roleId, tenantId: "basileia", name: "Chat bot", title: "Chat bot", description: "Helpful", instructions: null, status: "active",
    createdAt: new Date(), updatedAt: new Date(), ...overrides,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    taskId: randomUUID(), tenantId: "basileia", roleId, title: "Chat: Hello bot", goal: "Hello bot",
    status: "draft", routineId: null, requestedBy: `chat:thread:${threadId}`, createdAt: new Date(), updatedAt: new Date(), ...overrides,
  };
}

function makeRoutine(overrides: Partial<Routine> = {}): Routine {
  return {
    routineId: randomUUID(), roleId, tenantId: "basileia", name: "Daily report", schedule: "0 8 * * *",
    lane: "background", enabled: true, definition: {}, lastFireAt: null, nextFireAt: new Date("2030-01-01T08:00:00.000Z"), lastFireStatus: null,
    ...overrides,
  };
}

function makeRoleMessage(overrides: Partial<RoleMessage> = {}): RoleMessage {
  return {
    messageId: randomUUID(), tenantId: "basileia", fromRoleId: roleId, toRoleId: "second-bot", body: "Real handoff body",
    workspaceRefs: [], handoffKind: null, factRef: null, createdAt: new Date(), readAt: null, ...overrides,
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
    createRoutine: async (input) => { calls.push("createRoutine"); return makeRoutine(input); },
    createRole: async (input) => { calls.push("createRole"); return makeRole(input); },
    listCapabilities: async () => { calls.push("listCapabilities"); return [makeCapability()]; },
    upsertRoleGrant: async (input) => { calls.push(`upsertRoleGrant:${input.capabilityId}:${input.maxTier}`); return input; },
    listRoleGrants: async () => { calls.push("listRoleGrants"); return []; },
    revokeRoleGrant: async (grantRoleId, capabilityId) => { calls.push(`revokeRoleGrant:${grantRoleId}:${capabilityId}`); },
    listRoles: async () => { calls.push("listRoles"); return [makeRole()]; },
    updateRoleInstructions: async (updatedRoleId, instructions) => {
      calls.push("updateRoleInstructions");
      return makeRole({ roleId: updatedRoleId, instructions });
    },
    listRoleMessages: async () => { calls.push("listRoleMessages"); return []; },
    listRoutines: async () => { calls.push("listRoutines"); return []; },
    getOrCreateThreadForRole: async (input) => { calls.push("getOrCreateThreadForRole"); return makeThread(); },
    listThreads: async () => { calls.push("listThreads"); return [makeThread()]; },
    createGroupThread: async (input) => ({ ...makeGroupThread(), title: input.title ?? null, memberRoleIds: input.roleIds }),
    listAllThreadsWithMembers: async () => { calls.push("listAllThreadsWithMembers"); return [makeThread()]; },
    insertMessage: async (input) => { calls.push("insertMessage"); return makeMessage(input); },
    listMessages: async () => { calls.push("listMessages"); return [makeMessage()]; },
    listTasks: async () => ({ tasks: [], nextCursor: null }),
    getTask: async () => null,
    listRuns: async () => ({ runs: [], nextCursor: null }),
    getRun: async () => null,
    listPendingApprovals: async () => [],
    decideApproval: async () => ({ decided: false, rowCount: 0 }),
    editApproval: async () => ({ edited: false, rowCount: 0 }),
    getAuditEventsForRun: async () => [],
    registerDeviceToken: async (input) => ({ ...input, createdAt: new Date(), lastSeenAt: new Date() }),
    runChatTask: async () => { calls.push("runChatTask"); },
    requestGroupFanout: async () => { calls.push("requestGroupFanout"); return { runId: randomUUID() }; },
    ...overrides,
  };
  return { deps, calls };
}

describe("Chat-1b control-api routes (TASK-106)", () => {
  it("merges a role's sent and received handoffs newest-first without duplicating self-handoffs", async () => {
    const oldest = makeRoleMessage({ messageId: "oldest", createdAt: new Date("2026-01-01T00:00:00Z") });
    const newest = makeRoleMessage({ messageId: "newest", createdAt: new Date("2026-01-03T00:00:00Z") });
    const self = makeRoleMessage({ messageId: "self", fromRoleId: roleId, toRoleId: roleId, createdAt: new Date("2026-01-02T00:00:00Z") });
    const observed: Array<{ tenantId: string; toRoleId?: string; fromRoleId?: string }> = [];
    const { deps } = createDeps({ listRoleMessages: async (filter) => {
      observed.push(filter);
      return filter.fromRoleId === roleId ? [oldest, self] : [newest, self];
    } });
    const app = buildApp(deps, { authToken: TOKEN, logger: false });
    try {
      const response = await app.inject({ method: "GET", url: `/roles/${roleId}/messages`, headers: authHeaders() });
      expect(response.statusCode).toBe(200);
      expect(observed).toEqual([
        { tenantId: "basileia", fromRoleId: roleId },
        { tenantId: "basileia", toRoleId: roleId },
      ]);
      expect(JSON.parse(response.body).map((message: { messageId: string }) => message.messageId)).toEqual(["newest", "self", "oldest"]);
    } finally { await app.close(); }
  });
  it("passes routineId through GET /tasks without changing unfiltered listing", async () => {
    const routineId = randomUUID();
    let observedFilter: unknown;
    const { deps } = createDeps({
      listTasks: async (filter) => {
        observedFilter = filter;
        return { tasks: [], nextCursor: null };
      },
    });
    const app = buildApp(deps, { authToken: TOKEN, logger: false });
    try {
      const filtered = await app.inject({ method: "GET", url: `/tasks?routineId=${routineId}`, headers: authHeaders() });
      expect(filtered.statusCode).toBe(200);
      expect(observedFilter).toEqual({ routineId });

      const unfiltered = await app.inject({ method: "GET", url: "/tasks", headers: authHeaders() });
      expect(unfiltered.statusCode).toBe(200);
      expect(observedFilter).toEqual({});
    } finally {
      await app.close();
    }
  });
  it("rejects every new route without a session", async () => {
    const { deps, calls } = createDeps();
    const app = buildApp(deps, { authToken: TOKEN, logger: false });
    const requests = [
      { method: "GET" as const, url: "/roles" },
      { method: "POST" as const, url: "/roles", payload: { name: "Bot", description: "d" } },
      { method: "PATCH" as const, url: `/roles/${roleId}`, payload: { instructions: "persona" } },
      { method: "GET" as const, url: "/threads" },
      { method: "POST" as const, url: "/threads", payload: { roleId } },
      { method: "POST" as const, url: "/threads/group", payload: { roleIds: [roleId, "second-bot"] } },
      { method: "POST" as const, url: `/roles/${roleId}/grants`, payload: { capabilityId: "email.send", maxTier: "T3_external" } },
      { method: "GET" as const, url: `/roles/${roleId}/grants` },
      { method: "DELETE" as const, url: `/roles/${roleId}/grants/email.send` },
      { method: "POST" as const, url: `/roles/${roleId}/routines`, payload: { name: "Daily", schedule: "0 8 * * *" } },
      { method: "GET" as const, url: `/roles/${roleId}/routines` },
      { method: "GET" as const, url: `/roles/${roleId}/messages` },
      { method: "GET" as const, url: `/threads/${threadId}/messages` },
      { method: "POST" as const, url: `/threads/${threadId}/messages`, payload: { body: "Hi" } },
      { method: "POST" as const, url: `/threads/${threadId}/attachments`, payload: { filename: "a.txt", contentType: "text/plain", contentBase64: "YQ==" } },
      { method: "POST" as const, url: "/devices", payload: { token: "opaque-test-target", platform: "android" } },
    ];
    for (const request of requests) expect((await app.inject(request)).statusCode).toBe(401);
    expect(calls).toEqual([]);
    await app.close();
  });

  it("registers a device only after the standard auth gate", async () => {
    const registered: Array<{ token: string; platform: string }> = [];
    const { deps } = createDeps({
      registerDeviceToken: async (input) => {
        registered.push(input);
        return { ...input, createdAt: new Date(), lastSeenAt: new Date() };
      },
    });
    const app = buildApp(deps, { authToken: TOKEN, logger: false });
    expect((await app.inject({ method: "POST", url: "/devices", payload: { token: "opaque-test-target", platform: "android" } })).statusCode).toBe(401);
    const response = await app.inject({ method: "POST", url: "/devices", headers: authHeaders(), payload: { token: "opaque-test-target", platform: "android" } });
    expect(response.statusCode).toBe(201);
    expect(JSON.parse(response.body)).toEqual({ registered: true });
    expect(registered).toEqual([{ token: "opaque-test-target", platform: "android" }]);
    await app.close();
  });

  it("creates and lists chat bots with data-driven built-in grants", async () => {
    const { deps, calls } = createDeps();
    const app = buildApp(deps, { authToken: TOKEN, logger: false });
    const created = await app.inject({ method: "POST", url: "/roles", headers: authHeaders(), payload: { name: " Bot ", description: " Helpful " } });
    expect(created.statusCode).toBe(201);
    expect(JSON.parse(created.body)).toMatchObject({
      name: "Bot",
      description: "Helpful",
      avatarSeed: expect.any(String),
      title: "Bot",
      instructions: null,
    });
    expect(calls).toEqual(["createRole", "listCapabilities", "upsertRoleGrant:fs.read:T0_observe"]);
    const listed = await app.inject({ method: "GET", url: "/roles", headers: authHeaders() });
    expect(listed.statusCode).toBe(200);
    expect(JSON.parse(listed.body)[0]).toMatchObject({
      id: roleId,
      name: "Chat bot",
      title: "Chat bot",
      instructions: null,
    });
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

  it("persists a role's custom instructions through PATCH /roles/:roleId", async () => {
    const persisted: Array<[string, string]> = [];
    const { deps } = createDeps({
      updateRoleInstructions: async (updatedRoleId, instructions) => {
        persisted.push([updatedRoleId, instructions]);
        return makeRole({ roleId: updatedRoleId, instructions });
      },
    });
    const app = buildApp(deps, { authToken: TOKEN, logger: false });
    const response = await app.inject({
      method: "PATCH", url: `/roles/${roleId}`, headers: authHeaders(),
      payload: { instructions: "Answer as a calm research assistant." },
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      id: roleId,
      title: "Chat bot",
      instructions: "Answer as a calm research assistant.",
    });
    expect(persisted).toEqual([[roleId, "Answer as a calm research assistant."]]);
    await app.close();
  });

  it("returns 404 from PATCH /roles/:roleId when the role does not exist", async () => {
    const { deps } = createDeps({
      updateRoleInstructions: async () => null,
    });
    const app = buildApp(deps, { authToken: TOKEN, logger: false });
    const response = await app.inject({
      method: "PATCH", url: `/roles/${roleId}`, headers: authHeaders(),
      payload: { instructions: "persona" },
    });
    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body)).toEqual({ error: "role not found" });
    await app.close();
  });

  it("clears custom instructions by PATCHing an empty string", async () => {
    const persisted: Array<[string, string]> = [];
    const { deps } = createDeps({
      updateRoleInstructions: async (updatedRoleId, instructions) => {
        persisted.push([updatedRoleId, instructions]);
        return makeRole({ roleId: updatedRoleId, instructions });
      },
    });
    const app = buildApp(deps, { authToken: TOKEN, logger: false });
    const response = await app.inject({
      method: "PATCH", url: `/roles/${roleId}`, headers: authHeaders(),
      payload: { instructions: "" },
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ id: roleId, instructions: "" });
    expect(persisted).toEqual([[roleId, ""]]);
    await app.close();
  });

  it("rejects a role-instructions PATCH without its required field before persistence", async () => {
    const { deps, calls } = createDeps();
    const app = buildApp(deps, { authToken: TOKEN, logger: false });
    const response = await app.inject({ method: "PATCH", url: `/roles/${roleId}`, headers: authHeaders(), payload: {} });
    expect(response.statusCode).toBe(400);
    expect(calls).not.toContain("updateRoleInstructions");
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

  it("validates five-field cron schedules before calling persistence and lists role routines", async () => {
    const { deps, calls } = createDeps({
      listRoutines: async (filter) => [makeRoutine({ roleId: filter.roleId ?? roleId })],
    });
    const app = buildApp(deps, { authToken: TOKEN, logger: false });
    const invalid = await app.inject({
      method: "POST", url: `/roles/${roleId}/routines`, headers: authHeaders(),
      payload: { name: "Invalid", schedule: "not cron" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(calls).not.toContain("createRoutine");

    const created = await app.inject({
      method: "POST", url: `/roles/${roleId}/routines`, headers: authHeaders(),
      payload: { name: " Daily ", schedule: "0 8 * * *", definition: { goal: "Report" } },
    });
    expect(created.statusCode).toBe(201);
    expect(JSON.parse(created.body)).toMatchObject({ name: "Daily", schedule: "0 8 * * *", nextFireAt: expect.any(String) });

    const listed = await app.inject({ method: "GET", url: `/roles/${roleId}/routines`, headers: authHeaders() });
    expect(listed.statusCode).toBe(200);
    expect(JSON.parse(listed.body)).toHaveLength(1);
    expect(calls).toContain("createRoutine");
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
    // TASK-191: the by-id write path now resolves tenant ownership first
    // (findTenantOwnedThread), adding "listRoles" ahead of the pre-existing
    // insert/create/run sequence.
    expect(calls).toEqual(["listAllThreadsWithMembers", "listRoles", "insertMessage", "createTask", "runChatTask"]);
    expect(result.body).toContain("Plan my day");
    await app.close();
  });

  it("uploads a file, binds a structured attachment on the message, and injects contents into the agent goal (TASK-166)", async () => {
    const root = await mkdtemp(join(tmpdir(), "oik-att-"));
    const unique = `task-166-marker-${randomUUID()}`;
    const created: Array<{ goal: string; title: string }> = [];
    const inserted: Array<Parameters<ControlApiDeps["insertMessage"]>[0]> = [];
    const { deps } = createDeps({
      createTask: async (input) => {
        created.push({ goal: input.goal, title: input.title });
        return makeTask(input);
      },
      insertMessage: async (input) => {
        inserted.push(input);
        return makeMessage(input);
      },
    });
    const app = buildApp(deps, {
      authToken: TOKEN,
      logger: false,
      attachmentStore: createFilesystemAttachmentStore(root),
    });
    try {
      const uploaded = await app.inject({
        method: "POST",
        url: `/threads/${threadId}/attachments`,
        headers: authHeaders(),
        payload: {
          filename: "briefing.txt",
          contentType: "text/plain",
          contentBase64: Buffer.from(unique, "utf8").toString("base64"),
        },
      });
      expect(uploaded.statusCode).toBe(201);
      const ref = JSON.parse(uploaded.body) as { id: string; filename: string; sha256: string; byteSize: number };
      expect(ref.filename).toBe("briefing.txt");
      expect(ref.byteSize).toBe(Buffer.byteLength(unique));
      expect(ref).not.toHaveProperty("absolutePath");
      expect(ref).not.toHaveProperty("storageKey");

      const posted = await app.inject({
        method: "POST",
        url: `/threads/${threadId}/messages`,
        headers: authHeaders(),
        payload: { body: "Please summarise the attachment.", attachmentIds: [ref.id] },
      });
      expect(posted.statusCode).toBe(201);
      expect(JSON.parse(posted.body).attachments).toEqual([
        expect.objectContaining({ id: ref.id, filename: "briefing.txt", contentType: "text/plain" }),
      ]);
      expect(inserted[0]?.attachments).toEqual([
        expect.objectContaining({ id: ref.id, filename: "briefing.txt" }),
      ]);
      expect(created[0]?.goal).toContain(unique);
      expect(created[0]?.goal).toContain("Absolute path:");
      const pathMatch = created[0]?.goal.match(/Absolute path: (.+)$/m);
      expect(pathMatch?.[1]).toBeDefined();
      expect(await readFile(pathMatch![1]!.trim(), "utf8")).toBe(unique);
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects oversized and disallowed attachment types server-side (TASK-166)", async () => {
    const { deps } = createDeps();
    const app = buildApp(deps, { authToken: TOKEN, logger: false });
    try {
      const disallowed = await app.inject({
        method: "POST",
        url: `/threads/${threadId}/attachments`,
        headers: authHeaders(),
        payload: {
          filename: "payload.exe",
          contentType: "application/x-msdownload",
          contentBase64: Buffer.from("MZ").toString("base64"),
        },
      });
      expect(disallowed.statusCode).toBe(400);
      expect(JSON.parse(disallowed.body).error).toContain("contentType is not allowed");
      expect(JSON.parse(disallowed.body).error).toContain(ATTACHMENT_ALLOWED_CONTENT_TYPES[0]);

      const oversized = await app.inject({
        method: "POST",
        url: `/threads/${threadId}/attachments`,
        headers: authHeaders(),
        payload: {
          filename: "huge.txt",
          contentType: "text/plain",
          contentBase64: Buffer.alloc(ATTACHMENT_MAX_BYTES + 1, 0x61).toString("base64"),
        },
      });
      expect(oversized.statusCode).toBe(400);
      expect(JSON.parse(oversized.body).error).toContain(`${String(ATTACHMENT_MAX_BYTES)}-byte limit`);
    } finally {
      await app.close();
    }
  });

  it("rejects unknown attachment ids and allows an attachments-only empty body (TASK-166)", async () => {
    const root = await mkdtemp(join(tmpdir(), "oik-att-empty-"));
    const { deps } = createDeps();
    const app = buildApp(deps, {
      authToken: TOKEN,
      logger: false,
      attachmentStore: createFilesystemAttachmentStore(root),
    });
    try {
      const missing = await app.inject({
        method: "POST",
        url: `/threads/${threadId}/messages`,
        headers: authHeaders(),
        payload: { body: "hi", attachmentIds: ["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"] },
      });
      expect(missing.statusCode).toBe(400);
      expect(JSON.parse(missing.body).error).toMatch(/not found/i);

      const uploaded = await app.inject({
        method: "POST",
        url: `/threads/${threadId}/attachments`,
        headers: authHeaders(),
        payload: {
          filename: "solo.txt",
          contentType: "text/plain",
          contentBase64: Buffer.from("solo-bytes", "utf8").toString("base64"),
        },
      });
      expect(uploaded.statusCode).toBe(201);
      const ref = JSON.parse(uploaded.body) as { id: string };

      const posted = await app.inject({
        method: "POST",
        url: `/threads/${threadId}/messages`,
        headers: authHeaders(),
        payload: { body: "   ", attachmentIds: [ref.id] },
      });
      expect(posted.statusCode).toBe(201);
      expect(JSON.parse(posted.body).body).toBe("");
      expect(JSON.parse(posted.body).attachments).toEqual([
        expect.objectContaining({ id: ref.id, filename: "solo.txt" }),
      ]);
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("grants a parked chat approval by dispatching the persisted run/session back to the worker, but never dispatches on rejection (TASK-155)", async () => {
    const runId = randomUUID();
    const sessionRef = randomUUID();
    const task = makeTask();
    const approval = makeApproval(runId);
    const dispatched: Array<Record<string, unknown>> = [];
    const { deps } = createDeps({
      decideApproval: async (_nonce, decision) => decision === "granted"
        ? { decided: true, rowCount: 1, approval: { ...approval, status: "granted" } }
        : { decided: true, rowCount: 1, approval: { ...approval, status: "rejected" } },
      getRun: async () => ({ runId, taskId: task.taskId, tenantId: task.tenantId, provider: "claude", sessionRef, status: "waiting_approval", startedAt: new Date(), endedAt: null, failureNote: null }),
      getTask: async () => task,
      runChatTask: async (input) => { dispatched.push(input as unknown as Record<string, unknown>); },
    });
    const app = buildApp(deps, { authToken: TOKEN, logger: false });
    const granted = await app.inject({ method: "POST", url: `/approvals/${approval.nonce}/decide`, headers: authHeaders(), payload: { decision: "granted", decidedBy: "human:test" } });
    expect(granted.statusCode).toBe(200);
    await new Promise((resolve) => setImmediate(resolve));
    expect(dispatched).toEqual([expect.objectContaining({ task, threadId, resume: { runId, sessionRef } })]);
    const rejected = await app.inject({ method: "POST", url: `/approvals/${approval.nonce}/decide`, headers: authHeaders(), payload: { decision: "rejected", decidedBy: "human:test" } });
    expect(rejected.statusCode).toBe(200);
    expect(dispatched).toHaveLength(1);
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

  it("posts a human message into a group and requests the existing fan-out gate before delivery", async () => {
    const groupThread = makeGroupThread();
    const fanoutRequests: Array<{ task: Task; memberRoleIds: readonly string[]; body: string }> = [];
    const inserted: Array<Parameters<ControlApiDeps["insertMessage"]>[0]> = [];
    const { deps, calls } = createDeps({
      listAllThreadsWithMembers: async () => { calls.push("listAllThreadsWithMembers"); return [groupThread]; },
      // TASK-191: group-thread ownership requires EVERY member role to
      // resolve under the caller's tenant — both roleId (default fixture)
      // and "second-bot" must be present, or findTenantOwnedThread 404s.
      listRoles: async () => { calls.push("listRoles"); return [makeRole(), makeRole({ roleId: "second-bot", name: "Second bot" })]; },
      requestGroupFanout: async (input) => {
        calls.push("requestGroupFanout");
        fanoutRequests.push(input);
        return { runId: randomUUID() };
      },
      insertMessage: async (input) => {
        calls.push("insertMessage");
        inserted.push(input);
        return makeMessage(input);
      },
    });
    const app = buildApp(deps, { authToken: TOKEN, logger: false });
    const result = await app.inject({
      method: "POST", url: `/threads/${groupThread.id}/messages`, headers: authHeaders(), payload: { body: "  Coordinate this  " },
    });
    expect(result.statusCode).toBe(201);
    expect(calls).toEqual(["listAllThreadsWithMembers", "listRoles", "createTask", "requestGroupFanout", "insertMessage"]);
    expect(fanoutRequests).toEqual([expect.objectContaining({ memberRoleIds: groupThread.memberRoleIds, body: "Coordinate this" })]);
    expect(inserted).toEqual([expect.objectContaining({
      threadId: groupThread.id, role: "user", body: "Coordinate this", senderRoleId: null, runId: expect.any(String),
    })]);
    await app.close();
  });

  it("attributes group-thread messages to their sender role and name", async () => {
    const senderRoleId = "second-bot";
    const groupThread = makeGroupThread();
    const { deps } = createDeps({
      // TASK-191: findTenantOwnedThread needs the group thread itself
      // (default fixture only returns the 1:1 thread) and every member
      // role — the calling role plus the sender — owned by the tenant.
      listAllThreadsWithMembers: async () => [groupThread],
      listMessages: async () => [makeMessage({ role: "bot", senderRoleId })],
      listRoles: async () => [makeRole(), makeRole({ roleId: senderRoleId, name: "Second bot" })],
    });
    const app = buildApp(deps, { authToken: TOKEN, logger: false });
    const response = await app.inject({ method: "GET", url: `/threads/${groupThread.id}/messages`, headers: authHeaders() });
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

  it("persists PATCHed role instructions through the real API and Postgres (TASK-156)", async () => {
    const app = buildApp(createDatabaseBackedDeps(options), { authToken: TOKEN, logger: false });
    try {
      const created = await app.inject({
        method: "POST", url: "/roles", headers: authHeaders(),
        payload: { name: `Persona ${randomUUID()}`, description: "Database persona fixture" },
      });
      expect(created.statusCode).toBe(201);
      const role = JSON.parse(created.body) as { id: string };
      const instructions = "Answer as this bot's dedicated product researcher.";
      const updated = await app.inject({
        method: "PATCH", url: `/roles/${role.id}`, headers: authHeaders(), payload: { instructions },
      });
      expect(updated.statusCode).toBe(200);
      expect(JSON.parse(updated.body)).toMatchObject({
        id: role.id,
        title: expect.stringContaining("Persona "),
        instructions,
      });
      expect((await getRole(options, role.id))?.instructions).toBe(instructions);

      const listedAfterPatch = await app.inject({ method: "GET", url: "/roles", headers: authHeaders() });
      expect(listedAfterPatch.statusCode).toBe(200);
      const serialized = (JSON.parse(listedAfterPatch.body) as Array<{
        id: string;
        title: string | null;
        instructions: string | null;
      }>).find((entry) => entry.id === role.id);
      expect(serialized).toMatchObject({ id: role.id, title: expect.stringContaining("Persona "), instructions });

      const cleared = await app.inject({
        method: "PATCH", url: `/roles/${role.id}`, headers: authHeaders(), payload: { instructions: "" },
      });
      expect(cleared.statusCode).toBe(200);
      expect(JSON.parse(cleared.body)).toMatchObject({ id: role.id, instructions: "" });
      expect((await getRole(options, role.id))?.instructions).toBe("");
    } finally {
      await app.close();
    }
  });

  it("serializes real title and null instructions from Postgres on GET /roles (TASK-165)", async () => {
    const app = buildApp(createDatabaseBackedDeps(options), { authToken: TOKEN, logger: false });
    try {
      const name = `Title ${randomUUID()}`;
      const created = await app.inject({
        method: "POST", url: "/roles", headers: authHeaders(),
        payload: { name, description: "Serialize-role fixture" },
      });
      expect(created.statusCode).toBe(201);
      const body = JSON.parse(created.body) as {
        id: string;
        name: string;
        title: string | null;
        instructions: string | null;
      };
      expect(body).toMatchObject({ name, title: name, instructions: null });
      const persisted = await getRole(options, body.id);
      expect(persisted?.title).toBe(name);
      expect(persisted?.instructions).toBeNull();
      expect(body.title).toBe(persisted?.title ?? null);
      expect(body.instructions).toBe(persisted?.instructions ?? null);

      const listed = await app.inject({ method: "GET", url: "/roles", headers: authHeaders() });
      expect(listed.statusCode).toBe(200);
      const serialized = (JSON.parse(listed.body) as Array<{
        id: string;
        title: string | null;
        instructions: string | null;
      }>).find((entry) => entry.id === body.id);
      expect(serialized).toEqual(expect.objectContaining({
        id: body.id,
        title: persisted?.title,
        instructions: null,
      }));
    } finally {
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

integration("GET /roles/:roleId/messages — real Postgres (TASK-160)", () => {
  const options: DatabaseOptions = { connectionString: connectionString ?? "" };

  it("lists exactly the persisted sent and received handoffs for one role", async () => {
    const app = buildApp(createDatabaseBackedDeps(options), { authToken: TOKEN, logger: false });
    try {
      const createRole = async (name: string) => {
        const response = await app.inject({
          method: "POST", url: "/roles", headers: authHeaders(), payload: { name, description: "TASK-160 integration fixture" },
        });
        expect(response.statusCode).toBe(201);
        return (JSON.parse(response.body) as { id: string }).id;
      };
      const [subject, sender, recipient] = await Promise.all([
        createRole(`Handoff subject ${randomUUID()}`),
        createRole(`Handoff sender ${randomUUID()}`),
        createRole(`Handoff recipient ${randomUUID()}`),
      ]);
      const sent = await sendRoleMessage(options, { tenantId: "basileia", fromRoleId: subject, toRoleId: recipient, body: "Persisted sent handoff" });
      const received = await sendRoleMessage(options, { tenantId: "basileia", fromRoleId: sender, toRoleId: subject, body: "Persisted received handoff" });
      await sendRoleMessage(options, { tenantId: "basileia", fromRoleId: sender, toRoleId: recipient, body: "Unrelated handoff" });

      const response = await app.inject({ method: "GET", url: `/roles/${subject}/messages`, headers: authHeaders() });
      expect(response.statusCode).toBe(200);
      const listed = JSON.parse(response.body) as Array<{ messageId: string; body: string }>;
      expect(listed).toEqual(expect.arrayContaining([
        expect.objectContaining({ messageId: sent.messageId, body: "Persisted sent handoff" }),
        expect.objectContaining({ messageId: received.messageId, body: "Persisted received handoff" }),
      ]));
      expect(listed).toHaveLength(2);
    } finally {
      await app.close();
    }
  });
});

integration("Role routines — cron scheduling, real Postgres (TASK-134)", () => {
  const options: DatabaseOptions = { connectionString: connectionString ?? "" };

  it("creates a scheduled routine with a persisted next fire time and lists it by role", async () => {
    const app = buildApp(createDatabaseBackedDeps(options), { authToken: TOKEN, logger: false });
    try {
      const roleRes = await app.inject({
        method: "POST", url: "/roles", headers: authHeaders(),
        payload: { name: `Routine ${randomUUID()}`, description: "TASK-134 integration fixture" },
      });
      expect(roleRes.statusCode).toBe(201);
      const role = JSON.parse(roleRes.body) as { id: string };

      const createdRes = await app.inject({
        method: "POST", url: `/roles/${role.id}/routines`, headers: authHeaders(),
        payload: { name: "Daily report", schedule: "0 8 * * *", definition: { goal: "Deliver report" } },
      });
      expect(createdRes.statusCode).toBe(201);
      const created = JSON.parse(createdRes.body) as { routineId: string; nextFireAt: string | null; lastFireAt: string | null; lastFireStatus: string | null };
      expect(created.nextFireAt).not.toBeNull();
      expect(new Date(created.nextFireAt!).getTime()).toBeGreaterThan(Date.now());
      expect(created.lastFireAt).toBeNull();
      expect(created.lastFireStatus).toBeNull();

      const persisted = await listRoutines(options, { tenantId: "basileia", roleId: role.id });
      expect(persisted).toHaveLength(1);
      expect(persisted[0]).toMatchObject({ routineId: created.routineId, name: "Daily report", schedule: "0 8 * * *" });
      expect(persisted[0]?.nextFireAt).not.toBeNull();

      const listRes = await app.inject({ method: "GET", url: `/roles/${role.id}/routines`, headers: authHeaders() });
      expect(listRes.statusCode).toBe(200);
      expect(JSON.parse(listRes.body)).toEqual(expect.arrayContaining([expect.objectContaining({ routineId: created.routineId })]));
    } finally {
      await app.close();
    }
  });
});

integration("POST /approvals/:nonce/decide — continues a parked chat run, real Postgres (TASK-155)", () => {
  const options: DatabaseOptions = { connectionString: connectionString ?? "" };

  it("grants a real pending approval, resumes its persisted SDK session, and appends the continuation to the original thread", async () => {
    const roleId = `task-155-${randomUUID()}`;
    const pool = new Pool({ connectionString: connectionString ?? "", ...defaultPoolConfig });
    let app: ReturnType<typeof buildApp> | undefined;
    try {
      const roleResult = await pool.query<{ role_id: string }>(
        `INSERT INTO roles (role_id, tenant_id, name, title, description)
         VALUES ($1, 'basileia', $1, 'TASK-155 route fixture', 'TASK-155 route fixture')
         RETURNING role_id`,
        [roleId],
      );
      expect(roleResult.rows[0]?.role_id).toBe(roleId);
      const threadResult = await pool.query<{ id: string }>(
        "INSERT INTO threads (role_id) VALUES ($1) RETURNING id",
        [roleId],
      );
      const resumedThreadId = threadResult.rows[0]!.id;
      const task = await createTask(options, {
        roleId,
        title: "TASK-155 approval continuation",
        goal: "Continue after the operator grants approval.",
        requestedBy: `chat:thread:${resumedThreadId}`,
      });
      const sessionRef = randomUUID();
      const parked = await startRun(options, {
        taskId: task.taskId,
        provider: "claude",
        tenantId: task.tenantId,
        sessionRef,
      });
      await parkRun(options, parked.runId);
      const approval = await insertApproval(options, {
        runId: parked.runId,
        capabilityId: "email.send",
        actionDigest: Buffer.from("task-155-approval"),
        actionRender: "Continue the parked chat run",
        destination: "operator@example.test",
        expiresAt: new Date(Date.now() + 60_000),
      });
      let observedResume: unknown;
      const queryFn = async function* (input: { options?: { resume?: unknown } }) {
        observedResume = input.options?.resume;
        yield { type: "result" as const, result: "The resumed SDK session completed." };
      };
      app = buildApp(
        createDatabaseBackedDeps({ ...options, chatRunDriverOptions: { queryFn } }),
        { authToken: TOKEN, logger: false },
      );

      const response = await app.inject({
        method: "POST",
        url: `/approvals/${approval.nonce}/decide`,
        headers: authHeaders(),
        payload: { decision: "granted", decidedBy: "human:task-155" },
      });
      expect(response.statusCode).toBe(200);

      for (let attempt = 0; attempt < 100; attempt += 1) {
        const run = (await listRuns(options, { taskId: task.taskId })).runs[0];
        if (run?.status === "completed") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(observedResume).toBe(sessionRef);
      expect((await listRuns(options, { taskId: task.taskId })).runs[0]).toMatchObject({
        runId: parked.runId,
        status: "completed",
        sessionRef,
      });
      expect((await listMessages(options, resumedThreadId)).find((message) => message.runId === parked.runId)?.body)
        .toBe("The resumed SDK session completed.");
    } finally {
      if (app !== undefined) await app.close();
      await pool.query("DELETE FROM audit_events WHERE run_id IN (SELECT run_id FROM runs WHERE task_id IN (SELECT task_id FROM tasks WHERE role_id = $1))", [roleId]);
      await pool.query("DELETE FROM approvals WHERE run_id IN (SELECT run_id FROM runs WHERE task_id IN (SELECT task_id FROM tasks WHERE role_id = $1))", [roleId]);
      await pool.query("DELETE FROM messages WHERE thread_id IN (SELECT id FROM threads WHERE role_id = $1)", [roleId]);
      await pool.query("DELETE FROM runs WHERE task_id IN (SELECT task_id FROM tasks WHERE role_id = $1)", [roleId]);
      await pool.query("DELETE FROM tasks WHERE role_id = $1", [roleId]);
      await pool.query("DELETE FROM thread_members WHERE role_id = $1", [roleId]);
      await pool.query("DELETE FROM threads WHERE role_id = $1", [roleId]);
      await pool.query("DELETE FROM role_grants WHERE role_id = $1", [roleId]);
      await pool.query("DELETE FROM roles WHERE role_id = $1", [roleId]);
      await pool.end();
    }
  });
});

integration("Group-thread control-api routes — real Postgres (TASK-121)", () => {
  const options: DatabaseOptions = { connectionString: connectionString ?? "" };
  const pool = new Pool({ connectionString: connectionString ?? "", ...defaultPoolConfig });
  const fixtureRoleIds: string[] = [];
  const fixtureThreadIds: string[] = [];

  async function cleanup(): Promise<void> {
    // TASK-126's group compose route creates a small dispatch task/run so
    // its approval can retain the same real run FK as TASK-122's gate.
    // Remove those dependents before their unique fixture roles.
    const taskIds = (await pool.query<{ task_id: string }>(
      "SELECT task_id FROM tasks WHERE requested_by LIKE 'chat:thread:%' AND role_id = ANY($1::text[])",
      [fixtureRoleIds],
    )).rows.map((row) => row.task_id);
    if (taskIds.length > 0) {
      const runIds = (await pool.query<{ run_id: string }>("SELECT run_id FROM runs WHERE task_id = ANY($1::uuid[])", [taskIds])).rows
        .map((row) => row.run_id);
      if (runIds.length > 0) {
        await pool.query("DELETE FROM messages WHERE run_id = ANY($1::uuid[])", [runIds]);
        await pool.query("DELETE FROM audit_events WHERE run_id = ANY($1::uuid[])", [runIds]);
        await pool.query("DELETE FROM approvals WHERE run_id = ANY($1::uuid[])", [runIds]);
        await pool.query("DELETE FROM runs WHERE run_id = ANY($1::uuid[])", [runIds]);
      }
      await pool.query("DELETE FROM tasks WHERE task_id = ANY($1::uuid[])", [taskIds]);
    }
    if (fixtureThreadIds.length > 0) {
      await pool.query("DELETE FROM messages WHERE thread_id = ANY($1::uuid[])", [fixtureThreadIds]);
      await pool.query("DELETE FROM thread_members WHERE thread_id = ANY($1::uuid[])", [fixtureThreadIds]);
      await pool.query("DELETE FROM threads WHERE id = ANY($1::uuid[])", [fixtureThreadIds]);
    }
    if (fixtureRoleIds.length > 0) {
      await pool.query("DELETE FROM role_grants WHERE role_id = ANY($1::text[])", [fixtureRoleIds]);
      await pool.query("DELETE FROM roles WHERE role_id = ANY($1::text[])", [fixtureRoleIds]);
    }
  }

  afterAll(async () => {
    await pool.end();
  });

  it("creates real memberships, lists 1:1 and group summaries, and attributes a group message", async () => {
    const app = buildApp(createDatabaseBackedDeps(options), { authToken: TOKEN, logger: false });
    try {
      const createRole = async (name: string) => {
        const response = await app.inject({
          method: "POST", url: "/roles", headers: authHeaders(),
          payload: { name, description: `${name} fixture` },
        });
        expect(response.statusCode).toBe(201);
        const created = JSON.parse(response.body) as { id: string; name: string };
        fixtureRoleIds.push(created.id);
        return created;
      };
      const first = await createRole(`Group first ${randomUUID()}`);
      const second = await createRole(`Group second ${randomUUID()}`);

      const oneToOneResponse = await app.inject({
        method: "POST", url: "/threads", headers: authHeaders(), payload: { roleId: first.id },
      });
      expect(oneToOneResponse.statusCode).toBe(201);
      fixtureThreadIds.push((JSON.parse(oneToOneResponse.body) as { id: string }).id);

      const groupResponse = await app.inject({
        method: "POST", url: "/threads/group", headers: authHeaders(),
        payload: { roleIds: [first.id, second.id], title: "Real group fixture" },
      });
      expect(groupResponse.statusCode).toBe(201);
      const group = JSON.parse(groupResponse.body) as { id: string; memberRoleIds: string[] };
      fixtureThreadIds.push(group.id);
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

      const posted = await app.inject({
        method: "POST", url: `/threads/${group.id}/messages`, headers: authHeaders(), payload: { body: "Human group dispatch" },
      });
      expect(posted.statusCode).toBe(201);
      const humanMessage = JSON.parse(posted.body) as { id: string; runId: string | null; senderRoleId: string | null };
      expect(humanMessage).toMatchObject({ senderRoleId: null, runId: expect.any(String) });

      const pendingApproval = await pool.query<{ status: string; capability_id: string }>(
        "SELECT status, capability_id FROM approvals WHERE run_id = $1",
        [humanMessage.runId],
      );
      expect(pendingApproval.rows).toEqual([{ status: "pending", capability_id: "chat.bot_fanout" }]);

      // The shared TASK-122 gate must stop before its direct-delivery branch:
      // this run may contain the human's group-thread message, but no newly
      // created 1:1 recipient-thread message. Removing the gate's fan-out
      // branch would make this assertion fail.
      const runMessages = await pool.query<{ thread_id: string; role: string; sender_role_id: string | null }>(
        "SELECT thread_id, role, sender_role_id FROM messages WHERE run_id = $1",
        [humanMessage.runId],
      );
      expect(runMessages.rows).toEqual([{ thread_id: group.id, role: "user", sender_role_id: null }]);
    } finally {
      try {
        await app.close();
      } finally {
        await cleanup();
      }
    }
  });
});

integration("POST /threads/:id/attachments — real Postgres + agent round trip (TASK-166)", () => {
  const options: DatabaseOptions = { connectionString: connectionString ?? "" };

  it("persists a file, records it on the message, and the chat driver actually reads the contents", async () => {
    const roleId = `task-166-${randomUUID()}`;
    const unique = `TASK-166-E2E-${randomUUID()}`;
    const pool = new Pool({ connectionString: connectionString ?? "", ...defaultPoolConfig });
    const storeRoot = await mkdtemp(join(tmpdir(), "oik-att-e2e-"));
    let app: ReturnType<typeof buildApp> | undefined;
    let observedPrompt = "";
    let observedDiskContents = "";
    try {
      await pool.query(
        `INSERT INTO roles (role_id, tenant_id, name, title, description)
         VALUES ($1, 'basileia', $1, 'TASK-166 attach fixture', 'TASK-166 attach fixture')`,
        [roleId],
      );
      const threadResult = await pool.query<{ id: string }>(
        "INSERT INTO threads (role_id) VALUES ($1) RETURNING id",
        [roleId],
      );
      const liveThreadId = threadResult.rows[0]!.id;
      const queryFn = async function* (input: { prompt: string | AsyncIterable<unknown> }) {
        observedPrompt = typeof input.prompt === "string" ? input.prompt : "";
        const pathMatch = observedPrompt.match(/Absolute path: (.+)$/m);
        if (pathMatch?.[1] !== undefined) {
          observedDiskContents = await readFile(pathMatch[1].trim(), "utf8");
        }
        yield { type: "result" as const, result: `I accessed the attachment and read: ${observedDiskContents}` };
      };
      app = buildApp(
        createDatabaseBackedDeps({ ...options, chatRunDriverOptions: { queryFn } }),
        {
          authToken: TOKEN,
          logger: false,
          attachmentStore: createFilesystemAttachmentStore(storeRoot),
        },
      );

      const uploaded = await app.inject({
        method: "POST",
        url: `/threads/${liveThreadId}/attachments`,
        headers: authHeaders(),
        payload: {
          filename: "secret-briefing.txt",
          contentType: "text/plain",
          contentBase64: Buffer.from(unique, "utf8").toString("base64"),
        },
      });
      expect(uploaded.statusCode).toBe(201);
      const ref = JSON.parse(uploaded.body) as { id: string };

      const posted = await app.inject({
        method: "POST",
        url: `/threads/${liveThreadId}/messages`,
        headers: authHeaders(),
        payload: { body: "What does the attached file say?", attachmentIds: [ref.id] },
      });
      expect(posted.statusCode).toBe(201);
      expect(JSON.parse(posted.body).attachments).toEqual([
        expect.objectContaining({ id: ref.id, filename: "secret-briefing.txt" }),
      ]);

      for (let attempt = 0; attempt < 200; attempt += 1) {
        const transcript = await listMessages(options, liveThreadId);
        if (transcript.some((message) => message.role === "bot" && message.body.includes(unique))) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      expect(observedPrompt).toContain(unique);
      expect(observedDiskContents).toBe(unique);
      const transcript = await listMessages(options, liveThreadId);
      const userMessage = transcript.find((message) => message.role === "user");
      const botMessage = transcript.find((message) => message.role === "bot");
      expect(userMessage?.attachments).toEqual([
        expect.objectContaining({ id: ref.id, filename: "secret-briefing.txt", contentType: "text/plain" }),
      ]);
      expect(userMessage?.body).toBe("What does the attached file say?");
      expect(botMessage?.body).toContain(unique);

      const listed = JSON.parse(
        (await app.inject({
          method: "GET",
          url: `/threads/${liveThreadId}/messages`,
          headers: authHeaders(),
        })).body,
      ) as Array<{ attachments?: unknown }>;
      expect(listed.find((message) => message.attachments !== undefined)?.attachments).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: ref.id, filename: "secret-briefing.txt" })]),
      );
    } finally {
      if (app !== undefined) await app.close();
      await pool.query("DELETE FROM audit_events WHERE run_id IN (SELECT run_id FROM runs WHERE task_id IN (SELECT task_id FROM tasks WHERE role_id = $1))", [roleId]);
      await pool.query("DELETE FROM approvals WHERE run_id IN (SELECT run_id FROM runs WHERE task_id IN (SELECT task_id FROM tasks WHERE role_id = $1))", [roleId]);
      await pool.query("DELETE FROM messages WHERE thread_id IN (SELECT id FROM threads WHERE role_id = $1)", [roleId]);
      await pool.query("DELETE FROM runs WHERE task_id IN (SELECT task_id FROM tasks WHERE role_id = $1)", [roleId]);
      await pool.query("DELETE FROM tasks WHERE role_id = $1", [roleId]);
      await pool.query("DELETE FROM thread_members WHERE role_id = $1", [roleId]);
      await pool.query("DELETE FROM threads WHERE role_id = $1", [roleId]);
      await pool.query("DELETE FROM role_grants WHERE role_id = $1", [roleId]);
      await pool.query("DELETE FROM roles WHERE role_id = $1", [roleId]);
      await pool.end();
      await rm(storeRoot, { recursive: true, force: true });
    }
  });
});
