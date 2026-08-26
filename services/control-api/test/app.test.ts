import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";
import type { Approval, AuditEvent, Run, Task } from "@oikonomos/db";
import { DEFAULT_APPROVAL_TTL_MS, type ApprovalWaitSignal, type EditApprovalResult } from "@oikonomos/approvals";

import { buildApp } from "../src/app.js";
import type { ControlApiDeps } from "../src/ports.js";

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

describe("GET /openapi.json", () => {
  it("serves a document covering every registered route", async () => {
    const app = buildApp(createFakeDeps(), { logger: false });
    const res = await app.inject({ method: "GET", url: "/openapi.json" });
    expect(res.statusCode).toBe(200);
    const doc = JSON.parse(res.body) as { paths: Record<string, unknown> };
    for (const path of [
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
    const app = buildApp(deps, { logger: false });
    const res = await app.inject({
      method: "POST",
      url: "/tasks",
      payload: { roleId: "inbox-triage", title: "t", goal: "g", requestedBy: "telegram:user:1" },
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).title).toBe("t");
    expect(deps.calls.map((c) => c.name)).toEqual(["createTask"]);
    await app.close();
  });

  it("rejects a body missing required fields with 400, before reaching the port", async () => {
    const deps = createFakeDeps();
    const app = buildApp(deps, { logger: false });
    const res = await app.inject({ method: "POST", url: "/tasks", payload: { title: "only a title" } });
    expect(res.statusCode).toBe(400);
    expect(deps.calls).toHaveLength(0);
    await app.close();
  });
});

describe("GET /runs", () => {
  it("lists runs and passes query filters through to the port", async () => {
    const deps = createFakeDeps();
    const app = buildApp(deps, { logger: false });
    const res = await app.inject({ method: "GET", url: "/runs?status=started&limit=5" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { runs: unknown[]; nextCursor: string | null };
    expect(body.runs).toHaveLength(1);
    expect(deps.calls[0]).toEqual({ name: "listRuns", args: [{ status: "started", limit: 5 }] });
    await app.close();
  });

  it("rejects an unknown status value with 400 before reaching the port", async () => {
    const deps = createFakeDeps();
    const app = buildApp(deps, { logger: false });
    const res = await app.inject({ method: "GET", url: "/runs?status=not-a-status" });
    expect(res.statusCode).toBe(400);
    expect(deps.calls).toHaveLength(0);
    await app.close();
  });
});

describe("GET /runs/:id", () => {
  it("returns 200 with the run when found", async () => {
    const run = fixtureRun();
    const deps = createFakeDeps({ getRun: async () => run });
    const app = buildApp(deps, { logger: false });
    const res = await app.inject({ method: "GET", url: `/runs/${run.runId}` });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).runId).toBe(run.runId);
    await app.close();
  });

  it("returns 404 when the port reports no such run", async () => {
    const deps = createFakeDeps({ getRun: async () => null });
    const app = buildApp(deps, { logger: false });
    const res = await app.inject({ method: "GET", url: `/runs/${randomUUID()}` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("GET /runs/:id/evidence", () => {
  it("returns the run's audit events", async () => {
    const events = [fixtureAuditEvent(), fixtureAuditEvent({ eventId: "2" })];
    const deps = createFakeDeps({ getAuditEventsForRun: async () => events });
    const app = buildApp(deps, { logger: false });
    const res = await app.inject({ method: "GET", url: `/runs/${randomUUID()}/evidence` });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toHaveLength(2);
    await app.close();
  });
});

describe("GET /approvals", () => {
  it("lists pending approvals with actionDigest serialized as base64", async () => {
    const approval = fixtureApproval();
    const deps = createFakeDeps({ listPendingApprovals: async () => [approval] });
    const app = buildApp(deps, { logger: false });
    const res = await app.inject({ method: "GET", url: "/approvals" });
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
    const app = buildApp(deps, { logger: false });
    const res = await app.inject({
      method: "POST",
      url: `/approvals/${approval.nonce}/decide`,
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
    const app = buildApp(deps, { logger: false });
    const res = await app.inject({
      method: "POST",
      url: `/approvals/${randomUUID()}/decide`,
      payload: { decision: "rejected", decidedBy: "telegram:user:1" },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).decided).toBe(false);
    await app.close();
  });

  it("rejects a body with an invalid decision value before reaching the port", async () => {
    const deps = createFakeDeps();
    const app = buildApp(deps, { logger: false });
    const res = await app.inject({
      method: "POST",
      url: `/approvals/${randomUUID()}/decide`,
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
    const app = buildApp(deps, { logger: false });
    const res = await app.inject({
      method: "POST",
      url: `/approvals/${invalidated.nonce}/edit`,
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
    const app = buildApp(deps, { logger: false });
    const res = await app.inject({
      method: "POST",
      url: `/approvals/${randomUUID()}/edit`,
      payload: editBody(),
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).edited).toBe(false);
    await app.close();
  });

  it("rejects a body missing required fields with 400, before reaching the port", async () => {
    const deps = createFakeDeps();
    const app = buildApp(deps, { logger: false });
    const res = await app.inject({
      method: "POST",
      url: `/approvals/${randomUUID()}/edit`,
      payload: { runId: randomUUID() },
    });
    expect(res.statusCode).toBe(400);
    expect(deps.calls).toHaveLength(0);
    await app.close();
  });

  it("strips a caller-supplied 'render' field before it ever reaches the port — ADR-004 render is always derived, never accepted", async () => {
    const deps = createFakeDeps({ editApproval: async () => ({ edited: false, rowCount: 0 }) });
    const app = buildApp(deps, { logger: false });
    await app.inject({
      method: "POST",
      url: `/approvals/${randomUUID()}/edit`,
      payload: editBody({ render: "a caller-authored render" }),
    });
    expect(deps.calls).toHaveLength(1);
    const forwarded = deps.calls[0]?.args[1] as Record<string, unknown>;
    expect(forwarded).not.toHaveProperty("render");
    await app.close();
  });

  it("forwards tenantId through to the port on every call, even for a non-basileia tenant (round-2 TASK-080 lesson)", async () => {
    const deps = createFakeDeps({ editApproval: async () => ({ edited: false, rowCount: 0 }) });
    const app = buildApp(deps, { logger: false });
    const nonce = randomUUID();
    await app.inject({
      method: "POST",
      url: `/approvals/${nonce}/edit`,
      payload: editBody({ tenantId: "acme" }),
    });
    expect(deps.calls[0]?.name).toBe("editApproval");
    const forwarded = deps.calls[0]?.args[1] as { tenantId?: string };
    expect(forwarded.tenantId).toBe("acme");
    await app.close();
  });

  it("forwards tenantId as undefined (not silently coerced) when the caller omits it — editApproval owns the default", async () => {
    const deps = createFakeDeps({ editApproval: async () => ({ edited: false, rowCount: 0 }) });
    const app = buildApp(deps, { logger: false });
    await app.inject({
      method: "POST",
      url: `/approvals/${randomUUID()}/edit`,
      payload: editBody(),
    });
    const forwarded = deps.calls[0]?.args[1] as { tenantId?: string };
    expect(forwarded.tenantId).toBeUndefined();
    await app.close();
  });

  it("forwards an expiresAt string as a Date to the port", async () => {
    const deps = createFakeDeps({ editApproval: async () => ({ edited: false, rowCount: 0 }) });
    const app = buildApp(deps, { logger: false });
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    await app.inject({
      method: "POST",
      url: `/approvals/${randomUUID()}/edit`,
      payload: editBody({ expiresAt }),
    });
    const forwarded = deps.calls[0]?.args[1] as { expiresAt?: Date };
    expect(forwarded.expiresAt).toBeInstanceOf(Date);
    expect(forwarded.expiresAt?.toISOString()).toBe(expiresAt);
    await app.close();
  });

  it("rejects a past expiresAt with 400 before reaching the port — original approval left untouched", async () => {
    const deps = createFakeDeps({ editApproval: async () => ({ edited: true, rowCount: 1, invalidated: fixtureApproval(), replacement: fixtureWaitSignal() }) });
    const app = buildApp(deps, { logger: false });
    const pastExpiresAt = new Date(Date.now() - 1_000).toISOString();
    const res = await app.inject({
      method: "POST",
      url: `/approvals/${randomUUID()}/edit`,
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
    const deps = createFakeDeps({ editApproval: async () => ({ edited: true, rowCount: 1, invalidated: fixtureApproval(), replacement: fixtureWaitSignal() }) });
    const app = buildApp(deps, { logger: false });
    const excessiveExpiresAt = new Date(Date.now() + DEFAULT_APPROVAL_TTL_MS + 24 * 60 * 60 * 1000).toISOString();
    const res = await app.inject({
      method: "POST",
      url: `/approvals/${randomUUID()}/edit`,
      payload: editBody({ expiresAt: excessiveExpiresAt }),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/exceed the platform approval TTL/);
    expect(deps.calls).toHaveLength(0);
    await app.close();
  });

  it("accepts an omitted expiresAt — inherits editApproval's own default, no bound check applied", async () => {
    const deps = createFakeDeps({ editApproval: async () => ({ edited: true, rowCount: 1, invalidated: fixtureApproval(), replacement: fixtureWaitSignal() }) });
    const app = buildApp(deps, { logger: false });
    const res = await app.inject({
      method: "POST",
      url: `/approvals/${randomUUID()}/edit`,
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
    const app = buildApp(deps, { logger: false });
    const res = await app.inject({
      method: "POST",
      url: `/approvals/${randomUUID()}/edit`,
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

    const app = buildApp(deps, { logStream });
    const res = await app.inject({
      method: "POST",
      url: `/approvals/${nonce}/decide`,
      payload: { decision: "granted", decidedBy: "telegram:user:1" },
    });
    expect(res.statusCode).toBe(200);
    await app.close();

    const logOutput = Buffer.concat(chunks).toString("utf8");
    expect(logOutput.length).toBeGreaterThan(0);
    expect(logOutput).not.toContain(nonce);
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

    const app = buildApp(deps, { logStream });
    const res = await app.inject({
      method: "POST",
      url: `/approvals/${nonce}/edit`,
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
  });
});
