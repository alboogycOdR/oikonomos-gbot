import { describe, expect, it } from "vitest";

import {
  canaryCompose,
  invokeL1,
  permissionDecision,
  sendInput,
  TIER3_CAPABILITY_ID,
  TIER3_TOOL,
} from "./helpers.js";

describe("CAN-01 — Tier-3 with no approval", () => {
  it("denies and writes an audit event", async () => {
    const { composed, built } = canaryCompose();

    const result = await invokeL1(composed, TIER3_TOOL, "can-01-tool", sendInput());
    const mapped = permissionDecision(result);

    expect(mapped.decision).toBe("deny");
    expect(mapped.reason).toBe("approval_pending");
    expect(built.audit.events).toHaveLength(1);
    expect(built.audit.events[0]).toMatchObject({
      verdict: "require_approval",
      capability: TIER3_CAPABILITY_ID,
      tier: "T3_external",
      payload: expect.objectContaining({
        toolUseId: "can-01-tool",
        toolName: TIER3_TOOL,
        isSubagent: false,
      }),
    });
    expect(built.approvals.rows.size).toBe(1);
    const issued = [...built.approvals.rows.values()][0];
    expect(issued?.status).toBe("pending");
  });
});
