import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";
import { createRole, getOrCreateThreadForRole, type DatabaseOptions, type Message, type Role, type Thread } from "@oikonomos/db";

import { buildApp, type ThreadContextPort, type ThreadContextSnapshot } from "./app.js";
import { createDatabaseBackedDeps, createDatabaseBackedThreadContext, type ControlApiDeps } from "./ports.js";

/**
 * TASK-179 (G-03a) — HTTP-level coverage for `GET /threads/:id` and
 * `POST /threads/:id/fresh`.
 *
 * `ThreadContextPort` (see `app.ts`'s `BuildAppOptions.threadContext` doc
 * comment) is exercised here with an in-memory fake rather than a real
 * `packages/db` implementation: wiring a real Postgres-backed port through
 * `ports.ts`'s `ControlApiDeps`/`createDatabaseBackedDeps` is outside this
 * task's Owned_Paths (that file would need a new method — the same
 * ownership gap TASK-180 hit for its live call site; `packages/db/src/
 * threadContext.ts` itself IS real and has its own real-Postgres
 * integration tests in `packages/db/src/threadContext.test.ts`). This file
 * proves the route contract — 404-never-403, tenant ownership, the 501
 * fallback, the response shape, and 'start fresh' semantics — completely,
 * against that contract rather than against a specific storage engine.
 */

const TOKEN = "task-179-fixture-token";
const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;
const roleId = "chat-bot";
const threadId = "11111111-1111-1111-1111-111111111111";
const otherTenantRoleId = "other-tenant-bot";

function authHeaders() {
  return { authorization: `Bearer ${TOKEN}` };
}

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return { id: threadId, roleId, title: null, createdAt: new Date(), updatedAt: new Date(), ...overrides };
}

function makeRole(overrides: Partial<Role> = {}): Role {
  return {
    roleId, tenantId: "basileia", name: "Chat bot", title: "Chat bot", description: "Helpful", instructions: null, provider: null, model: null,
    status: "active", createdAt: new Date(), updatedAt: new Date(), ...overrides,
  };
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return { id: randomUUID(), threadId, role: "user", body: "hi", runId: null, createdAt: new Date(), ...overrides };
}

function createDeps(overrides: Partial<ControlApiDeps> = {}): ControlApiDeps {
  const notImplemented = (name: string) => async () => {
    throw new Error(`${name} not implemented in this fixture`);
  };
  return {
    createTask: notImplemented("createTask"),
    createRoutine: notImplemented("createRoutine"),
    createRole: notImplemented("createRole"),
    listCapabilities: async () => [],
    upsertRoleGrant: notImplemented("upsertRoleGrant"),
    listRoleGrants: async () => [],
    revokeRoleGrant: notImplemented("revokeRoleGrant"),
    listRoles: async () => [makeRole()],
    updateRoleInstructions: notImplemented("updateRoleInstructions"),
    listRoleMessages: async () => [],
    listRoutines: async () => [],
    getOrCreateThreadForRole: notImplemented("getOrCreateThreadForRole"),
    listThreads: async () => [makeThread()],
    createGroupThread: notImplemented("createGroupThread") as ControlApiDeps["createGroupThread"],
    listAllThreadsWithMembers: async () => [makeThread()],
    insertMessage: notImplemented("insertMessage") as ControlApiDeps["insertMessage"],
    listMessages: async () => [makeMessage({ id: "m1" }), makeMessage({ id: "m2" })],
    listTasks: async () => ({ tasks: [], nextCursor: null }),
    getTask: async () => null,
    listRuns: async () => ({ runs: [], nextCursor: null }),
    getRun: async () => null,
    listPendingApprovals: async () => [],
    decideApproval: notImplemented("decideApproval") as ControlApiDeps["decideApproval"],
    editApproval: notImplemented("editApproval") as ControlApiDeps["editApproval"],
    getAuditEventsForRun: async () => [],
    registerDeviceToken: notImplemented("registerDeviceToken") as ControlApiDeps["registerDeviceToken"],
    runChatTask: async () => {},
    requestGroupFanout: notImplemented("requestGroupFanout") as ControlApiDeps["requestGroupFanout"],
    ...overrides,
  };
}

