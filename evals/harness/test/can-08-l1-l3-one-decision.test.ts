import { describe, expect, it } from "vitest";

import {
  canaryCompose,
  invokeL1,
  invokeL3,
  permissionDecision,
  sendInput,
  TIER3_TOOL,
} from "./helpers.js";

describe("CAN-08 — one toolUseId through L1 and L3", () => {
  it("yields exactly one decision and one audit event", async () => {
    const { composed, built } = canaryCompose();
    const toolUseId = "can-08-shared";
    const input = sendInput();

    const l1 = permissionDecision(await invokeL1(composed, TIER3_TOOL, toolUseId, input));
    const l3 = await invokeL3(composed, TIER3_TOOL, toolUseId, input);

    expect(l1.decision).toBe("deny");
    expect(l1.reason).toBe("approval_pending");
    expect(l3).toEqual({ behavior: "deny", message: "approval_pending" });

    expect(built.audit.events).toHaveLength(1);
    expect(built.audit.events[0]).toMatchObject({
      verdict: "require_approval",
      payload: expect.objectContaining({ toolUseId }),
    });
    expect(built.approvals.rows.size).toBe(1);
  });
});
