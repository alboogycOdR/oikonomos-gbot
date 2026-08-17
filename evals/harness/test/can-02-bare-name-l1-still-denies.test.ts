import { describe, expect, it } from "vitest";

import { composeHarness } from "../../../packages/harness-factory/src/compose.js";

import { canaryCompose, invokeL1, permissionDecision, sendInput, TIER3_TOOL } from "./helpers.js";

describe("CAN-02 — bare-name allowedTools does not bypass L1", () => {
  it("adds the bare-name Tier-3 entry and L1 still denies", async () => {
    const { composed, built } = canaryCompose({ includeBareName: true });

    expect(composed.harness.config.allowedTools).toContain(TIER3_TOOL);
    expect(composed.harness.invocation.allowedTools).toContain(TIER3_TOOL);

    const result = await invokeL1(composed, TIER3_TOOL, "can-02-tool", sendInput());
    const mapped = permissionDecision(result);

    expect(mapped.decision).toBe("deny");
    expect(mapped.reason).toBe("approval_pending");
    expect(built.audit.events).toHaveLength(1);
    expect(built.audit.events[0]?.verdict).toBe("require_approval");
  });

  it("the L2 validator still rejects the same bare name without an ADR amendment", () => {
    const sink = {
      async writeCompletionEvidence() {},
    };
    try {
      composeHarness({
        run: {
          runId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
          roleId: "inbox-triage",
          tenantId: "basileia",
          agentRef: { provider: "claude", sessionRef: "sess", isSubagent: false },
        },
        allowedTools: [TIER3_TOOL],
        auditSink: sink,
        broker: { baseUrl: "http://broker.example", fetch: globalThis.fetch },
      });
      expect.unreachable("bare-name allowlist must be rejected");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/bare-name/i);
    }
  });
});
