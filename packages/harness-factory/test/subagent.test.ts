import { describe, expect, it } from "vitest";

import {
  createSubagentL1,
  createSubagentRunIdentity,
  SubagentPolicyError,
  type CreateSubagentL1Options,
} from "../src/subagent.js";

const RUN = {
  runId: "22222222-2222-4222-8222-222222222222",
  roleId: "inbox-triage",
  tenantId: "basileia",
  provider: "claude",
  parentSessionRef: "parent-session",
  sessionRef: "subagent-session",
};

function options(fetch: typeof globalThis.fetch): CreateSubagentL1Options {
  return {
    broker: { fetch, baseUrl: "http://broker.example" },
    run: RUN,
  };
}

describe("OIK-040 subagent policy enforcement", () => {
  it("denies a subagent Tier-3 attempt and attributes its distinct session to the broker audit path", async () => {
    const audited: Array<{ agentRef: unknown; toolName: unknown }> = [];
    const l1 = createSubagentL1(
      options(async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { agentRef: unknown; toolName: unknown };
        audited.push({ agentRef: body.agentRef, toolName: body.toolName });
        return new Response(
          JSON.stringify({
            decision: "deny",
            reason: "approval_pending",
            auditEventId: "audit-subagent-tier3",
            approvalId: "approval-subagent-tier3",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    await expect(
      l1.handle({
        toolUseId: "subagent-tier3-1",
        toolName: "mcp__gmail__send_message",
        input: { to: "recipient@example.test", body: "must not send" },
      }),
    ).resolves.toEqual({ decision: "deny", message: "approval_pending" });

    expect(audited).toEqual([
      {
        toolName: "mcp__gmail__send_message",
        agentRef: {
          provider: "claude",
          sessionRef: "subagent-session",
          isSubagent: true,
        },
      },
    ]);
  });

  it("requires a non-parent session reference for audit attribution", () => {
    expect(() =>
      createSubagentRunIdentity({ ...RUN, sessionRef: RUN.parentSessionRef }),
    ).toThrow(/must differ/);
  });

  it("rejects prohibited inherited modes in untyped subagent options", () => {
    const unsafe = {
      ...options(async () => new Response("{}")),
      [["bypass", "Permissions"].join("")]: true,
    };
    expect(() => createSubagentL1(unsafe)).toThrow(SubagentPolicyError);
    let caught: unknown;
    try {
      createSubagentL1(unsafe);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "BANNED_MODE" });
  });

  it("always marks the constructed identity as a subagent", () => {
    expect(createSubagentRunIdentity(RUN).agentRef).toEqual({
      provider: "claude",
      sessionRef: "subagent-session",
      isSubagent: true,
    });
  });
});
