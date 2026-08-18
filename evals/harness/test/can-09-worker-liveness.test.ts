import { describe, expect, it } from "vitest";

import { executeTaskRun } from "../../../services/worker/src/executeRun.js";

import {
  createBrokerDeps,
  createCompletionLog,
  createParkLog,
  defaultRun,
  sendInput,
  TIER3_CAPABILITY_ID,
  TIER3_TOOL,
} from "./helpers.js";

/**
 * CAN-09 — production caller liveness (OIK-041 HIGH-2 / ADR-005 §2).
 *
 * The worker is the first services/** caller of composeHarness. This
 * canary drives a Tier-3 tool attempt through executeTaskRun and requires
 * the broker to have written a decision audit event. Importing compose
 * (or depending on the package) is not evidence.
 */
describe("CAN-09 — worker production caller emits a broker decision", () => {
  it("a worker-driven Tier-3 call is decided and audited", async () => {
    const built = createBrokerDeps();
    const completion = createCompletionLog();
    const park = createParkLog();

    await executeTaskRun({
      prompt: "send the quarterly review",
      run: defaultRun(),
      allowedTools: ["Bash(ls *)", "Read(src/**)"],
      brokerDependencies: built.deps,
      auditSink: completion.sink,
      park: park.port,
      queryFn: async function* (input) {
        const options = input.options ?? {};
        const hooks = options.hooks as
          | { PreToolUse?: Array<{ hooks: Array<(...args: never[]) => Promise<unknown>> }> }
          | undefined;
        const hook = hooks?.PreToolUse?.[0]?.hooks[0];
        if (hook === undefined) {
          yield { type: "result", skipped: "no-l1" };
          return;
        }
        await hook(
          {
            hook_event_name: "PreToolUse",
            tool_name: TIER3_TOOL,
            tool_use_id: "can-09-worker",
            tool_input: sendInput(),
          } as never,
          "can-09-worker" as never,
          { signal: new AbortController().signal } as never,
        );
        yield { type: "result", toolUseId: "can-09-worker" };
      },
    });

    expect(built.audit.events).toHaveLength(1);
    expect(built.audit.events[0]).toMatchObject({
      verdict: "require_approval",
      capability: TIER3_CAPABILITY_ID,
      tier: "T3_external",
      payload: expect.objectContaining({
        toolUseId: "can-09-worker",
        toolName: TIER3_TOOL,
        isSubagent: false,
      }),
    });
    expect(park.parks).toEqual([{ toolUseId: "can-09-worker", reason: "approval_pending" }]);
  });
});
