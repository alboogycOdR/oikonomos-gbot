import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";
import type { Message, Role, Thread } from "@oikonomos/db";

import {
  buildApp,
  type FulfilSecretRequestResult,
  type DeclineSecretRequestResult,
  type PendingSecretRequest,
  type SecretRequestsPort,
} from "./app.js";
import { buildSessionCookie, createSessionToken } from "./auth.js";
import type { ControlApiDeps } from "./ports.js";

/**
 * TASK-187 (G-05b) — HTTP-level coverage for `GET /secret-requests`,
 * `POST /secret-requests/:id/fulfil`, and `POST /secret-requests/:id/decline`,
 * plus the `secretRequest` field `GET /threads/:id/messages` attaches.
 *
 * `SecretRequestsPort` (see `app.ts`'s `BuildAppOptions.secretRequests` doc
 * comment) is exercised with an in-memory fake, not a real `packages/db`
 * implementation: `packages/db/src/secretRequests.ts` has no list-pending or
 * decline query yet, and wiring a real port through `ports.ts`'s
 * `ControlApiDeps` would need a new method there — both outside this task's
 * `Owned_Paths`. This file proves the route contract — the value never
 * leaking out, 404-never-leaking-existence for a different tenant's
 * request, the 501 fallback, and the response shape — against that
 * contract, the same way `threadContext.routes.test.ts` does for TASK-179.
 */

const TOKEN = "task-187-fixture-token";
const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";

/** SERVICE_TENANT_ID ("basileia") bearer auth doesn't vary by tenant — a session cookie is required to test cross-tenant 404s. */
function sessionHeaders(tenantId: string): { cookie: string } {
  return { cookie: buildSessionCookie(createSessionToken(TOKEN, tenantId)) };
}

function authHeaders(): Record<string, string> {
  return sessionHeaders(TENANT_A);
}

function makeRole(overrides: Partial<Role> = {}): Role {
  return {
    roleId: "bot-a", tenantId: TENANT_A, name: "Bot A", title: "Bot A", description: "d", instructions: null, provider: null, model: null,
    status: "active", createdAt: new Date(), updatedAt: new Date(), ...overrides,
  };
}

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return { id: "thread-1", roleId: "bot-a", title: null, createdAt: new Date(), updatedAt: new Date(), ...overrides };
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return { id: randomUUID(), threadId: "thread-1", role: "bot", body: "hi", runId: null, createdAt: new Date(), ...overrides };
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
    listMessages: async () => [],
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

interface FakeRequest {
  requestId: string;
  tenantId: string;
  runId: string;
  roleId: string;
  label: string;
  purpose: string;
  createdAt: string;
  status: "pending" | "fulfilled" | "declined";
}

/**
 * In-memory `SecretRequestsPort` fake. `auditLog` stands in for the real
 * production audit-event write `fulfil`/`decline` would perform — recorded
 * here so tests can assert `value` never reaches it (AC1), and `resumeLog`
 * stands in for the real resume-with-refusal-message call `decline` would
 * make once that capability exists (see `app.ts`'s doc comment for why it
 * doesn't yet).
 */
function fakeSecretRequestsPort(seed: FakeRequest[] = []): SecretRequestsPort & {
  requests: Map<string, FakeRequest>;
  auditLog: Array<Record<string, unknown>>;
  resumeLog: string[];
} {
  const requests = new Map(seed.map((request) => [request.requestId, request]));
  const auditLog: Array<Record<string, unknown>> = [];
  const resumeLog: string[] = [];
  return {
    requests,
    auditLog,
    resumeLog,
    async listPending(tenantId): Promise<PendingSecretRequest[]> {
      return [...requests.values()]
        .filter((request) => request.tenantId === tenantId && request.status === "pending")
        .map(({ requestId, runId, roleId, label, purpose, createdAt }) => ({ requestId, runId, roleId, label, purpose, createdAt }));
    },
    async fulfil(requestId, tenantId, value): Promise<FulfilSecretRequestResult> {
      const existing = requests.get(requestId);
      if (existing === undefined || existing.tenantId !== tenantId || existing.status !== "pending") {
        return { found: false };
      }
      const ref = `vault-ref-${requestId}`;
      requests.set(requestId, { ...existing, status: "fulfilled" });
      // The audit row a real port would write never includes `value` — only
      // the ref. `value` is used above purely to compute a fake vault write
      // (never persisted here at all) and is otherwise discarded.
      auditLog.push({ eventType: "secret.fulfilled", requestId, ref });
      resumeLog.push(`${existing.runId}:resumed-after-fulfil`);
      void value;
      return { found: true, ref };
    },
    async decline(requestId, tenantId): Promise<DeclineSecretRequestResult> {
      const existing = requests.get(requestId);
      if (existing === undefined || existing.tenantId !== tenantId || existing.status !== "pending") {
        return { found: false };
      }
      requests.set(requestId, { ...existing, status: "declined" });
      auditLog.push({ eventType: "secret.declined", requestId });
      resumeLog.push(`${existing.runId}:resumed-with-refusal-message`);
      return { found: true };
    },
  };
}

