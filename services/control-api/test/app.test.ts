import { createHash, randomUUID } from "node:crypto";
import { createServer, Socket, type Server } from "node:net";
import { Writable } from "node:stream";

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { Approval, AuditEvent, Message, Role, Routine, Run, Task, Thread } from "@oikonomos/db";
import { DEFAULT_APPROVAL_TTL_MS, type ApprovalWaitSignal, type EditApprovalResult } from "@oikonomos/approvals";

import { buildApp, type BuildAppOptions } from "../src/app.js";
import type { ControlApiDeps } from "../src/ports.js";
import { createSessionToken, SESSION_TTL_MS } from "../src/auth.js";
import {
  registerLiveAgentRoutes,
  type LiveAgentPort,
  type LiveAgentSandboxRef,
} from "../src/liveAgent.routes.js";
import {
  registerBrowserTakeoverRoutes,
  type BrowserTakeoverPort,
  type TakeoverStatusPort,
} from "../src/browserTakeover.routes.js";

/**
 * TASK-101: every test in this file that exercises a protected route must
 * authenticate, since the global auth preHandler now denies unauthenticated
 * requests fail-closed. `TEST_TOKEN` is a fixture value, never a real
 * secret (N4 — no credentials in test fixtures; this is a made-up string,
 * not anything from a real environment).
 */
const TEST_TOKEN = "task-101-fixture-shared-secret";

function authHeaders(): { authorization: string } {
  return { authorization: `Bearer ${TEST_TOKEN}` };
}

function buildTestApp(deps: ControlApiDeps, overrides: Partial<BuildAppOptions> = {}) {
  return buildApp(deps, { authToken: TEST_TOKEN, logger: false, ...overrides });
}

function fixtureTask(overrides: Partial<Task> = {}): Task {
  return {
    taskId: randomUUID(),
    tenantId: "basileia",
    roleId: "inbox-triage",
    title: "Triage inbox",
    goal: "Draft replies to unread messages",
    status: "draft",
    routineId: null,
    requestedBy: "telegram:user:1",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function fixtureRun(overrides: Partial<Run> = {}): Run {
  return {
    runId: randomUUID(),
    taskId: randomUUID(),
    tenantId: "basileia",
    provider: "claude",
    sessionRef: null,
    status: "started",
    startedAt: new Date(),
    endedAt: null,
    failureNote: null,
    ...overrides,
  };
}

function fixtureApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    approvalId: randomUUID(),
    tenantId: "basileia",
    runId: randomUUID(),
    capabilityId: "email.create_draft",
    actionDigest: Buffer.from("digest-bytes"),
    actionRender: "Create a Gmail draft to review@example.test",
    destination: "review@example.test",
    nonce: randomUUID(),
    status: "pending",
    requestedAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    decidedBy: null,
    decidedAt: null,
    consumedAt: null,
    ...overrides,
  };
}

function fixtureWaitSignal(overrides: Partial<ApprovalWaitSignal> = {}): ApprovalWaitSignal {
  return {
    reason: "approval_pending",
    approvalId: randomUUID(),
    nonce: randomUUID(),
    expiresAt: new Date(Date.now() + 60_000),
    actionDigest: "ab".repeat(32),
    actionRender: "Create a Gmail draft to review@example.test",
    destination: "review@example.test",
    status: "pending",
    ...overrides,
  };
}

function fixtureAuditEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    eventId: "1",
    tenantId: "basileia",
    runId: randomUUID(),
    at: new Date(),
    actor: "worker",
    eventType: "tool.result",
    capability: "email.create_draft",
    tier: "T1_draft",
    payload: { digest: "abc123" },
    evidenceUri: null,
    ...overrides,
  };
}

interface FakeDeps extends ControlApiDeps {
  readonly calls: { name: string; args: unknown[] }[];
}

function createFakeDeps(overrides: Partial<ControlApiDeps> = {}): FakeDeps {
  const calls: { name: string; args: unknown[] }[] = [];
  const record =
    (name: string, fn: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) => {
      calls.push({ name, args });
      return fn(...args);
    };

  const defaults: ControlApiDeps = {
    createTask: async (input) => fixtureTask(input),
    listTasks: async () => ({ tasks: [fixtureTask()], nextCursor: null }),
    listRuns: async () => ({ runs: [fixtureRun()], nextCursor: null }),
    getRun: async (runId) => fixtureRun({ runId }),
    listPendingApprovals: async () => [fixtureApproval()],
    decideApproval: async () => ({ decided: false, rowCount: 0 }),
    editApproval: async () => ({ edited: false, rowCount: 0 }),
    getAuditEventsForRun: async () => [fixtureAuditEvent()],
    ...overrides,
  };

  return {
    calls,
    createTask: record("createTask", defaults.createTask as never) as ControlApiDeps["createTask"],
    listTasks: record("listTasks", defaults.listTasks as never) as ControlApiDeps["listTasks"],
    listRuns: record("listRuns", defaults.listRuns as never) as ControlApiDeps["listRuns"],
    getRun: record("getRun", defaults.getRun as never) as ControlApiDeps["getRun"],
    listPendingApprovals: record(
      "listPendingApprovals",
      defaults.listPendingApprovals as never,
    ) as ControlApiDeps["listPendingApprovals"],
    decideApproval: record("decideApproval", defaults.decideApproval as never) as ControlApiDeps["decideApproval"],
    editApproval: record("editApproval", defaults.editApproval as never) as ControlApiDeps["editApproval"],
    getAuditEventsForRun: record(
      "getAuditEventsForRun",
      defaults.getAuditEventsForRun as never,
    ) as ControlApiDeps["getAuditEventsForRun"],
  };
}

describe("buildApp — fail-closed authToken requirement (TASK-101)", () => {
  it("throws synchronously when authToken is empty rather than building an unauthenticated app", () => {
    expect(() => buildApp(createFakeDeps(), { authToken: "", logger: false })).toThrow(/authToken/);
  });

  it("throws synchronously when authToken is whitespace-only", () => {
    expect(() => buildApp(createFakeDeps(), { authToken: "   ", logger: false })).toThrow(/authToken/);
  });
});

