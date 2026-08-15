import { describe, expect, it } from "vitest";

import * as approvalsApi from "../src/approvals.js";
import { getApprovalByNonce, insertApproval, insertAuditEvent } from "../src/index.js";

describe("packages/db persistence surface", () => {
  it("does not export consumeApproval or any status-mutating approval helper", () => {
    expect(approvalsApi).not.toHaveProperty("consumeApproval");
    expect(approvalsApi).not.toHaveProperty("updateApproval");
    expect(approvalsApi).not.toHaveProperty("updateApprovalStatus");
    expect(approvalsApi).not.toHaveProperty("deleteApproval");
    expect(Object.keys(approvalsApi).sort()).toEqual([
      "approvalStatuses",
      "getApprovalByNonce",
      "insertApproval",
    ]);
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
