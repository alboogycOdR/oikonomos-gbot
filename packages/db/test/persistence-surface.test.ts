import { describe, expect, it } from "vitest";

import * as approvalsApi from "../src/approvals.js";
import { getApprovalByNonce, insertApproval, insertAuditEvent } from "../src/index.js";

const approvalRuntimeExports = [
  "CONSUME_APPROVAL_SQL",
  "approvalStatuses",
  "consumeApproval",
  "getApprovalByNonce",
  "insertApproval",
  "listPendingApprovals",
];

// ORCH 2026-08-20: an allowlist widened one name at a time decays silently, so
// the source-level assertion below keys on what the module actually DOES (its
// write statements) rather than on what its exports are called — it bites on a
// mutating helper no matter what name a future author gives it. TASK-061 adds
// listPendingApprovals to the pin above as part of its own merge, after ORCH
// verified it is a pure parameterised SELECT.

function assertApprovalExportSurface(api: object): void {
  expect(Object.keys(api).sort()).toEqual(approvalRuntimeExports);
}

describe("packages/db persistence surface", () => {
  it("pins the intended approvals export surface", () => {
    // This intentionally targets approvals.ts rather than the package barrel.
    // TASK-015 may independently add consumeApproval to index.ts; either barrel
    // state leaves this module's exact, N8-approved surface unchanged.
    assertApprovalExportSurface(approvalsApi);
  });

  it("N8 source guard: approvals.ts writes to approvals exactly once, via the atomic consume", async () => {
    // Stronger than the name pin above: this keys on the module's actual write
    // statements, so ANY future mutating helper trips it regardless of naming.
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(
      new URL("../src/approvals.ts", import.meta.url),
      "utf8",
    );
    const updates = src.match(/UPDATE\s+approvals/gi) ?? [];
    const deletes = src.match(/DELETE\s+FROM\s+approvals/gi) ?? [];

    // One UPDATE only: CONSUME_APPROVAL_SQL. Adding a second status transition
    // here would split N8's single atomic consume across two statements.
    expect(updates).toHaveLength(1);
    expect(deletes).toHaveLength(0);
    expect(src).toMatch(/CONSUME_APPROVAL_SQL/);
  });

  it("rejects a newly exported status-mutating approval helper", () => {
    expect(() =>
      assertApprovalExportSurface({
        ...Object.fromEntries(approvalRuntimeExports.map((key) => [key, null])),
        updateApprovalStatus: () => undefined,
      }),
    ).toThrow();
  });

  it("rejects an empty connection string before opening a pool", async () => {
    const options = { connectionString: "   " };
    const digest = Buffer.from("0123456789abcdef0123456789abcdef");

    await expect(
      insertAuditEvent(options, { actor: "broker", eventType: "policy.decision" }),
    ).rejects.toThrow(/connectionString/);

    await expect(
      insertApproval(options, {
        runId: "11111111-1111-1111-1111-111111111111",
        capabilityId: "email.create_draft",
        actionDigest: digest,
        actionRender: "draft to nobody",
        destination: "nobody@example.test",
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toThrow(/connectionString/);

    await expect(
      getApprovalByNonce(options, "11111111-1111-1111-1111-111111111111"),
    ).rejects.toThrow(/connectionString/);
  });
});