describe("Auth gate — every existing route denies an unauthenticated request (TASK-101 AC #1, #5 LIVENESS)", () => {
  /**
   * These assertions are the LIVENESS proof the task's AC #5 requires:
   * each one hits a route with NO Authorization header and NO session
   * cookie and asserts 401, with the fake port never invoked. If the
   * global `preHandler` auth gate were ever removed from `app.ts`, every
   * one of these would flip to the route's normal success/validation
   * status code instead of 401 — turning this whole block red.
   */
  it("POST /tasks", async () => {
    const deps = createFakeDeps();
    const app = buildTestApp(deps);
    const res = await app.inject({
      method: "POST",
      url: "/tasks",
      payload: { roleId: "inbox-triage", title: "t", goal: "g", requestedBy: "telegram:user:1" },
    });
    expect(res.statusCode).toBe(401);
    expect(deps.calls).toHaveLength(0);
    await app.close();
  });

  it("GET /tasks", async () => {
    const deps = createFakeDeps();
    const app = buildTestApp(deps);
    const res = await app.inject({ method: "GET", url: "/tasks" });
    expect(res.statusCode).toBe(401);
    expect(deps.calls).toHaveLength(0);
    await app.close();
  });

  it("GET /runs", async () => {
    const deps = createFakeDeps();
    const app = buildTestApp(deps);
    const res = await app.inject({ method: "GET", url: "/runs" });
    expect(res.statusCode).toBe(401);
    expect(deps.calls).toHaveLength(0);
    await app.close();
  });

  it("GET /runs/:id", async () => {
    const deps = createFakeDeps();
    const app = buildTestApp(deps);
    const res = await app.inject({ method: "GET", url: `/runs/${randomUUID()}` });
    expect(res.statusCode).toBe(401);
    expect(deps.calls).toHaveLength(0);
    await app.close();
  });

  it("GET /runs/:id/evidence", async () => {
    const deps = createFakeDeps();
    const app = buildTestApp(deps);
    const res = await app.inject({ method: "GET", url: `/runs/${randomUUID()}/evidence` });
    expect(res.statusCode).toBe(401);
    expect(deps.calls).toHaveLength(0);
    await app.close();
  });

  it("GET /approvals", async () => {
    const deps = createFakeDeps();
    const app = buildTestApp(deps);
    const res = await app.inject({ method: "GET", url: "/approvals" });
    expect(res.statusCode).toBe(401);
    expect(deps.calls).toHaveLength(0);
    await app.close();
  });

  it("POST /approvals/:nonce/decide", async () => {
    const deps = createFakeDeps();
    const app = buildTestApp(deps);
    const res = await app.inject({
      method: "POST",
      url: `/approvals/${randomUUID()}/decide`,
      payload: { decision: "granted", decidedBy: "telegram:user:1" },
    });
    expect(res.statusCode).toBe(401);
    expect(deps.calls).toHaveLength(0);
    await app.close();
  });

  it("POST /approvals/:nonce/edit", async () => {
    const deps = createFakeDeps();
    const app = buildTestApp(deps);
    const res = await app.inject({
      method: "POST",
      url: `/approvals/${randomUUID()}/edit`,
      payload: {
        runId: randomUUID(),
        capabilityId: "email.create_draft",
        toolName: "create_draft",
        input: {},
        destination: "review@example.test",
      },
    });
    expect(res.statusCode).toBe(401);
    expect(deps.calls).toHaveLength(0);
    await app.close();
  });

  it("an invalid/garbage bearer token is rejected just like a missing one", async () => {
    const deps = createFakeDeps();
    const app = buildTestApp(deps);
    const res = await app.inject({ method: "GET", url: "/runs", headers: { authorization: "Bearer not-the-token" } });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("an invalid/garbage session cookie is rejected just like a missing one", async () => {
    const deps = createFakeDeps();
    const app = buildTestApp(deps);
    const res = await app.inject({ method: "GET", url: "/runs", headers: { cookie: "control_api_session=garbage" } });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("GET /openapi.json requires no auth", async () => {
    const deps = createFakeDeps();
    const app = buildTestApp(deps);
    const res = await app.inject({ method: "GET", url: "/openapi.json" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

describe("POST /auth/login (TASK-101)", () => {
  it("issues a session cookie for the correct token, requiring no prior auth itself", async () => {
    const deps = createFakeDeps();
    const app = buildTestApp(deps);
    const res = await app.inject({ method: "POST", url: "/auth/login", payload: { token: TEST_TOKEN } });
    expect(res.statusCode).toBe(200);
    const setCookie = res.headers["set-cookie"];
    expect(setCookie).toBeDefined();
    expect(String(setCookie)).toContain("control_api_session=");
    expect(String(setCookie)).toContain("HttpOnly");
    await app.close();
  });

  it("rejects an incorrect token with 401 and issues no cookie", async () => {
    const deps = createFakeDeps();
    const app = buildTestApp(deps);
    const res = await app.inject({ method: "POST", url: "/auth/login", payload: { token: "wrong" } });
    expect(res.statusCode).toBe(401);
    expect(res.headers["set-cookie"]).toBeUndefined();
    await app.close();
  });

  it("never echoes CONTROL_API_TOKEN or the session token in the response body (N4)", async () => {
    const deps = createFakeDeps();
    const app = buildTestApp(deps);
    const res = await app.inject({ method: "POST", url: "/auth/login", payload: { token: "wrong" } });
    expect(res.body).not.toContain(TEST_TOKEN);
    await app.close();
  });

  it("the issued session cookie authenticates a subsequent request to a protected route", async () => {
    const deps = createFakeDeps();
    const app = buildTestApp(deps);
    const loginRes = await app.inject({ method: "POST", url: "/auth/login", payload: { token: TEST_TOKEN } });
    const setCookie = String(loginRes.headers["set-cookie"]);
    const cookieValue = setCookie.split(";")[0];
    expect(cookieValue).toBeTruthy();

    const runsRes = await app.inject({ method: "GET", url: "/runs", headers: { cookie: cookieValue } });
    expect(runsRes.statusCode).toBe(200);
    await app.close();
  });
});

describe("GET /openapi.json", () => {
  it("serves a document covering every registered route", async () => {
    const app = buildTestApp(createFakeDeps());
    const res = await app.inject({ method: "GET", url: "/openapi.json" });
    expect(res.statusCode).toBe(200);
    const doc = JSON.parse(res.body) as { paths: Record<string, unknown> };
    for (const path of [
      "/auth/login",
      "/tasks",
      "/runs",
      "/runs/{id}",
      "/runs/{id}/evidence",
      "/approvals",
      "/approvals/{nonce}/decide",
      "/approvals/{nonce}/edit",
    ]) {
      expect(doc.paths[path], `missing OpenAPI path ${path}`).toBeDefined();
    }
    await app.close();
  });
});

describe("POST /tasks", () => {
  it("creates a task via the db port and returns 201", async () => {
    const deps = createFakeDeps();
    const app = buildTestApp(deps);
    const res = await app.inject({
      method: "POST",
      url: "/tasks",
      headers: authHeaders(),
      payload: { roleId: "inbox-triage", title: "t", goal: "g", requestedBy: "telegram:user:1" },
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).title).toBe("t");
    expect(deps.calls.map((c) => c.name)).toEqual(["createTask"]);
    await app.close();
  });

  it("rejects a body missing required fields with 400, before reaching the port", async () => {
    const deps = createFakeDeps();
    const app = buildTestApp(deps);
    const res = await app.inject({
      method: "POST",
      url: "/tasks",
      headers: authHeaders(),
      payload: { title: "only a title" },
    });
    expect(res.statusCode).toBe(400);
    expect(deps.calls).toHaveLength(0);
    await app.close();
  });
});

describe("GET /tasks (TASK-101)", () => {
  it("lists tasks and passes query filters through to the port", async () => {
    const deps = createFakeDeps();
    const app = buildTestApp(deps);
    const res = await app.inject({
      method: "GET",
      url: "/tasks?status=draft&limit=5",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { tasks: unknown[]; nextCursor: string | null };
    expect(body.tasks).toHaveLength(1);
    expect(deps.calls[0]).toEqual({ name: "listTasks", args: [{ status: "draft", limit: 5 }] });
    await app.close();
  });

  it("rejects an unknown status value with 400 before reaching the port", async () => {
    const deps = createFakeDeps();
    const app = buildTestApp(deps);
    const res = await app.inject({
      method: "GET",
      url: "/tasks?status=not-a-status",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(400);
    expect(deps.calls).toHaveLength(0);
    await app.close();
  });
});

describe("GET /runs", () => {
  it("lists runs and passes query filters through to the port", async () => {
    const deps = createFakeDeps();
    const app = buildTestApp(deps);
    const res = await app.inject({ method: "GET", url: "/runs?status=started&limit=5", headers: authHeaders() });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { runs: unknown[]; nextCursor: string | null };
    expect(body.runs).toHaveLength(1);
    expect(deps.calls[0]).toEqual({ name: "listRuns", args: [{ status: "started", limit: 5 }] });
    await app.close();
  });

  it("rejects an unknown status value with 400 before reaching the port", async () => {
    const deps = createFakeDeps();
    const app = buildTestApp(deps);
    const res = await app.inject({ method: "GET", url: "/runs?status=not-a-status", headers: authHeaders() });
    expect(res.statusCode).toBe(400);
    expect(deps.calls).toHaveLength(0);
    await app.close();
  });
});

describe("GET /runs/:id", () => {
  it("returns 200 with the run when found", async () => {
    const run = fixtureRun();
    const deps = createFakeDeps({ getRun: async () => run });
    const app = buildTestApp(deps);
    const res = await app.inject({ method: "GET", url: `/runs/${run.runId}`, headers: authHeaders() });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).runId).toBe(run.runId);
    await app.close();
  });

  it("returns 404 when the port reports no such run", async () => {
    const deps = createFakeDeps({ getRun: async () => null });
    const app = buildTestApp(deps);
    const res = await app.inject({ method: "GET", url: `/runs/${randomUUID()}`, headers: authHeaders() });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("GET /runs/:id/evidence", () => {
  it("returns the run's audit events", async () => {
    const events = [fixtureAuditEvent(), fixtureAuditEvent({ eventId: "2" })];
    const deps = createFakeDeps({ getAuditEventsForRun: async () => events });
    const app = buildTestApp(deps);
    const res = await app.inject({ method: "GET", url: `/runs/${randomUUID()}/evidence`, headers: authHeaders() });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toHaveLength(2);
    await app.close();
  });
});

describe("GET /approvals", () => {
  it("lists pending approvals with actionDigest serialized as base64", async () => {
    const approval = fixtureApproval();
    const deps = createFakeDeps({ listPendingApprovals: async () => [approval] });
    const app = buildTestApp(deps);
    const res = await app.inject({ method: "GET", url: "/approvals", headers: authHeaders() });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { actionDigest: string }[];
    expect(body[0]?.actionDigest).toBe(Buffer.from(approval.actionDigest).toString("base64"));
    await app.close();
  });
});

describe("POST /approvals/:nonce/decide", () => {
  it("returns 200 with the decided approval when the port reports decided:true", async () => {
    const approval = fixtureApproval({ status: "granted" });
    const deps = createFakeDeps({
      decideApproval: async () => ({ decided: true, rowCount: 1, approval }),
    });
    const app = buildTestApp(deps);
    const res = await app.inject({
      method: "POST",
      url: `/approvals/${approval.nonce}/decide`,
      headers: authHeaders(),
      payload: { decision: "granted", decidedBy: "telegram:user:1" },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).decided).toBe(true);
    expect(deps.calls[0]).toEqual({
      name: "decideApproval",
      args: [approval.nonce, "granted", "telegram:user:1"],
    });
    await app.close();
  });

  it("returns 409 when the port reports decided:false (already decided / expired / unknown nonce)", async () => {
    const deps = createFakeDeps({ decideApproval: async () => ({ decided: false, rowCount: 0 }) });
    const app = buildTestApp(deps);
    const res = await app.inject({
      method: "POST",
      url: `/approvals/${randomUUID()}/decide`,
      headers: authHeaders(),
      payload: { decision: "rejected", decidedBy: "telegram:user:1" },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).decided).toBe(false);
    await app.close();
  });

  it("rejects a body with an invalid decision value before reaching the port", async () => {
    const deps = createFakeDeps();
    const app = buildTestApp(deps);
    const res = await app.inject({
      method: "POST",
      url: `/approvals/${randomUUID()}/decide`,
      headers: authHeaders(),
      payload: { decision: "maybe", decidedBy: "telegram:user:1" },
    });
    expect(res.statusCode).toBe(400);
    expect(deps.calls).toHaveLength(0);
    await app.close();
  });
});

describe("POST /approvals/:nonce/edit", () => {
  function editBody(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
    return {
      runId: randomUUID(),
      capabilityId: "email.create_draft",
      toolName: "create_draft",
      input: { subject: "edited subject" },
      destination: "review@example.test",
      ...overrides,
    };
  }

  it("returns 200 with the invalidated approval and the replacement wait signal when the port reports edited:true", async () => {
    const invalidated = fixtureApproval({ status: "invalidated" });
    const replacement = fixtureWaitSignal();
    const deps = createFakeDeps({
      editApproval: async (): Promise<EditApprovalResult> => ({
        edited: true,
        rowCount: 1,
        invalidated,
        replacement,
      }),
    });
    const app = buildTestApp(deps);
    const res = await app.inject({
      method: "POST",
      url: `/approvals/${invalidated.nonce}/edit`,
      headers: authHeaders(),
      payload: editBody(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      edited: boolean;
      invalidated: { actionDigest: string; status: string };
      replacement: ApprovalWaitSignal;
    };
    expect(body.edited).toBe(true);
    expect(body.invalidated.status).toBe("invalidated");
    expect(body.invalidated.actionDigest).toBe(Buffer.from(invalidated.actionDigest).toString("base64"));
    expect(body.replacement).toEqual({ ...replacement, expiresAt: replacement.expiresAt.toISOString() });
    await app.close();
  });

  it("returns 409 when the port reports edited:false (not pending, expired, or unknown nonce)", async () => {
    const deps = createFakeDeps({ editApproval: async () => ({ edited: false, rowCount: 0 }) });
    const app = buildTestApp(deps);
    const res = await app.inject({
      method: "POST",
      url: `/approvals/${randomUUID()}/edit`,
      headers: authHeaders(),
      payload: editBody(),
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).edited).toBe(false);
    await app.close();
  });

  it("rejects a body missing required fields with 400, before reaching the port", async () => {
    const deps = createFakeDeps();
    const app = buildTestApp(deps);
    const res = await app.inject({
      method: "POST",
      url: `/approvals/${randomUUID()}/edit`,
      headers: authHeaders(),
      payload: { runId: randomUUID() },
    });
    expect(res.statusCode).toBe(400);
    expect(deps.calls).toHaveLength(0);
    await app.close();
  });

  it("strips a caller-supplied 'render' field before it ever reaches the port — ADR-004 render is always derived, never accepted", async () => {
    const deps = createFakeDeps({ editApproval: async () => ({ edited: false, rowCount: 0 }) });
    const app = buildTestApp(deps);
    await app.inject({
      method: "POST",
      url: `/approvals/${randomUUID()}/edit`,
      headers: authHeaders(),
      payload: editBody({ render: "a caller-authored render" }),
    });
    expect(deps.calls).toHaveLength(1);
    const forwarded = deps.calls[0]?.args[1] as Record<string, unknown>;
    expect(forwarded).not.toHaveProperty("render");
    await app.close();
  });

  it("forwards tenantId through to the port on every call, even for a non-basileia tenant (round-2 TASK-080 lesson)", async () => {
    const deps = createFakeDeps({ editApproval: async () => ({ edited: false, rowCount: 0 }) });
    const app = buildTestApp(deps);
    const nonce = randomUUID();
    await app.inject({
      method: "POST",
      url: `/approvals/${nonce}/edit`,
      headers: authHeaders(),
      payload: editBody({ tenantId: "acme" }),
    });
    expect(deps.calls[0]?.name).toBe("editApproval");
    const forwarded = deps.calls[0]?.args[1] as { tenantId?: string };
    expect(forwarded.tenantId).toBe("acme");
    await app.close();
  });

  it("forwards tenantId as undefined (not silently coerced) when the caller omits it — editApproval owns the default", async () => {
    const deps = createFakeDeps({ editApproval: async () => ({ edited: false, rowCount: 0 }) });
    const app = buildTestApp(deps);
    await app.inject({
      method: "POST",
      url: `/approvals/${randomUUID()}/edit`,
      headers: authHeaders(),
      payload: editBody(),
    });
    const forwarded = deps.calls[0]?.args[1] as { tenantId?: string };
    expect(forwarded.tenantId).toBeUndefined();
    await app.close();
  });

  it("forwards an expiresAt string as a Date to the port", async () => {
    const deps = createFakeDeps({ editApproval: async () => ({ edited: false, rowCount: 0 }) });
    const app = buildTestApp(deps);
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    await app.inject({
      method: "POST",
      url: `/approvals/${randomUUID()}/edit`,
      headers: authHeaders(),
      payload: editBody({ expiresAt }),
    });
    const forwarded = deps.calls[0]?.args[1] as { expiresAt?: Date };
    expect(forwarded.expiresAt).toBeInstanceOf(Date);
    expect(forwarded.expiresAt?.toISOString()).toBe(expiresAt);
    await app.close();
  });

  it("rejects a past expiresAt with 400 before reaching the port — original approval left untouched", async () => {
    const deps = createFakeDeps({
      editApproval: async () => ({ edited: true, rowCount: 1, invalidated: fixtureApproval(), replacement: fixtureWaitSignal() }),
    });
    const app = buildTestApp(deps);
    const pastExpiresAt = new Date(Date.now() - 1_000).toISOString();
    const res = await app.inject({
      method: "POST",
      url: `/approvals/${randomUUID()}/edit`,
      headers: authHeaders(),
      payload: editBody({ expiresAt: pastExpiresAt }),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/strictly in the future/);
    // never reaches editApproval — the ONLY way the original approval can
    // be left untouched, since editApproval is what performs the invalidate.
    expect(deps.calls).toHaveLength(0);
    await app.close();
  });

  it("rejects an expiresAt beyond the platform approval TTL with 400 before reaching the port", async () => {
    const deps = createFakeDeps({
      editApproval: async () => ({ edited: true, rowCount: 1, invalidated: fixtureApproval(), replacement: fixtureWaitSignal() }),
    });
    const app = buildTestApp(deps);
    const excessiveExpiresAt = new Date(Date.now() + DEFAULT_APPROVAL_TTL_MS + 24 * 60 * 60 * 1000).toISOString();
    const res = await app.inject({
      method: "POST",
      url: `/approvals/${randomUUID()}/edit`,
      headers: authHeaders(),
      payload: editBody({ expiresAt: excessiveExpiresAt }),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/exceed the platform approval TTL/);
    expect(deps.calls).toHaveLength(0);
    await app.close();
  });

  it("accepts an omitted expiresAt — inherits editApproval's own default, no bound check applied", async () => {
    const deps = createFakeDeps({
      editApproval: async () => ({ edited: true, rowCount: 1, invalidated: fixtureApproval(), replacement: fixtureWaitSignal() }),
    });
    const app = buildTestApp(deps);
    const res = await app.inject({
      method: "POST",
      url: `/approvals/${randomUUID()}/edit`,
      headers: authHeaders(),
      payload: editBody(),
    });
    expect(res.statusCode).toBe(200);
    const forwarded = deps.calls[0]?.args[1] as { expiresAt?: Date };
    expect(forwarded.expiresAt).toBeUndefined();
    await app.close();
  });

  it("returns 400 when the port throws (e.g. identity mismatch rejected inside editApproval)", async () => {
    const deps = createFakeDeps({
      editApproval: async () => {
        throw new Error("editApproval cannot rebind run_id.");
      },
    });
    const app = buildTestApp(deps);
    const res = await app.inject({
      method: "POST",
      url: `/approvals/${randomUUID()}/edit`,
      headers: authHeaders(),
      payload: editBody(),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/rebind run_id/);
    await app.close();
  });
});

describe("redactApprovalNonceFromUrl (unit)", () => {
  it("replaces the nonce path segment and leaves the rest of the url intact", async () => {
    const { redactApprovalNonceFromUrl } = await import("../src/redact.js");
    const nonce = randomUUID();
    expect(redactApprovalNonceFromUrl(`/approvals/${nonce}/decide`)).toBe("/approvals/[REDACTED]/decide");
    expect(redactApprovalNonceFromUrl(`/approvals/${nonce}/edit`)).toBe("/approvals/[REDACTED]/edit");
  });

  it("leaves unrelated urls untouched", async () => {
    const { redactApprovalNonceFromUrl } = await import("../src/redact.js");
    expect(redactApprovalNonceFromUrl("/runs")).toBe("/runs");
    expect(redactApprovalNonceFromUrl("/approvals")).toBe("/approvals");
  });
});

describe("N4 log redaction on the approvals decide route", () => {
  it("never emits the nonce anywhere in the real pino log output for that request", async () => {
    const nonce = randomUUID();
    const approval = fixtureApproval({ nonce, status: "granted" });
    const deps = createFakeDeps({ decideApproval: async () => ({ decided: true, rowCount: 1, approval }) });

    const chunks: Buffer[] = [];
    const logStream = new Writable({
      write(chunk: Buffer, _enc, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });

    const app = buildTestApp(deps, { logger: undefined, logStream });
    const res = await app.inject({
      method: "POST",
      url: `/approvals/${nonce}/decide`,
      headers: authHeaders(),
      payload: { decision: "granted", decidedBy: "telegram:user:1" },
    });
    expect(res.statusCode).toBe(200);
    await app.close();

    const logOutput = Buffer.concat(chunks).toString("utf8");
    expect(logOutput.length).toBeGreaterThan(0);
    expect(logOutput).not.toContain(nonce);
    expect(logOutput).not.toContain(TEST_TOKEN);
  });
});

describe("N4 log redaction on the approvals edit route", () => {
  it("never emits the nonce anywhere in the real pino log output for that request", async () => {
    const nonce = randomUUID();
    const invalidated = fixtureApproval({ nonce, status: "invalidated" });
    const deps = createFakeDeps({
      editApproval: async () => ({
        edited: true,
        rowCount: 1,
        invalidated,
        replacement: fixtureWaitSignal(),
      }),
    });

    const chunks: Buffer[] = [];
    const logStream = new Writable({
      write(chunk: Buffer, _enc, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });

    const app = buildTestApp(deps, { logger: undefined, logStream });
    const res = await app.inject({
      method: "POST",
      url: `/approvals/${nonce}/edit`,
      headers: authHeaders(),
      payload: {
        runId: randomUUID(),
        capabilityId: "email.create_draft",
        toolName: "create_draft",
        input: { subject: "edited" },
        destination: "review@example.test",
      },
    });
    expect(res.statusCode).toBe(200);
    await app.close();

    const logOutput = Buffer.concat(chunks).toString("utf8");
    expect(logOutput.length).toBeGreaterThan(0);
    expect(logOutput).not.toContain(nonce);
    expect(logOutput).not.toContain(TEST_TOKEN);
  });
});

/**
 * TASK-259 — the `/threads/:id/stream` SSE route's poll/heartbeat loop must
 * re-validate the originating session (signature + expiry, and revocation)
 * for the entire lifetime of the connection, not just once at the initial
 * handshake (see app.ts's `sessionStillValid`). These tests need a real,
 * held-open connection with a real elapsing clock — `app.inject()` cannot
 * observe a server-initiated close of a genuinely still-open stream the way
 * a real socket can — so, like `src/sse.test.ts` (TASK-129, out of this
 * task's `Owned_Paths`), they use a real `app.listen()` + `fetch()` round
 * trip over 127.0.0.1 rather than `inject()`.
 */
describe("GET /threads/:id/stream — session re-validation (TASK-259)", () => {
  // The default 5000ms vitest budget is occasionally too tight for a real
  // listen()/fetch() round trip the first time the module graph is warm
  // (same observation as sse.test.ts).
  const STREAM_TEST_TIMEOUT_MS = 15000;
  const STREAM_TOKEN = "task-259-fixture-shared-secret";
  const streamTenantId = "tenant-task-259";
  const streamThreadId = "44444444-4444-4444-4444-444444444444";

  function streamRole(overrides: Partial<Role> = {}): Role {
    return {
      roleId: "bot",
      tenantId: streamTenantId,
      name: "Bot",
      title: "Bot",
      description: "TASK-259 fixture bot",
      instructions: null,
      provider: null,
      model: null,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  function streamThread(overrides: Partial<Thread> = {}): Thread {
    return { id: streamThreadId, roleId: "bot", title: null, createdAt: new Date(), updatedAt: new Date(), ...overrides };
  }

  /** Minimal but complete `ControlApiDeps` fake — every required port filled, only `listMessages`/`listAllThreadsWithMembers`/`listRoles` matter for this route. */
  function createStreamDeps(overrides: Partial<ControlApiDeps> = {}): ControlApiDeps {
    return {
      createTask: async () => {
        throw new Error("unused in this test");
      },
      createRoutine: async () => {
        throw new Error("unused in this test");
      },
      createRole: async () => {
        throw new Error("unused in this test");
      },
      listCapabilities: async () => [],
      upsertRoleGrant: async (input) => input,
      listRoleGrants: async () => [],
      revokeRoleGrant: async () => {},
      listRoles: async () => [streamRole()],
      updateRoleInstructions: async () => null,
      listRoleMessages: async () => [],
      listRoutines: async (): Promise<Routine[]> => [],
      getOrCreateThreadForRole: async () => streamThread(),
      listThreads: async () => [streamThread()],
      createGroupThread: async () => {
        throw new Error("unused in this test");
      },
      listAllThreadsWithMembers: async () => [streamThread()],
      insertMessage: async () => {
        throw new Error("unused in this test");
      },
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
      ...overrides,
    };
  }

  async function startStreamServer(deps: ControlApiDeps, sseIntervalMs: number) {
    const app = buildApp(deps, { authToken: STREAM_TOKEN, logger: false, sseIntervalMs });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected a bound TCP address");
    }
    return { app, baseUrl: `http://127.0.0.1:${address.port}` };
  }

  /** Drains an SSE body until the server itself ends the stream, or a bounded real-time budget elapses (whichever first). Returns whether the server actually closed it. */
  async function waitForServerClose(body: ReadableStream<Uint8Array>, maxWaitMs: number): Promise<boolean> {
    const reader = body.getReader();
    const deadline = Date.now() + maxWaitMs;
    try {
      while (Date.now() < deadline) {
        const remaining = deadline - Date.now();
        const result = await Promise.race([
          reader.read(),
          new Promise<{ done: true; value: undefined }>((resolve) =>
            setTimeout(() => resolve({ done: false as unknown as true, value: undefined }), Math.min(remaining, 250)),
          ),
        ]);
        if (result.done) return true;
      }
      return false;
    } finally {
      try {
        await reader.cancel();
      } catch {
        // already closed server-side; cancelling a finished reader is a no-op error we don't care about.
      }
    }
  }

  const openApps: Array<Awaited<ReturnType<typeof startStreamServer>>["app"]> = [];

  afterEach(async () => {
    for (const app of openApps.splice(0)) {
      await app.close();
    }
  });

  it(
    "force-closes an open stream once the originating session expires mid-connection, not merely rejecting a new one",
    async () => {
      const deps = createStreamDeps();
      // Fast poll interval so the re-validation check (piggybacked on the
      // poll tick) fires well within the test's real-time budget.
      const { app, baseUrl } = await startStreamServer(deps, 20);
      openApps.push(app);

      // Minted immediately before connecting (not earlier) so the
      // preHandler's own auth check at handshake time still passes: a
      // real, non-mocked TTL short enough (~600ms) that it expires while
      // the connection is held open, exactly like the acceptance
      // criterion asks for, rather than a mocked clock.
      const almostExpiredNow = Date.now() - SESSION_TTL_MS + 600;
      const sessionToken = createSessionToken(STREAM_TOKEN, streamTenantId, almostExpiredNow);

      const response = await fetch(`${baseUrl}/threads/${streamThreadId}/stream`, {
        headers: { cookie: `control_api_session=${sessionToken}` },
      });
      expect(response.status).toBe(200);
      expect(response.body).not.toBeNull();

      // The session expires ~600ms after minting; the server must
      // force-close the still-open connection on its own within a few
      // poll ticks after that, not merely refuse a fresh connection
      // attempt (that path is already covered by the existing 401 tests).
      const closed = await waitForServerClose(response.body!, 5000);
      expect(closed).toBe(true);
    },
    STREAM_TEST_TIMEOUT_MS,
  );

  it(
    "force-closes an open stream the moment its session is revoked via POST /auth/logout, without waiting for a new connection",
    async () => {
      const sessionToken = createSessionToken(STREAM_TOKEN, streamTenantId);
      const deps = createStreamDeps();
      const { app, baseUrl } = await startStreamServer(deps, 20);
      openApps.push(app);
      const cookie = `control_api_session=${sessionToken}`;

      const response = await fetch(`${baseUrl}/threads/${streamThreadId}/stream`, { headers: { cookie } });
      expect(response.status).toBe(200);
      expect(response.body).not.toBeNull();

      // Give the stream one round of poll ticks to settle before revoking,
      // so this exercises "already open, then revoked" rather than a race
      // at connection time.
      await new Promise((resolve) => setTimeout(resolve, 60));
      const logoutRes = await fetch(`${baseUrl}/auth/logout`, { method: "POST", headers: { cookie } });
      expect(logoutRes.status).toBe(204);

      const closed = await waitForServerClose(response.body!, 5000);
      expect(closed).toBe(true);
    },
    STREAM_TEST_TIMEOUT_MS,
  );

  it(
    "does NOT close a service-bearer-authenticated stream, which has no session expiry to re-check",
    async () => {
      const deps = createStreamDeps();
      const { app, baseUrl } = await startStreamServer(deps, 20);
      openApps.push(app);

      const controller = new AbortController();
      const response = await fetch(`${baseUrl}/threads/${streamThreadId}/stream`, {
        headers: { authorization: `Bearer ${STREAM_TOKEN}` },
        signal: controller.signal,
      });
      expect(response.status).toBe(200);
      expect(response.body).not.toBeNull();

      // Several poll ticks pass (20ms interval): a bearer-authenticated
      // connection must survive all of them since there is no session to
      // expire or revoke.
      const closedPrematurely = await waitForServerClose(response.body!, 300);
      expect(closedPrematurely).toBe(false);

      controller.abort();
      await response.body?.cancel().catch(() => {});
    },
    STREAM_TEST_TIMEOUT_MS,
  );
});

/**
 * TASK-286 — `liveAgent.routes.ts`'s two WS-upgrade routes (viewer + human
 * takeover) and `browserTakeover.routes.ts`'s one route must each
 * force-close an open connection once its originating session is no longer
 * valid, mirroring TASK-259's SSE fix. Unlike SSE, these routes are raw
 * `node:http` upgrade handlers with no Fastify `inject()` support and no
 * poll/heartbeat timer of their own to piggyback re-validation on — TASK-259
 * gave them a dedicated `startSessionRevalidation` timer instead (see
 * `liveAgent.routes.ts`/`browserTakeover.routes.ts`).
 *
 * These tests register the routes directly on a hand-rolled Fastify
 * instance (the same rig `liveAgent.routes.test.ts`/
 * `browserTakeover.routes.test.ts` already use for their own real-upgrade
 * tests) rather than going through `buildApp`: `sessionRevalidationIntervalMs`
 * is not threaded through `BuildAppOptions` (that would mean editing
 * `app.ts`'s call site, outside this task's `Owned_Paths` — see the fix's
 * own doc comment), so a fast, deterministic interval can only be injected
 * by calling `registerLiveAgentRoutes`/`registerBrowserTakeoverRoutes`
 * directly. Every socket here is real loopback TCP; a real WS handshake
 * genuinely completes and a real clock genuinely elapses past the fixture
 * session's real expiry.
 */
describe("liveAgent/browserTakeover WS routes — session re-validation (TASK-286)", () => {
  const WS_TOKEN = "task-286-fixture-shared-secret";
  const WEBSOCKET_GUID_FIXTURE = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
  const FAST_REVALIDATION_MS = 20;

  /** A minimal raw-TCP "upstream" (stands in for execd or Steel): completes the WS handshake and otherwise never sends anything unprompted. */
  function startFakeUpstream(): Promise<{ port: number; close(): void }> {
    return new Promise((resolve) => {
      let clientSocket: Socket | undefined;
      const server: Server = createServer((socket) => {
        let buffer = Buffer.alloc(0);
        socket.on("data", (chunk: Buffer) => {
          buffer = Buffer.concat([buffer, chunk]);
          const headerEnd = buffer.indexOf("\r\n\r\n");
          if (headerEnd === -1 || clientSocket !== undefined) return;
          const headerText = buffer.subarray(0, headerEnd).toString("latin1");
          const keyMatch = /Sec-WebSocket-Key:\s*(.+)/i.exec(headerText);
          const key = keyMatch?.[1]?.trim() ?? "";
          const acceptKey = createHash("sha1").update(key + WEBSOCKET_GUID_FIXTURE).digest("base64");
          socket.write(
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
              `Sec-WebSocket-Accept: ${acceptKey}\r\n\r\n`,
          );
          clientSocket = socket;
        });
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address !== null ? address.port : 0;
        resolve({
          port,
          close(): void {
            try {
              clientSocket?.destroy();
            } catch {
              // Already destroyed.
            }
            server.close();
          },
        });
      });
    });
  }

  /** A minimal hand-rolled test client: performs the WS handshake over real loopback TCP against the app's own HTTP server, mirroring `liveAgent.routes.test.ts`'s own `connectViewerClient`. */
  function connectWsClient(port: number, path: string, headers: Record<string, string>): Promise<{ socket: Socket; statusLine: string }> {
    return new Promise((resolve, reject) => {
      const socket = new Socket();
      let buffer = Buffer.alloc(0);
      let handshakeDone = false;
      socket.on("data", (chunk: Buffer) => {
        if (handshakeDone) return;
        buffer = Buffer.concat([buffer, chunk]);
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;
        const statusLine = buffer.subarray(0, buffer.indexOf("\r\n")).toString("latin1");
        handshakeDone = true;
        resolve({ socket, statusLine });
      });
      socket.on("error", reject);
      socket.connect(port, "127.0.0.1", () => {
        const fixtureKeyMaterial = `task-286-fixture-${Math.random().toString(16).slice(2)}`;
        const headerLines = Object.entries({
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Key": Buffer.from(fixtureKeyMaterial).toString("base64").slice(0, 24),
          ...headers,
        })
          .map(([k, v]) => `${k}: ${v}`)
          .join("\r\n");
        socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\n${headerLines}\r\n\r\n`);
      });
    });
  }

  /** Resolves true once `socket` actually closes, false if `maxWaitMs` elapses first. */
  function waitForSocketClose(socket: Socket, maxWaitMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (socket.destroyed) {
        resolve(true);
        return;
      }
      const timer = setTimeout(() => {
        socket.removeListener("close", onClose);
        resolve(false);
      }, maxWaitMs);
      function onClose(): void {
        clearTimeout(timer);
        resolve(true);
      }
      socket.once("close", onClose);
    });
  }

  let app: FastifyInstance | undefined;
  let fakeUpstream: Awaited<ReturnType<typeof startFakeUpstream>> | undefined;
  let acceptedSockets: Socket[] = [];

  function trackAcceptedSockets(target: FastifyInstance): void {
    target.server.on("connection", (socket: Socket) => acceptedSockets.push(socket));
  }

  afterEach(async () => {
    for (const socket of acceptedSockets) {
      try {
        socket.destroy();
      } catch {
        // Already destroyed.
      }
    }
    acceptedSockets = [];
    if (app !== undefined) await app.close();
    fakeUpstream?.close();
    app = undefined;
    fakeUpstream = undefined;
  });

  it("force-closes an open live-agent VIEWER connection once its session expires mid-connection", async () => {
    fakeUpstream = await startFakeUpstream();
    const sandbox: LiveAgentSandboxRef = { sandboxId: "sbx-286", state: "Running" };
    const liveAgent: LiveAgentPort = {
      getActiveSandbox: async () => sandbox,
      getPtyViewerEndpoint: async () => ({ url: `ws://127.0.0.1:${fakeUpstream!.port}/pty/sbx-286/ws?mode=viewer&since=0` }),
    };

    app = Fastify({ logger: false });
    trackAcceptedSockets(app);
    registerLiveAgentRoutes(app, { authToken: WS_TOKEN, liveAgent, sessionRevalidationIntervalMs: FAST_REVALIDATION_MS });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;

    // A real TTL short enough (~150ms) that it expires while the
    // connection is held open, minted immediately before connecting so
    // the initial handshake's own auth check still passes.
    const almostExpiredNow = Date.now() - SESSION_TTL_MS + 150;
    const sessionToken = createSessionToken(WS_TOKEN, "tenant-task-286", almostExpiredNow);

    const client = await connectWsClient(port, "/roles/bot-286/live-agent/pty", { cookie: `control_api_session=${sessionToken}` });
    expect(client.statusLine).toContain("101");

    const closed = await waitForSocketClose(client.socket, 3000);
    expect(closed).toBe(true);
  });

  it("force-closes an open live-agent TAKEOVER connection once its session expires mid-connection", async () => {
    fakeUpstream = await startFakeUpstream();
    const sandbox: LiveAgentSandboxRef = { sandboxId: "sbx-286t", state: "waiting_approval" };
    const liveAgent: LiveAgentPort = {
      getActiveSandbox: async () => sandbox,
      getPtyViewerEndpoint: async () => {
        throw new Error("unused in this test");
      },
      getPtyTakeoverEndpoint: async () => ({ url: `ws://127.0.0.1:${fakeUpstream!.port}/pty/sbx-286t/ws?mode=holder&takeover=1` }),
    };

    app = Fastify({ logger: false });
    trackAcceptedSockets(app);
    registerLiveAgentRoutes(app, { authToken: WS_TOKEN, liveAgent, sessionRevalidationIntervalMs: FAST_REVALIDATION_MS });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;

    const almostExpiredNow = Date.now() - SESSION_TTL_MS + 150;
    const sessionToken = createSessionToken(WS_TOKEN, "tenant-task-286", almostExpiredNow);

    const client = await connectWsClient(port, "/roles/bot-286/live-agent/takeover", { cookie: `control_api_session=${sessionToken}` });
    expect(client.statusLine).toContain("101");

    const closed = await waitForSocketClose(client.socket, 3000);
    expect(closed).toBe(true);
  });

  it("does NOT close a bearer-authenticated live-agent viewer connection, which has no session expiry to re-check", async () => {
    fakeUpstream = await startFakeUpstream();
    const sandbox: LiveAgentSandboxRef = { sandboxId: "sbx-286b", state: "Running" };
    const liveAgent: LiveAgentPort = {
      getActiveSandbox: async () => sandbox,
      getPtyViewerEndpoint: async () => ({ url: `ws://127.0.0.1:${fakeUpstream!.port}/pty/sbx-286b/ws?mode=viewer&since=0` }),
    };

    app = Fastify({ logger: false });
    trackAcceptedSockets(app);
    registerLiveAgentRoutes(app, { authToken: WS_TOKEN, liveAgent, sessionRevalidationIntervalMs: FAST_REVALIDATION_MS });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;

    const client = await connectWsClient(port, "/roles/bot-286/live-agent/pty", { authorization: `Bearer ${WS_TOKEN}` });
    expect(client.statusLine).toContain("101");

    // Several fast re-validation ticks pass; a bearer connection has no
    // session to expire or revoke, so it must survive all of them.
    const closedPrematurely = await waitForSocketClose(client.socket, 300);
    expect(closedPrematurely).toBe(false);
  });

  it("force-closes an open browser-takeover connection once its session expires mid-connection", async () => {
    fakeUpstream = await startFakeUpstream();
    const endpoint = { url: `ws://127.0.0.1:${fakeUpstream.port}/cdp` };
    const runId = "22222222-2222-2222-2222-222222222222";
    const browserTakeover: BrowserTakeoverPort = { getCdpEndpoint: async () => endpoint };
    const takeoverStatus: TakeoverStatusPort = { getStatus: async () => ({ pending: true }) };

    app = Fastify({ logger: false });
    trackAcceptedSockets(app);
    registerBrowserTakeoverRoutes(app, {
      authToken: WS_TOKEN,
      browserTakeover,
      takeoverStatus,
      sessionRevalidationIntervalMs: FAST_REVALIDATION_MS,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;

    const almostExpiredNow = Date.now() - SESSION_TTL_MS + 150;
    const sessionToken = createSessionToken(WS_TOKEN, "tenant-task-286", almostExpiredNow);

    const client = await connectWsClient(port, `/runs/${runId}/browser-takeover`, { cookie: `control_api_session=${sessionToken}` });
    expect(client.statusLine).toContain("101");

    const closed = await waitForSocketClose(client.socket, 3000);
    expect(closed).toBe(true);
  });
});
