import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";
import type { Run } from "@oikonomos/db";

import { buildApp, type CompleteTakeoverOutcome, type TakeoverPort, type TakeoverStatus } from "./app.js";
import { buildSessionCookie, createSessionToken } from "./auth.js";
import type { ControlApiDeps } from "./ports.js";

/**
 * TASK-188 (G-07) — HTTP-level coverage for `GET /runs/:id/takeover` and
 * `POST /runs/:id/takeover/complete`.
 *
 * `TakeoverPort` (see `app.ts`'s `BuildAppOptions.takeover` doc comment) is
 * exercised with an in-memory fake, not the real `services/worker/src/
 * takeover.ts` implementation: wiring that through `ports.ts`'s
 * `ControlApiDeps` is outside this task's `Owned_Paths`. This file proves
 * the route contract — tenant-ownership 404s (via `deps.getRun`, exactly
 * like `GET /runs/:id`), the 501 fallback, and the response shape — the
 * same way `secretRequests.routes.test.ts` does for TASK-187.
 */

const TOKEN = "task-188-fixture-token";
const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";
const RUN_ID = "22222222-2222-2222-2222-222222222222";

function sessionHeaders(tenantId: string): { cookie: string } {
  return { cookie: buildSessionCookie(createSessionToken(TOKEN, tenantId)) };
}
const authHeaders = (): Record<string, string> => sessionHeaders(TENANT_A);

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    runId: RUN_ID,
    taskId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    tenantId: TENANT_A,
    provider: "gemini",
    sessionRef: "session-1",
    status: "waiting_approval",
    startedAt: new Date(),
    endedAt: null,
    failureNote: null,
    ...overrides,
  };
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
    listRoles: async () => [],
    updateRoleInstructions: notImplemented("updateRoleInstructions"),
    listRoleMessages: async () => [],
    listRoutines: async () => [],
    getOrCreateThreadForRole: notImplemented("getOrCreateThreadForRole"),
    listThreads: async () => [],
    createGroupThread: notImplemented("createGroupThread") as ControlApiDeps["createGroupThread"],
    listAllThreadsWithMembers: async () => [],
    insertMessage: notImplemented("insertMessage") as ControlApiDeps["insertMessage"],
    listMessages: async () => [],
    listTasks: async () => ({ tasks: [], nextCursor: null }),
    getTask: async () => null,
    listRuns: async () => ({ runs: [], nextCursor: null }),
    getRun: async () => makeRun(),
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

/** In-memory `TakeoverPort` fake. `completeLog` records every `complete()` call, so tests can assert it was (or wasn't) invoked. */
function fakeTakeoverPort(
  status: TakeoverStatus | null = { pending: true, kind: "captcha", detail: "detected captcha page" },
  outcome: CompleteTakeoverOutcome = { completed: true },
): TakeoverPort & { completeLog: string[] } {
  const completeLog: string[] = [];
  return {
    completeLog,
    async getStatus(): Promise<TakeoverStatus | null> {
      return status;
    },
    async complete(runId): Promise<CompleteTakeoverOutcome> {
      completeLog.push(runId);
      return outcome;
    },
  };
}

