import { describe, expect, it } from "vitest";

import { createSubagentL1 } from "../../../packages/harness-factory/src/index.js";
import {
  canaryCompose,
  defaultRun,
  handlePreToolUse,
  sendInput,
  TIER3_TOOL,
} from "./helpers.js";

describe("CAN-05 — subagent Tier-3 is denied and attributed", () => {
  it("denies a subagent Tier-3 attempt and audits isSubagent", async () => {
    const { built } = canaryCompose();
    const l1 = createSubagentL1({
      broker: {
        baseUrl: "http://canary-broker.example",
        fetch: async (_url, init) => {
          const request = JSON.parse(String(init?.body)) as Parameters<typeof handlePreToolUse>[0];
          const decision = await handlePreToolUse(request, built.deps);
          return new Response(JSON.stringify(decision), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      },
      run: {
        ...defaultRun(),
        provider: "claude",
        parentSessionRef: "sess-parent",
        sessionRef: "sess-subagent",
      },
    });

    const result = await l1.handle({
      toolName: TIER3_TOOL,
      toolUseId: "can-05-tool",
      input: sendInput(),
    });

    expect(result).toEqual({ decision: "deny", message: "approval_pending" });
    expect(built.audit.events).toHaveLength(1);
    expect(built.audit.events[0]?.payload).toMatchObject({
      toolUseId: "can-05-tool",
      isSubagent: true,
      sessionRef: "sess-subagent",
    });
  });
});
