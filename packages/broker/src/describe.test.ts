import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { riskTiers, type RiskTier } from "@oikonomos/policy";
import { describe, expect, it } from "vitest";

import { ALLOWLIST_MISS_REASON } from "./recheck.js";
import {
  APPROVAL_TIER,
  TARGET_MAX_CHARS,
  describeOrDeny,
  describeToolCall,
  formatDescribedAction,
  requiresHumanApproval,
  type Describer,
  type ToolCall,
} from "./describe.js";

const SEND = "mcp__gmail__send_message";
const LIST = "mcp__gmail__list_messages";
const UNKNOWN = "mcp__unknown__explode";

const sendCall: ToolCall = {
  toolName: SEND,
  input: { to: "review@example.test", subject: "Quarterly review" },
  destination: "review@example.test",
};

const sendDescriber: Describer = (call) => ({
  action: "send email",
  target: typeof call.input.to === "string" ? call.input.to : "",
});

const payloadDescriber: Describer = (call) => ({
  action: call.toolName,
  target: [call.destination ?? "", JSON.stringify(call.input)].join("\n"),
});

function registry(entries: Record<string, Describer> = { [SEND]: sendDescriber }) {
  return entries;
}

describe("requiresHumanApproval — L1 approval threshold", () => {
  it("treats T3_external and T4_irreversible as approval-requiring", () => {
    expect(APPROVAL_TIER).toBe("T3_external");
    expect(requiresHumanApproval("T0_observe")).toBe(false);
    expect(requiresHumanApproval("T1_draft")).toBe(false);
    expect(requiresHumanApproval("T2_internal")).toBe(false);
    expect(requiresHumanApproval("T3_external")).toBe(true);
    expect(requiresHumanApproval("T4_irreversible")).toBe(true);
  });

  it("treats an unknown tier as approval-requiring (fail closed)", () => {
    expect(requiresHumanApproval("T9_not_a_tier" as RiskTier)).toBe(true);
  });
});

describe("describeToolCall — whitelist describer (study §Tier 1.2)", () => {
  it("returns {action, target} from a registered describer", () => {
    expect(describeToolCall(sendCall, registry())).toEqual({
      action: "send email",
      target: "review@example.test",
    });
  });

  it("returns undefined when no describer is registered for the tool", () => {
    expect(describeToolCall(sendCall, {})).toBeUndefined();
    expect(describeToolCall({ ...sendCall, toolName: UNKNOWN }, registry())).toBeUndefined();
  });

  it("returns undefined when the describer returns undefined (unknown shape)", () => {
    const describers = {
      [SEND]: () => undefined,
    };
    expect(describeToolCall(sendCall, describers)).toBeUndefined();
  });

  it("returns undefined when the describer throws", () => {
    const describers = {
      [SEND]: () => {
        throw new Error("renderer crashed");
      },
    };
    expect(describeToolCall(sendCall, describers)).toBeUndefined();
  });

  it("returns undefined for empty toolName or a non-function registry entry", () => {
    expect(describeToolCall({ ...sendCall, toolName: "" }, registry())).toBeUndefined();
    const bogus = { [SEND]: "not-a-function" } as unknown as Record<string, Describer>;
    expect(describeToolCall(sendCall, bogus)).toBeUndefined();
  });

  it("accepts a Map registry", () => {
    const describers = new Map<string, Describer>([[SEND, sendDescriber]]);
    expect(describeToolCall(sendCall, describers)?.action).toBe("send email");
  });

  it("uses Object.hasOwn so prototype-inherited names are not describers", () => {
    const poisoned = Object.create({ [SEND]: sendDescriber }) as Record<string, Describer>;
    poisoned[LIST] = () => ({ action: "list", target: "inbox" });
    expect(describeToolCall(sendCall, poisoned)).toBeUndefined();
    expect(describeToolCall({ ...sendCall, toolName: LIST }, poisoned)).toEqual({
      action: "list",
      target: "inbox",
    });
  });

  it("still returns an oversized target so describeOrDeny can refuse it as unpresentable", () => {
    const huge = "x".repeat(TARGET_MAX_CHARS + 1);
    const describers = { [SEND]: () => ({ action: "send email", target: huge }) };
    expect(describeToolCall(sendCall, describers)).toEqual({
      action: "send email",
      target: huge,
    });
  });
});