describe("GET /runs/:id/takeover (TASK-188)", () => {
  it("returns the real pending state and kind/detail", async () => {
    const app = buildApp(createDeps(), { authToken: TOKEN, logger: false, takeover: fakeTakeoverPort() });
    try {
      const response = await app.inject({ method: "GET", url: `/runs/${RUN_ID}/takeover`, headers: authHeaders() });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ pending: true, kind: "captcha", detail: "detected captcha page" });
    } finally {
      await app.close();
    }
  });

  it("returns pending: false for a run not parked for a takeover", async () => {
    const app = buildApp(createDeps(), { authToken: TOKEN, logger: false, takeover: fakeTakeoverPort({ pending: false }) });
    try {
      const response = await app.inject({ method: "GET", url: `/runs/${RUN_ID}/takeover`, headers: authHeaders() });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ pending: false });
    } finally {
      await app.close();
    }
  });

  it("404s for a run belonging to a different tenant, and never calls the port", async () => {
    const getStatus = vi.fn();
    const port = { ...fakeTakeoverPort(), getStatus };
    const app = buildApp(
      createDeps({ getRun: async () => makeRun({ tenantId: TENANT_B }) }),
      { authToken: TOKEN, logger: false, takeover: port },
    );
    try {
      const response = await app.inject({ method: "GET", url: `/runs/${RUN_ID}/takeover`, headers: authHeaders() });
      expect(response.statusCode).toBe(404);
      expect(getStatus).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("404s for an unknown run id", async () => {
    const app = buildApp(createDeps({ getRun: async () => null }), { authToken: TOKEN, logger: false, takeover: fakeTakeoverPort() });
    try {
      const response = await app.inject({ method: "GET", url: `/runs/${randomUUID()}/takeover`, headers: authHeaders() });
      expect(response.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("responds 501 when no TakeoverPort is configured", async () => {
    const app = buildApp(createDeps(), { authToken: TOKEN, logger: false });
    try {
      const response = await app.inject({ method: "GET", url: `/runs/${RUN_ID}/takeover`, headers: authHeaders() });
      expect(response.statusCode).toBe(501);
    } finally {
      await app.close();
    }
  });

  it("401s without a session", async () => {
    const app = buildApp(createDeps(), { authToken: TOKEN, logger: false, takeover: fakeTakeoverPort() });
    try {
      const response = await app.inject({ method: "GET", url: `/runs/${RUN_ID}/takeover` });
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

describe("POST /runs/:id/takeover/complete (TASK-188)", () => {
  it("completes the hand-back and calls the port with the real run id", async () => {
    const port = fakeTakeoverPort();
    const app = buildApp(createDeps(), { authToken: TOKEN, logger: false, takeover: port });
    try {
      const response = await app.inject({ method: "POST", url: `/runs/${RUN_ID}/takeover/complete`, headers: authHeaders() });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ completed: true });
      expect(port.completeLog).toEqual([RUN_ID]);
    } finally {
      await app.close();
    }
  });

  it("409s with the real reason when the port refuses (not_pending)", async () => {
    const port = fakeTakeoverPort(undefined, { completed: false, reason: "not_pending" });
    const app = buildApp(createDeps(), { authToken: TOKEN, logger: false, takeover: port });
    try {
      const response = await app.inject({ method: "POST", url: `/runs/${RUN_ID}/takeover/complete`, headers: authHeaders() });
      expect(response.statusCode).toBe(409);
      expect(JSON.parse(response.body)).toEqual({ completed: false, reason: "not_pending" });
    } finally {
      await app.close();
    }
  });

  it("409s with the real reason when the port refuses (cannot_resume)", async () => {
    const port = fakeTakeoverPort(undefined, { completed: false, reason: "cannot_resume" });
    const app = buildApp(createDeps(), { authToken: TOKEN, logger: false, takeover: port });
    try {
      const response = await app.inject({ method: "POST", url: `/runs/${RUN_ID}/takeover/complete`, headers: authHeaders() });
      expect(response.statusCode).toBe(409);
      expect(JSON.parse(response.body)).toEqual({ completed: false, reason: "cannot_resume" });
    } finally {
      await app.close();
    }
  });

  it("404s for a run belonging to a different tenant, and never calls the port's complete()", async () => {
    const port = fakeTakeoverPort();
    const app = buildApp(
      createDeps({ getRun: async () => makeRun({ tenantId: TENANT_B }) }),
      { authToken: TOKEN, logger: false, takeover: port },
    );
    try {
      const response = await app.inject({ method: "POST", url: `/runs/${RUN_ID}/takeover/complete`, headers: authHeaders() });
      expect(response.statusCode).toBe(404);
      expect(port.completeLog).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("404s for an unknown run id", async () => {
    const app = buildApp(createDeps({ getRun: async () => null }), { authToken: TOKEN, logger: false, takeover: fakeTakeoverPort() });
    try {
      const response = await app.inject({ method: "POST", url: `/runs/${randomUUID()}/takeover/complete`, headers: authHeaders() });
      expect(response.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("responds 501 when no TakeoverPort is configured", async () => {
    const app = buildApp(createDeps(), { authToken: TOKEN, logger: false });
    try {
      const response = await app.inject({ method: "POST", url: `/runs/${RUN_ID}/takeover/complete`, headers: authHeaders() });
      expect(response.statusCode).toBe(501);
    } finally {
      await app.close();
    }
  });

  it("401s without a session", async () => {
    const app = buildApp(createDeps(), { authToken: TOKEN, logger: false, takeover: fakeTakeoverPort() });
    try {
      const response = await app.inject({ method: "POST", url: `/runs/${RUN_ID}/takeover/complete` });
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
