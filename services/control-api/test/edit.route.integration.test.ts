import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";
import {
  Database,
  createTask,
  getApprovalByNonce,
  insertApproval,
  listPendingApprovals,
  seedInboxTriage,
  startRun,
  type DatabaseOptions,
} from "@oikonomos/db";
import { verifyAndConsume } from "@oikonomos/approvals";

import { buildApp } from "../src/app.js";
import { createDatabaseBackedDeps } from "../src/ports.js";

/**
 * TASK-063 / OIK-086 — "DB-gated integration legs actually RUN green
 * locally and are recorded in Test_Evidence; a skipping DB test is not
 * evidence" (TASK-035/044/061 precedent). This suite exercises
 * `POST /approvals/:nonce/edit` end to end against a real Postgres,
 * through `createDatabaseBackedDeps` — the real production binding to
 * `@oikonomos/approvals`' `editApproval`, never a local reimplementation.
 * It is skipped, visibly, when DATABASE_URL is unset.
 */
const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

integration("POST /approvals/:nonce/edit — real @oikonomos/approvals editApproval, real Postgres", () => {
  const options: DatabaseOptions = { connectionString: connectionString ?? "" };

  async function fixture(tenantId?: string) {
    const database = new Database(options);
    try {
      await seedInboxTriage(database);
    } finally {
      await database.close();
    }
    const task = await createTask(options, {
      tenantId,
      roleId: "inbox-triage",
      title: "TASK-063 edit fixture task",
      goal: "fixture",
      requestedBy: "test:task-063",
    });
    const run = await startRun(options, { taskId: task.taskId, provider: "claude", tenantId });
    const approval = await insertApproval(options, {
      tenantId,
      runId: run.runId,
      capabilityId: "email.create_draft",
      actionDigest: Buffer.from("original-digest"),
      actionRender: "Create a Gmail draft to original@example.test",
      destination: "original@example.test",
      expiresAt: new Date(Date.now() + 60_000),
    });
    return { run, approval };
  }

  it("invalidates the old approval and issues a replacement bound to the edited payload, with a NEW nonce and a digest+render describing the edited payload (ADR-004)", async () => {
    const { run, approval } = await fixture();
    const app = buildApp(createDatabaseBackedDeps(options), { logger: false });

    const res = await app.inject({
      method: "POST",
      url: `/approvals/${approval.nonce}/edit`,
      payload: {
        runId: run.runId,
        capabilityId: "email.create_draft",
        toolName: "create_draft",
        input: { to: "edited@example.test", subject: "edited" },
        destination: "edited@example.test",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      edited: boolean;
      invalidated: { status: string; nonce: string };
      replacement: {
        nonce: string;
        status: string;
        actionDigest: string;
        actionRender: string;
        destination: string;
      };
    };
    expect(body.edited).toBe(true);
    expect(body.invalidated.status).toBe("invalidated");
    expect(body.invalidated.nonce).toBe(approval.nonce);

    // NEW nonce (N8).
    expect(body.replacement.nonce).not.toBe(approval.nonce);
    expect(body.replacement.status).toBe("pending");
    expect(body.replacement.destination).toBe("edited@example.test");

    // ADR-004: render and digest both describe the EDITED payload, not the
    // original — proven by reading the persisted row back from a real
    // second query, not inferred from the response alone.
    const persisted = await getApprovalByNonce(options, body.replacement.nonce);
    expect(persisted).not.toBeNull();
    expect(persisted?.actionRender).toBe(body.replacement.actionRender);
    expect(persisted?.actionRender).toContain("edited@example.test");
    expect(persisted?.actionRender).not.toContain("original@example.test");
    expect(Buffer.from(persisted?.actionDigest ?? Buffer.alloc(0)).toString("hex")).toBe(
      body.replacement.actionDigest,
    );

    await app.close();
  });

  it("the old nonce is unusable after a successful edit — both decide and verifyAndConsume refuse it (OIK-023, N8)", async () => {
    const { run, approval } = await fixture();
    const app = buildApp(createDatabaseBackedDeps(options), { logger: false });

    const editRes = await app.inject({
      method: "POST",
      url: `/approvals/${approval.nonce}/edit`,
      payload: {
        runId: run.runId,
        capabilityId: "email.create_draft",
        toolName: "create_draft",
        input: { subject: "edited" },
        destination: "edited@example.test",
      },
    });
    expect(editRes.statusCode).toBe(200);

    const decideRes = await app.inject({
      method: "POST",
      url: `/approvals/${approval.nonce}/decide`,
      payload: { decision: "granted", decidedBy: "test:task-063" },
    });
    expect(decideRes.statusCode).toBe(409);

    const consumeResult = await verifyAndConsume(approval.nonce, { database: options });
    expect(consumeResult.consumed).toBe(false);

    await app.close();
  });

  it("never two live approvals for one action: after edit, exactly one pending row exists for that run+capability (N8)", async () => {
    const { run, approval } = await fixture();
    const app = buildApp(createDatabaseBackedDeps(options), { logger: false });

    const res = await app.inject({
      method: "POST",
      url: `/approvals/${approval.nonce}/edit`,
      payload: {
        runId: run.runId,
        capabilityId: "email.create_draft",
        toolName: "create_draft",
        input: { subject: "edited" },
        destination: "edited@example.test",
      },
    });
    expect(res.statusCode).toBe(200);

    const pending = await listPendingApprovals(options);
    const matches = pending.filter((a) => a.runId === run.runId && a.capabilityId === "email.create_draft");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.nonce).not.toBe(approval.nonce);

    await app.close();
  });

  it.each(["granted", "rejected", "consumed", "invalidated"] as const)(
    "refuses to edit a non-pending approval — status: %s",
    async (targetStatus) => {
      const { run, approval } = await fixture();
      // Reach the target status via the real, already-proven primitives
      // (decide / verifyAndConsume) — never a hand-rolled UPDATE — so this
      // fixture itself exercises real status transitions, not an assumed one.
      const decideApp = buildApp(createDatabaseBackedDeps(options), { logger: false });
      await decideApp.inject({
        method: "POST",
        url: `/approvals/${approval.nonce}/decide`,
        payload: { decision: targetStatus === "rejected" ? "rejected" : "granted", decidedBy: "test:task-063" },
      });
      await decideApp.close();
      if (targetStatus === "consumed") {
        const result = await verifyAndConsume(approval.nonce, { database: options });
        expect(result.consumed).toBe(true);
      } else if (targetStatus === "invalidated") {
        // OIK-023: a digest mismatch at consume-time invalidates a granted
        // row — the mismatch itself is `verifyAndConsume`'s job, reused here.
        const result = await verifyAndConsume(
          approval.nonce,
          { database: options },
          {
            toolName: "create_draft",
            input: { subject: "a different payload than what was approved" },
            destination: approval.destination,
          },
        );
        expect(result.consumed).toBe(false);
      }

      const confirmed = await getApprovalByNonce(options, approval.nonce);
      expect(confirmed?.status).toBe(targetStatus);

      const app = buildApp(createDatabaseBackedDeps(options), { logger: false });
      const res = await app.inject({
        method: "POST",
        url: `/approvals/${approval.nonce}/edit`,
        payload: {
          runId: run.runId,
          capabilityId: "email.create_draft",
          toolName: "create_draft",
          input: { subject: "should not apply" },
          destination: "should-not-apply@example.test",
        },
      });
      expect(res.statusCode).toBe(409);
      await app.close();
    },
  );

  it("refuses to edit a pending-but-already-expired approval (expires_at elapsed, sweeper not run)", async () => {
    const { run } = await fixture();
    const expiredApproval = await insertApproval(options, {
      runId: run.runId,
      capabilityId: "email.create_draft",
      actionDigest: Buffer.from("expired-digest"),
      actionRender: "Create a Gmail draft (already expired)",
      destination: "original@example.test",
      expiresAt: new Date(Date.now() - 1_000),
    });
    const app = buildApp(createDatabaseBackedDeps(options), { logger: false });

    const res = await app.inject({
      method: "POST",
      url: `/approvals/${expiredApproval.nonce}/edit`,
      payload: {
        runId: run.runId,
        capabilityId: "email.create_draft",
        toolName: "create_draft",
        input: { subject: "should not apply" },
        destination: "should-not-apply@example.test",
      },
    });
    expect(res.statusCode).toBe(409);

    const stillThere = await getApprovalByNonce(options, expiredApproval.nonce);
    expect(stillThere?.status).toBe("pending");

    await app.close();
  });

  it("a forced mid-operation failure (identity mismatch after invalidate) leaves the ORIGINAL approval untouched and issues no replacement — atomicity proven against a live DB (OIK-086)", async () => {
    const { approval } = await fixture();
    const app = buildApp(createDatabaseBackedDeps(options), { logger: false });

    // A runId that does not match the approval's actual run_id: invalidate
    // matches by nonce alone and succeeds, then editApproval's identity
    // check (packages/approvals, already covered by TASK-080's own suite)
    // throws mid-transaction and rolls back — this is a real, DB-observed
    // partial-failure boundary reachable through the public API, not an
    // internal test hook.
    const res = await app.inject({
      method: "POST",
      url: `/approvals/${approval.nonce}/edit`,
      payload: {
        runId: randomUUID(),
        capabilityId: "email.create_draft",
        toolName: "create_draft",
        input: { subject: "should roll back" },
        destination: "should-not-apply@example.test",
      },
    });
    expect(res.statusCode).toBe(400);

    const original = await getApprovalByNonce(options, approval.nonce);
    expect(original?.status).toBe("pending");
    expect(original?.destination).toBe("original@example.test");

    const pending = await listPendingApprovals(options);
    const matches = pending.filter((a) => a.runId === approval.runId && a.capabilityId === "email.create_draft");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.nonce).toBe(approval.nonce);

    await app.close();
  });

  it("HARD REFUSAL: an omitted tenantId defaults to 'basileia' and is rejected for a non-basileia tenant's approval (round-2 TASK-080 lesson)", async () => {
    const { run, approval } = await fixture("acme");
    const app = buildApp(createDatabaseBackedDeps(options), { logger: false });

    const res = await app.inject({
      method: "POST",
      url: `/approvals/${approval.nonce}/edit`,
      payload: {
        runId: run.runId,
        capabilityId: "email.create_draft",
        toolName: "create_draft",
        input: { subject: "should be refused" },
        destination: "should-not-apply@example.test",
        // tenantId deliberately omitted.
      },
    });
    expect(res.statusCode).toBe(400);

    const original = await getApprovalByNonce(options, approval.nonce);
    expect(original?.status).toBe("pending");

    await app.close();
  });

  it("succeeds for a non-basileia tenant when tenantId is forwarded correctly", async () => {
    const { run, approval } = await fixture("acme");
    const app = buildApp(createDatabaseBackedDeps(options), { logger: false });

    const res = await app.inject({
      method: "POST",
      url: `/approvals/${approval.nonce}/edit`,
      payload: {
        runId: run.runId,
        capabilityId: "email.create_draft",
        toolName: "create_draft",
        input: { subject: "edited for acme" },
        destination: "acme-edited@example.test",
        tenantId: "acme",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { replacement: { nonce: string } };
    const replacement = await getApprovalByNonce(options, body.replacement.nonce);
    expect(replacement?.tenantId).toBe("acme");

    await app.close();
  });
});
