import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";
import type { Approval, AuditEvent, Run, Task } from "@oikonomos/db";

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

describe("redactApprovalNonceFromUrl (unit)", () => {
  it("replaces the nonce path segment and leaves the rest of the url intact", async () => {
    const { redactApprovalNonceFromUrl } = await import("../src/redact.js");
    const nonce = randomUUID();
    expect(redactApprovalNonceFromUrl(`/approvals/${nonce}/decide`)).toBe("/approvals/[REDACTED]/decide");
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
