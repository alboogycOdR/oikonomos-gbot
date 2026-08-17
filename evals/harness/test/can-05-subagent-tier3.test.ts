import { describe, expect, it } from "vitest";

import {
  canaryCompose,
  defaultRun,
  invokeL1,
  permissionDecision,
  sendInput,
  TIER3_TOOL,
} from "./helpers.js";

describe("CAN-05 — subagent Tier-3 is denied and attributed", () => {
  it("denies a subagent Tier-3 attempt and audits isSubagent", async () => {
    const { composed, built } = canaryCompose({
      run: defaultRun({
        agentRef: { provider: "claude", sessionRef: "sess-subagent", isSubagent: true },
      }),
    });

    const result = await invokeL1(composed, TIER3_TOOL, "can-05-tool", sendInput());
    const mapped = permissionDecision(result);

    expect(mapped.decision).toBe("deny");
    expect(mapped.reason).toBe("approval_pending");
    expect(built.audit.events).toHaveLength(1);
    expect(built.audit.events[0]?.payload).toMatchObject({
      toolUseId: "can-05-tool",
      isSubagent: true,
      sessionRef: "sess-subagent",
    });
  });
});
