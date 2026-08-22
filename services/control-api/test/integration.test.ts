import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";
import {
  Database,
  createTask,
  insertAuditEvent,
  insertApproval,
  seedInboxTriage,
  startRun,
  type DatabaseOptions,
} from "@oikonomos/db";

import { buildApp } from "../src/app.js";
import { createDatabaseBackedDeps } from "../src/ports.js";

/**
 * TASK-035/044 precedent: a skipping DB test is not evidence. This suite
 * runs for real whenever DATABASE_URL is set (as ORCH does at review) and
 * is skipped — visibly, via `describe.skip` — otherwise.
 */
const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

integration("control-api — HTTP routes against a real Postgres, real @oikonomos/db + @oikonomos/approvals", () => {
  const options: DatabaseOptions = { connectionString: connectionString ?? "" };

  it("creates a task, starts a run, lists it, reads it back, and reads its evidence — end to end over HTTP", async () => {
    const database = new Database(options);
    try {
      await seedInboxTriage(database);
    } finally {
      await database.close();
    }

    const app = buildApp(createDatabaseBackedDeps(options), { logger: false });

    const createRes = await app.inject({
      method: "POST",
      url: "/tasks",
      payload: {
        roleId: "inbox-triage",
        title: "TASK-056 integration task",
        goal: "prove control-api round-trips through @oikonomos/db",
        requestedBy: "test:task-056",
      },
    });
    expect(createRes.statusCode).toBe(201);
    const task = JSON.parse(createRes.body) as { taskId: string };
    expect(task.taskId).toBeTruthy();

    const run = await startRun(options, { taskId: task.taskId, provider: "claude" });

    const listRes = await app.inject({ method: "GET", url: `/runs?taskId=${task.taskId}` });
    expect(listRes.statusCode).toBe(200);
    const page = JSON.parse(listRes.body) as { runs: { runId: string }[] };
    expect(page.runs.some((r) => r.runId === run.runId)).toBe(true);

    const getRes = await app.inject({ method: "GET", url: `/runs/${run.runId}` });
    expect(getRes.statusCode).toBe(200);
    expect(JSON.parse(getRes.body).runId).toBe(run.runId);

    await insertAuditEvent(options, {
      runId: run.runId,
      actor: "test:task-056",
      eventType: "tool.result",
      payload: { note: "integration evidence row" },
    });

    const evidenceRes = await app.inject({ method: "GET", url: `/runs/${run.runId}/evidence` });
    expect(evidenceRes.statusCode).toBe(200);
    const events = JSON.parse(evidenceRes.body) as { runId: string }[];
    expect(events.some((e) => e.runId === run.runId)).toBe(true);

    await app.close();
  });

  it("lists a pending approval, grants it via HTTP, and a repeat decide is rejected — real DB, real N8 guard", async () => {
    const database = new Database(options);
    try {
      await seedInboxTriage(database);
    } finally {
      await database.close();
    }

    const fixtureTask = await createTask(options, {
      roleId: "inbox-triage",
      title: "approval fixture task",
      goal: "fixture",
      requestedBy: "test:task-056",
    });
    const run = await startRun(options, { taskId: fixtureTask.taskId, provider: "claude" });

    const approval = await insertApproval(options, {
      runId: run.runId,
      capabilityId: "email.create_draft",
      actionDigest: Buffer.from("integration-digest"),
      actionRender: "Create a Gmail draft",
      destination: "review@example.test",
      expiresAt: new Date(Date.now() + 60_000),
    });

    const app = buildApp(createDatabaseBackedDeps(options), { logger: false });

    const listRes = await app.inject({ method: "GET", url: "/approvals" });
    expect(listRes.statusCode).toBe(200);
    const pending = JSON.parse(listRes.body) as { nonce: string }[];
    expect(pending.some((a) => a.nonce === approval.nonce)).toBe(true);

    const decideRes = await app.inject({
      method: "POST",
      url: `/approvals/${approval.nonce}/decide`,
      payload: { decision: "granted", decidedBy: "test:task-056" },
    });
    expect(decideRes.statusCode).toBe(200);
    expect(JSON.parse(decideRes.body).decided).toBe(true);

    const repeatRes = await app.inject({
      method: "POST",
      url: `/approvals/${approval.nonce}/decide`,
      payload: { decision: "granted", decidedBy: "test:task-056" },
    });
    expect(repeatRes.statusCode).toBe(409);

    await app.close();
  });
});