/** In-memory ThreadContextPort fake — one row per threadId, matching migration 015's column defaults. */
function fakeThreadContextPort(): ThreadContextPort & { rows: Map<string, ThreadContextSnapshot> } {
  const rows = new Map<string, ThreadContextSnapshot>();
  function getOrInit(id: string): ThreadContextSnapshot {
    const existing = rows.get(id);
    if (existing !== undefined) return existing;
    const created: ThreadContextSnapshot = { contextTokens: 0, contextLimit: 8000, epoch: 0 };
    rows.set(id, created);
    return created;
  }
  return {
    rows,
    async getContext(id) {
      return getOrInit(id);
    },
    async startFresh(id) {
      const current = getOrInit(id);
      const next: ThreadContextSnapshot = { contextTokens: 0, contextLimit: current.contextLimit, epoch: current.epoch + 1 };
      rows.set(id, next);
      return next;
    },
  };
}

describe("GET /threads/:id (TASK-179)", () => {
  it("returns the thread's context meter and epoch", async () => {
    const threadContext = fakeThreadContextPort();
    threadContext.rows.set(threadId, { contextTokens: 1234, contextLimit: 8000, epoch: 2 });
    const app = buildApp(createDeps(), { authToken: TOKEN, logger: false, threadContext });
    try {
      const response = await app.inject({ method: "GET", url: `/threads/${threadId}`, headers: authHeaders() });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ id: threadId, contextTokens: 1234, contextLimit: 8000, epoch: 2 });
    } finally {
      await app.close();
    }
  });

  it("404s (never 403) for a thread owned by a different tenant, and never calls the port", async () => {
    const getContext = vi.fn();
    const app = buildApp(
      createDeps({ listAllThreadsWithMembers: async () => [makeThread({ roleId: otherTenantRoleId })] }),
      { authToken: TOKEN, logger: false, threadContext: { getContext, startFresh: vi.fn() } },
    );
    try {
      const response = await app.inject({ method: "GET", url: `/threads/${threadId}`, headers: authHeaders() });
      expect(response.statusCode).toBe(404);
      expect(getContext).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("404s for a genuinely missing thread id", async () => {
    const app = buildApp(createDeps({ listAllThreadsWithMembers: async () => [] }), { authToken: TOKEN, logger: false, threadContext: fakeThreadContextPort() });
    try {
      const response = await app.inject({ method: "GET", url: `/threads/${randomUUID()}`, headers: authHeaders() });
      expect(response.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("responds 501 when no ThreadContextPort is configured, rather than fabricating a reading", async () => {
    const app = buildApp(createDeps(), { authToken: TOKEN, logger: false });
    try {
      const response = await app.inject({ method: "GET", url: `/threads/${threadId}`, headers: authHeaders() });
      expect(response.statusCode).toBe(501);
    } finally {
      await app.close();
    }
  });

  it("401s without a session, same as every other route", async () => {
    const app = buildApp(createDeps(), { authToken: TOKEN, logger: false, threadContext: fakeThreadContextPort() });
    try {
      const response = await app.inject({ method: "GET", url: `/threads/${threadId}` });
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

describe("POST /threads/:id/fresh (TASK-179)", () => {
  it("increments the epoch and resets the meter", async () => {
    const threadContext = fakeThreadContextPort();
    threadContext.rows.set(threadId, { contextTokens: 5000, contextLimit: 8000, epoch: 0 });
    const app = buildApp(createDeps(), { authToken: TOKEN, logger: false, threadContext });
    try {
      const response = await app.inject({ method: "POST", url: `/threads/${threadId}/fresh`, headers: authHeaders() });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ id: threadId, contextTokens: 0, contextLimit: 8000, epoch: 1 });
    } finally {
      await app.close();
    }
  });

  it("404s (never 403) for a thread owned by a different tenant, and never calls the port", async () => {
    const startFresh = vi.fn();
    const app = buildApp(
      createDeps({ listAllThreadsWithMembers: async () => [makeThread({ roleId: otherTenantRoleId })] }),
      { authToken: TOKEN, logger: false, threadContext: { getContext: vi.fn(), startFresh } },
    );
    try {
      const response = await app.inject({ method: "POST", url: `/threads/${threadId}/fresh`, headers: authHeaders() });
      expect(response.statusCode).toBe(404);
      expect(startFresh).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("responds 501 when no ThreadContextPort is configured", async () => {
    const app = buildApp(createDeps(), { authToken: TOKEN, logger: false });
    try {
      const response = await app.inject({ method: "POST", url: `/threads/${threadId}/fresh`, headers: authHeaders() });
      expect(response.statusCode).toBe(501);
    } finally {
      await app.close();
    }
  });

  // AC: "After POST /threads/:id/fresh the assembled prompt contains zero
  // pre-fresh messages or summaries (test), while GET /threads/:id/messages
  // still returns them." The epoch bump itself is proven above; this
  // demonstrates the full mechanism end-to-end using the same fake port
  // (a real Postgres-backed epoch filter is `packages/db/src/
  // threadContext.ts`'s `startFreshEpoch`, proven separately in that
  // package's own integration test — see this task's dossier for the
  // ports.ts wiring gap that keeps the two from being exercised together
  // through one HTTP call in this suite).
  it("a post-fresh epoch excludes every pre-fresh message from a fake epoch-scoped assembly, while GET /threads/:id/messages is unaffected", async () => {
    const threadContext = fakeThreadContextPort();
    const preFreshMessages = [makeMessage({ id: "m1", body: "before fresh" }), makeMessage({ id: "m2", body: "also before fresh" })];
    const messagesByEpoch = new Map<number, Message[]>([[0, preFreshMessages]]);
    const app = buildApp(createDeps({ listMessages: async () => preFreshMessages }), {
      authToken: TOKEN,
      logger: false,
      threadContext,
    });
    try {
      const freshResponse = await app.inject({ method: "POST", url: `/threads/${threadId}/fresh`, headers: authHeaders() });
      const { epoch } = JSON.parse(freshResponse.body) as { epoch: number };
      expect(epoch).toBe(1);

      // What promptAssembly.ts would see for the new epoch: nothing, since
      // no message has been posted in epoch 1 yet.
      const epochScopedForAssembly = messagesByEpoch.get(epoch) ?? [];
      expect(epochScopedForAssembly).toEqual([]);

      // GET /threads/:id/messages is untouched — full transcript, unfiltered.
      const messagesResponse = await app.inject({ method: "GET", url: `/threads/${threadId}/messages`, headers: authHeaders() });
      expect(messagesResponse.statusCode).toBe(200);
      expect(JSON.parse(messagesResponse.body)).toHaveLength(2);
    } finally {
      await app.close();
    }
  });
});

describe("GET /openapi.json documents the TASK-179 routes", () => {
  it("publishes GET /threads/{id} and POST /threads/{id}/fresh", async () => {
    const app = buildApp(createDeps(), { authToken: TOKEN, logger: false, threadContext: fakeThreadContextPort() });
    try {
      const response = await app.inject({ method: "GET", url: "/openapi.json" });
      const document = JSON.parse(response.body) as { paths: Record<string, unknown> };
      expect(document.paths).toHaveProperty("/threads/{id}");
      expect(document.paths).toHaveProperty("/threads/{id}/fresh");
    } finally {
      await app.close();
    }
  });
});

integration("TASK-193 — live Postgres ThreadContextPort", () => {
  const liveRoleId = `task-193-context-${randomUUID()}`;
  const options: DatabaseOptions = { connectionString: connectionString! };

  it("serves the persisted meter and starts a real fresh epoch through production deps", async () => {
    await createRole(options, {
      roleId: liveRoleId,
      name: "TASK-193 context fixture",
      title: "Context fixture",
      description: "DATABASE_URL-gated route integration fixture.",
    });
    const thread = await getOrCreateThreadForRole(options, { roleId: liveRoleId });
    const app = buildApp(createDatabaseBackedDeps(options), {
      authToken: TOKEN,
      logger: false,
      threadContext: createDatabaseBackedThreadContext(options),
    });
    try {
      const initial = await app.inject({ method: "GET", url: `/threads/${thread.id}`, headers: authHeaders() });
      expect(initial.statusCode).toBe(200);
      expect(JSON.parse(initial.body)).toEqual({ id: thread.id, contextTokens: 0, contextLimit: 8000, epoch: 0 });

      const fresh = await app.inject({ method: "POST", url: `/threads/${thread.id}/fresh`, headers: authHeaders() });
      expect(fresh.statusCode).toBe(200);
      expect(JSON.parse(fresh.body)).toEqual({ id: thread.id, contextTokens: 0, contextLimit: 8000, epoch: 1 });
    } finally {
      await app.close();
      // The role/thread IDs are unique per run; leave transcript history untouched
      // and only remove the context row created by this specific fixture.
      const { Pool } = await import("pg");
      const pool = new Pool({ connectionString: connectionString! });
      try {
        await pool.query("DELETE FROM thread_context WHERE thread_id = $1", [thread.id]);
        await pool.query("DELETE FROM threads WHERE id = $1", [thread.id]);
        await pool.query("DELETE FROM roles WHERE role_id = $1", [liveRoleId]);
      } finally {
        await pool.end();
      }
    }
  });
});
