import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";
import type { Approval } from "@oikonomos/db";
import { decideApproval, type ApprovalStore, type ConsumeApprovalResult } from "@oikonomos/approvals";

import { buildApp } from "../src/app.js";
import type { ControlApiDeps } from "../src/ports.js";

/**
 * TASK-056 acceptance criterion: "Approval decide route delegates to
 * packages/approvals verify+consume — MUTATION-PROVEN: a local
 * reimplementation of the nonce check turns a test RED (N8)."
 *
 * These tests wire `ControlApiDeps.decideApproval` to the REAL
 * `decideApproval` imported from `@oikonomos/approvals` (not a
 * hand-rolled fake of its guard logic), bound to an in-memory
 * `ApprovalStore`. If `src/app.ts`'s route handler ever stopped calling
 * `deps.decideApproval` and instead reimplemented the pending/expiry
 * guard itself, these tests would still exercise the real function
 * in isolation but the ROUTE behaviour would no longer be backed by it —
 * the mutation drill below (recorded in dossiers/TASK-056.md) confirms
 * that swapping this call for a local reimplementation turns the
 * double-decide and expiry assertions red.
 */

function fixtureApproval(nonce: string, overrides: Partial<Approval> = {}): Approval {
  return {
    approvalId: randomUUID(),
    tenantId: "basileia",
    runId: randomUUID(),
    capabilityId: "email.create_draft",
    actionDigest: Buffer.from("digest-bytes"),
    actionRender: "Create a Gmail draft",
    destination: "review@example.test",
    nonce,
    status: "pending",
    requestedAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    decidedBy: null,
    decidedAt: null,
    consumedAt: null,
    ...overrides,
  };
}

function createMemoryStore(rows: Map<string, Approval>): ApprovalStore {
  function transition(nonce: string, decidedBy: string, next: "granted" | "rejected"): ConsumeApprovalResult {
    const row = rows.get(nonce);
    if (row === undefined || row.status !== "pending" || row.expiresAt.getTime() <= Date.now()) {
      return { rowCount: 0, approval: null };
    }
    const decided: Approval = { ...row, status: next, decidedBy, decidedAt: new Date() };
    rows.set(nonce, decided);
    return { rowCount: 1, approval: decided };
  }

  return {
    insert() {
      throw new Error("not used by this fixture");
    },
    async getByNonce(nonce) {
      return rows.get(nonce) ?? null;
    },
    consume() {
      throw new Error("not used by this fixture");
    },
    invalidate() {
      throw new Error("not used by this fixture");
    },
    async expirePending() {
      return 0;
    },
    async grant(nonce, decidedBy) {
      return transition(nonce, decidedBy, "granted");
    },
    async reject(nonce, decidedBy) {
      return transition(nonce, decidedBy, "rejected");
    },
  };
}

function buildDeps(store: ApprovalStore): ControlApiDeps {
  return {
    createTask: () => {
      throw new Error("not used by this fixture");
    },
    listRuns: async () => ({ runs: [], nextCursor: null }),
    getRun: async () => null,
    listPendingApprovals: async () => [],
    getAuditEventsForRun: async () => [],
    decideApproval: (nonce, decision, decidedBy) => decideApproval(nonce, decision, decidedBy, { store }),
  };
}

describe("POST /approvals/:nonce/decide — real packages/approvals decideApproval, in-memory store", () => {
  it("approves a pending approval; a second decide on the same nonce affects zero rows (N8 double-decide)", async () => {
    const nonce = randomUUID();
    const rows = new Map([[nonce, fixtureApproval(nonce)]]);
    const app = buildApp(buildDeps(createMemoryStore(rows)), { logger: false });

    const first = await app.inject({
      method: "POST",
      url: `/approvals/${nonce}/decide`,
      payload: { decision: "granted", decidedBy: "telegram:user:1" },
    });
    expect(first.statusCode).toBe(200);
    expect(JSON.parse(first.body).decided).toBe(true);
    expect(rows.get(nonce)?.status).toBe("granted");

    const second = await app.inject({
      method: "POST",
      url: `/approvals/${nonce}/decide`,
      payload: { decision: "granted", decidedBy: "telegram:user:1" },
    });
    expect(second.statusCode).toBe(409);
    expect(JSON.parse(second.body).decided).toBe(false);

    await app.close();
  });

  it("a reject after a grant on the same nonce affects zero rows — exactly one decision wins", async () => {
    const nonce = randomUUID();
    const rows = new Map([[nonce, fixtureApproval(nonce)]]);
    const app = buildApp(buildDeps(createMemoryStore(rows)), { logger: false });

    const grant = await app.inject({
      method: "POST",
      url: `/approvals/${nonce}/decide`,
      payload: { decision: "granted", decidedBy: "telegram:user:1" },
    });
    expect(grant.statusCode).toBe(200);

    const reject = await app.inject({
      method: "POST",
      url: `/approvals/${nonce}/decide`,
      payload: { decision: "rejected", decidedBy: "telegram:user:2" },
    });
    expect(reject.statusCode).toBe(409);
    expect(rows.get(nonce)?.status).toBe("granted");

    await app.close();
  });

  it("refuses to grant an already-expired pending row", async () => {
    const nonce = randomUUID();
    const rows = new Map([[nonce, fixtureApproval(nonce, { expiresAt: new Date(Date.now() - 1000) })]]);
    const app = buildApp(buildDeps(createMemoryStore(rows)), { logger: false });

    const res = await app.inject({
      method: "POST",
      url: `/approvals/${nonce}/decide`,
      payload: { decision: "granted", decidedBy: "telegram:user:1" },
    });
    expect(res.statusCode).toBe(409);
    expect(rows.get(nonce)?.status).toBe("pending");

    await app.close();
  });

  it("returns 409 for a nonce with no matching approval", async () => {
    const app = buildApp(buildDeps(createMemoryStore(new Map())), { logger: false });
    const res = await app.inject({
      method: "POST",
      url: `/approvals/${randomUUID()}/decide`,
      payload: { decision: "granted", decidedBy: "telegram:user:1" },
    });
    expect(res.statusCode).toBe(409);
    await app.close();
  });
});