function pendingFixture(overrides: Partial<FakeRequest> = {}): FakeRequest {
  return {
    requestId: "11111111-1111-1111-1111-111111111111",
    tenantId: TENANT_A,
    runId: "22222222-2222-2222-2222-222222222222",
    roleId: "bot-a",
    label: "Stripe API key",
    purpose: "to issue a refund",
    createdAt: new Date().toISOString(),
    status: "pending",
    ...overrides,
  };
}

describe("GET /secret-requests (TASK-187)", () => {
  it("lists only the caller tenant's pending requests", async () => {
    const port = fakeSecretRequestsPort([
      pendingFixture(),
      pendingFixture({ requestId: "other-tenant-req", tenantId: TENANT_B }),
      pendingFixture({ requestId: "already-fulfilled", status: "fulfilled" }),
    ]);
    const app = buildApp(createDeps(), { authToken: TOKEN, logger: false, secretRequests: port });
    try {
      const response = await app.inject({ method: "GET", url: "/secret-requests?status=pending", headers: authHeaders() });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as PendingSecretRequest[];
      expect(body).toHaveLength(1);
      expect(body[0]!.requestId).toBe("11111111-1111-1111-1111-111111111111");
    } finally {
      await app.close();
    }
  });

  it("rejects a status other than 'pending'", async () => {
    const app = buildApp(createDeps(), { authToken: TOKEN, logger: false, secretRequests: fakeSecretRequestsPort() });
    try {
      const response = await app.inject({ method: "GET", url: "/secret-requests?status=fulfilled", headers: authHeaders() });
      expect(response.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("responds 501 when no SecretRequestsPort is configured", async () => {
    const app = buildApp(createDeps(), { authToken: TOKEN, logger: false });
    try {
      const response = await app.inject({ method: "GET", url: "/secret-requests", headers: authHeaders() });
      expect(response.statusCode).toBe(501);
    } finally {
      await app.close();
    }
  });

  it("401s without a session", async () => {
    const app = buildApp(createDeps(), { authToken: TOKEN, logger: false, secretRequests: fakeSecretRequestsPort() });
    try {
      const response = await app.inject({ method: "GET", url: "/secret-requests" });
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

describe("POST /secret-requests/:id/fulfil (TASK-187)", () => {
  it("AC1: returns only the ref — never the value — and the value never reaches the request log or the audit row", async () => {
    const port = fakeSecretRequestsPort([pendingFixture()]);
    const SECRET_VALUE = "sk_live_definitely_not_logged_or_returned";
    const logStream = new PassThrough();
    let logged = "";
    logStream.on("data", (chunk: Buffer) => { logged += chunk.toString("utf8"); });
    const app = buildApp(createDeps(), { authToken: TOKEN, logger: true, logStream, secretRequests: port });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/secret-requests/11111111-1111-1111-1111-111111111111/fulfil",
        headers: authHeaders(),
        payload: { value: SECRET_VALUE },
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as { requestId: string; ref: string };
      expect(body).toEqual({ requestId: "11111111-1111-1111-1111-111111111111", ref: "vault-ref-11111111-1111-1111-1111-111111111111" });
      expect(response.body).not.toContain(SECRET_VALUE);
      // Fragment-assembled fake: the audit sink the real port would write
      // to, inspected directly — never contains the raw value.
      expect(JSON.stringify(port.auditLog)).not.toContain(SECRET_VALUE);
      expect(port.auditLog).toEqual([{ eventType: "secret.fulfilled", requestId: "11111111-1111-1111-1111-111111111111", ref: "vault-ref-11111111-1111-1111-1111-111111111111" }]);
    } finally {
      await app.close();
    }
    expect(logged).not.toContain(SECRET_VALUE);
  });

  it("404s for a request belonging to a different tenant and never calls the port's persistence", async () => {
    const port = fakeSecretRequestsPort([pendingFixture({ tenantId: TENANT_B })]);
    const app = buildApp(createDeps(), { authToken: TOKEN, logger: false, secretRequests: port });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/secret-requests/11111111-1111-1111-1111-111111111111/fulfil",
        headers: authHeaders(),
        payload: { value: "x" },
      });
      expect(response.statusCode).toBe(404);
      expect(port.auditLog).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("404s for an unknown id", async () => {
    const app = buildApp(createDeps(), { authToken: TOKEN, logger: false, secretRequests: fakeSecretRequestsPort() });
    try {
      const response = await app.inject({
        method: "POST",
        url: `/secret-requests/${randomUUID()}/fulfil`,
        headers: authHeaders(),
        payload: { value: "x" },
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("400s on a missing or blank value, without calling the port", async () => {
    const fulfil = vi.fn();
    const port = { ...fakeSecretRequestsPort([pendingFixture()]), fulfil };
    const app = buildApp(createDeps(), { authToken: TOKEN, logger: false, secretRequests: port });
    try {
      const blank = await app.inject({
        method: "POST",
        url: "/secret-requests/11111111-1111-1111-1111-111111111111/fulfil",
        headers: authHeaders(),
        payload: { value: "   " },
      });
      expect(blank.statusCode).toBe(400);
      const missing = await app.inject({
        method: "POST",
        url: "/secret-requests/11111111-1111-1111-1111-111111111111/fulfil",
        headers: authHeaders(),
        payload: {},
      });
      expect(missing.statusCode).toBe(400);
      expect(fulfil).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("responds 501 when no SecretRequestsPort is configured", async () => {
    const app = buildApp(createDeps(), { authToken: TOKEN, logger: false });
    try {
      const response = await app.inject({
        method: "POST",
        url: `/secret-requests/${randomUUID()}/fulfil`,
        headers: authHeaders(),
        payload: { value: "x" },
      });
      expect(response.statusCode).toBe(501);
    } finally {
      await app.close();
    }
  });
});

describe("POST /secret-requests/:id/decline (TASK-187)", () => {
  it("AC3: marks the request declined and the parked run's resume is invoked with a model-directed refusal message", async () => {
    const port = fakeSecretRequestsPort([pendingFixture()]);
    const app = buildApp(createDeps(), { authToken: TOKEN, logger: false, secretRequests: port });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/secret-requests/11111111-1111-1111-1111-111111111111/decline",
        headers: authHeaders(),
      });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ requestId: "11111111-1111-1111-1111-111111111111", declined: true });
      expect(port.requests.get("11111111-1111-1111-1111-111111111111")?.status).toBe("declined");
      expect(port.resumeLog).toEqual(["22222222-2222-2222-2222-222222222222:resumed-with-refusal-message"]);
    } finally {
      await app.close();
    }
  });

  it("declining twice: the second call 404s and the first decline is untouched", async () => {
    const port = fakeSecretRequestsPort([pendingFixture()]);
    const app = buildApp(createDeps(), { authToken: TOKEN, logger: false, secretRequests: port });
    try {
      const first = await app.inject({ method: "POST", url: "/secret-requests/11111111-1111-1111-1111-111111111111/decline", headers: authHeaders() });
      expect(first.statusCode).toBe(200);
      const second = await app.inject({ method: "POST", url: "/secret-requests/11111111-1111-1111-1111-111111111111/decline", headers: authHeaders() });
      expect(second.statusCode).toBe(404);
      expect(port.resumeLog).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("404s for a request belonging to a different tenant", async () => {
    const port = fakeSecretRequestsPort([pendingFixture({ tenantId: TENANT_B })]);
    const app = buildApp(createDeps(), { authToken: TOKEN, logger: false, secretRequests: port });
    try {
      const response = await app.inject({ method: "POST", url: "/secret-requests/11111111-1111-1111-1111-111111111111/decline", headers: authHeaders() });
      expect(response.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("responds 501 when no SecretRequestsPort is configured", async () => {
    const app = buildApp(createDeps(), { authToken: TOKEN, logger: false });
    try {
      const response = await app.inject({ method: "POST", url: `/secret-requests/${randomUUID()}/decline`, headers: authHeaders() });
      expect(response.statusCode).toBe(501);
    } finally {
      await app.close();
    }
  });
});

describe("GET /threads/:id/messages attaches secretRequest (TASK-187)", () => {
  it("AC2 delivery: a message tied to a run with a pending secret request carries a secretRequest field", async () => {
    const port = fakeSecretRequestsPort([pendingFixture({ runId: "run-with-pending-secret" })]);
    const message = makeMessage({ runId: "run-with-pending-secret" });
    const app = buildApp(
      createDeps({ listMessages: async () => [message] }),
      { authToken: TOKEN, logger: false, secretRequests: port },
    );
    try {
      const response = await app.inject({ method: "GET", url: "/threads/thread-1/messages", headers: authHeaders() });
      expect(response.statusCode).toBe(200);
      const [shaped] = JSON.parse(response.body) as Array<{ secretRequest?: { request_id: string; label: string; purpose: string; status: string } }>;
      expect(shaped?.secretRequest).toEqual({
        request_id: "11111111-1111-1111-1111-111111111111",
        label: "Stripe API key",
        purpose: "to issue a refund",
        status: "pending",
      });
    } finally {
      await app.close();
    }
  });

  it("omits secretRequest for a message whose run has none pending", async () => {
    const port = fakeSecretRequestsPort();
    const message = makeMessage({ runId: "some-other-run" });
    const app = buildApp(
      createDeps({ listMessages: async () => [message] }),
      { authToken: TOKEN, logger: false, secretRequests: port },
    );
    try {
      const response = await app.inject({ method: "GET", url: "/threads/thread-1/messages", headers: authHeaders() });
      const [shaped] = JSON.parse(response.body) as Array<{ secretRequest?: unknown }>;
      expect(shaped?.secretRequest).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