describe("describeOrDeny — undescribable ⇒ denied (study §Tier 1.2; N3)", () => {
  const approvalRequiring = riskTiers.filter(requiresHumanApproval);

  it("denies a tool with no registered describer on every approval-requiring tier", () => {
    expect(approvalRequiring).toEqual(["T3_external", "T4_irreversible"]);
    for (const tier of approvalRequiring) {
      const decision = describeOrDeny(
        { ...sendCall, toolName: UNKNOWN },
        { describers: registry(), tier },
      );
      expect(decision).toEqual({
        decision: "deny",
        code: "describe.undescribable",
        humanReason: expect.any(String),
        modelGuidance: expect.any(String),
      });
      expect(decision.decision).not.toBe("allow");
      if (decision.decision === "deny") {
        expect(decision.modelGuidance.toLowerCase()).toContain("do not retry");
      }
    }
  });

  it("fail-closed default: undescribable also denies on tiers that do not ask a human", () => {
    for (const tier of riskTiers.filter((t) => !requiresHumanApproval(t))) {
      const decision = describeOrDeny(
        { ...sendCall, toolName: UNKNOWN },
        { describers: {}, tier },
      );
      expect(decision.decision).toBe("deny");
      if (decision.decision === "deny") {
        expect(decision.code).toBe("describe.undescribable");
      }
    }
  });

  it("denies when a registered describer returns undefined", () => {
    const decision = describeOrDeny(sendCall, {
      describers: { [SEND]: () => undefined },
      tier: "T3_external",
    });
    expect(decision.decision).toBe("deny");
    if (decision.decision === "deny") {
      expect(decision.code).toBe("describe.undescribable");
    }
  });

  it("allows a described call under the target size cap and records the tier", () => {
    const decision = describeOrDeny(sendCall, {
      describers: registry(),
      tier: "T3_external",
    });
    expect(decision).toEqual({
      decision: "allow",
      tier: "T3_external",
      description: { action: "send email", target: "review@example.test" },
    });
  });

  it("refuses a target longer than 10,000 chars as unpresentable", () => {
    const huge = "x".repeat(TARGET_MAX_CHARS + 1);
    expect(huge.length).toBe(10_001);
    const decision = describeOrDeny(sendCall, {
      describers: { [SEND]: () => ({ action: "send email", target: huge }) },
      tier: "T3_external",
    });
    expect(decision).toEqual({
      decision: "deny",
      code: "describe.unpresentable",
      humanReason: expect.any(String),
      modelGuidance: expect.any(String),
    });
    if (decision.decision === "deny") {
      expect(decision.modelGuidance.toLowerCase()).toContain("do not retry");
      expect(decision.modelGuidance.toLowerCase()).toMatch(/split|ask the operator/);
    }
  });

  it("allows a target of exactly 10,000 chars", () => {
    const cap = "y".repeat(TARGET_MAX_CHARS);
    const decision = describeOrDeny(sendCall, {
      describers: { [SEND]: () => ({ action: "send email", target: cap }) },
      tier: "T3_external",
    });
    expect(decision.decision).toBe("allow");
    if (decision.decision === "allow") {
      expect(decision.description.target.length).toBe(TARGET_MAX_CHARS);
    }
  });

  it("MUTATION-PROVEN: making undescribable fall through to allow turns this test RED", () => {
    const source = readFileSync(fileURLToPath(new URL("./describe.ts", import.meta.url)), "utf8");
    const fn = source.slice(source.indexOf("export function describeOrDeny"));
    const undefBranch = fn.match(/if \(description === undefined\) \{[\s\S]*?\n  \}/);
    expect(undefBranch?.[0]).toContain('return denyDecision("describe.undescribable")');
    expect(undefBranch?.[0]).not.toContain('"allow"');

    const decision = describeOrDeny(
      { toolName: UNKNOWN, input: {} },
      { describers: {}, tier: "T3_external" },
    );
    // If describeOrDeny returned allow for an unknown tool, this assertion goes red.
    expect(decision.decision).toBe("deny");
    expect(decision.decision).not.toBe("allow");
    if (decision.decision === "deny") {
      expect(decision.code).toBe("describe.undescribable");
    }
  });
});

describe("describeOrDeny — ADR-004 render provenance", () => {
  it("derives the stored render from the describe step; a payload change changes the render", () => {
    const describers = { [SEND]: payloadDescriber };
    const first = describeOrDeny(sendCall, { describers, tier: "T3_external" });
    const swappedInput = describeOrDeny(
      { ...sendCall, input: { ...sendCall.input, to: "eve@example.test" } },
      { describers, tier: "T3_external" },
    );
    const swappedDestination = describeOrDeny(
      { ...sendCall, destination: "eve@example.test" },
      { describers, tier: "T3_external" },
    );

    expect(first.decision).toBe("allow");
    expect(swappedInput.decision).toBe("allow");
    expect(swappedDestination.decision).toBe("allow");
    if (
      first.decision !== "allow"
      || swappedInput.decision !== "allow"
      || swappedDestination.decision !== "allow"
    ) {
      return;
    }

    const firstRender = formatDescribedAction(first.description);
    expect(firstRender).toBe(
      `action: ${first.description.action}\ntarget: ${first.description.target}`,
    );
    expect(formatDescribedAction(swappedInput.description)).not.toBe(firstRender);
    expect(formatDescribedAction(swappedDestination.description)).not.toBe(firstRender);
    expect(first.description.target).toContain("review@example.test");
    expect(swappedInput.description.target).toContain("eve@example.test");
  });
});

describe("describeOrDeny — allowlist.miss guidance is available to compose with TASK-066", () => {
  it("does not collide with the TASK-066 allowlist.miss reason token", () => {
    expect(ALLOWLIST_MISS_REASON).toBe("allowlist.miss");
    const undescribable = describeOrDeny(
      { toolName: UNKNOWN, input: {} },
      { describers: {}, tier: "T3_external" },
    );
    expect(undescribable.decision).toBe("deny");
    if (undescribable.decision === "deny") {
      expect(undescribable.code).not.toBe(ALLOWLIST_MISS_REASON);
    }
  });
});
