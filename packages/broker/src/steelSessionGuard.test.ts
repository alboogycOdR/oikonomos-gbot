import { describe, expect, it } from "vitest";

import {
  STEEL_SESSION_AUDIT_EVENT_TYPE,
  STEEL_SESSION_DENIAL_REASON,
  guardSteelSessionSafety,
  type SteelSessionGuardDecision,
} from "./steelSessionGuard.js";

const GUARDED_TOOL = "mcp__steel__steel_session_create";

interface PermissiveBrokerContext {
  readonly hasGrant: boolean;
  readonly hasAllowRule: boolean;
}

function invokeTool(
  toolName: string,
  input: Record<string, unknown>,
  context: PermissiveBrokerContext = { hasGrant: true, hasAllowRule: true },
  guard: (toolName: string, input: Record<string, unknown>) => SteelSessionGuardDecision = guardSteelSessionSafety,
): { readonly outcome: "executed" | "denied"; readonly audit?: object } {
  // Mirrors secretPathGuard.test.ts's own harness: the most permissive
  // ordinary broker outcome, so the guard must still stop the executor
  // after every other policy input already says allow.
  if (!context.hasGrant || !context.hasAllowRule) return { outcome: "denied" };
  const decision = guard(toolName, input);
  if (decision.decision === "deny") return { outcome: "denied", audit: decision.auditEvent };
  return { outcome: "executed" };
}

describe("guardSteelSessionSafety — non-negotiable #6", () => {
  it.each([
    ["solve_captcha: true", { solve_captcha: true }],
    ["use_proxy: true", { use_proxy: true }],
    ["a profile_id", { profile_id: "persisted-profile-1" }],
    ["a namespace", { namespace: "tenant-shared" }],
    // Unreachable today (mintable only by steel_session_options, which the
    // manifest doesn't declare) but the guard exists specifically not to
    // depend on that staying true — see steelSessionGuard.ts's own doc.
    ["a configuration plan token", { configuration: "signed-plan-token" }],
    ["several fields at once", { solve_captcha: true, use_proxy: true, profile_id: "p1" }],
  ] as const)("denies steel_session_create when the input sets %s", (_label, input) => {
    expect(invokeTool(GUARDED_TOOL, input)).toMatchObject({
      outcome: "denied",
      audit: { type: STEEL_SESSION_AUDIT_EVENT_TYPE, reason: STEEL_SESSION_DENIAL_REASON },
    });
  });

  it("allows steel_session_create with no circumvention fields at all", () => {
    expect(invokeTool(GUARDED_TOOL, {})).toEqual({ outcome: "executed" });
  });

  it("allows steel_session_create when every circumvention field is explicitly false", () => {
    expect(invokeTool(GUARDED_TOOL, { solve_captcha: false, use_proxy: false })).toEqual({ outcome: "executed" });
  });

  it("never guards a different tool name, even with the same input shape", () => {
    expect(invokeTool("mcp__steel__steel_navigate", { solve_captcha: true })).toEqual({ outcome: "executed" });
  });

  it("names which field(s) triggered the denial without echoing their values", () => {
    const result = invokeTool(GUARDED_TOOL, { solve_captcha: true, profile_id: "do-not-leak-this-id" });

    expect(result.audit).toEqual({
      type: STEEL_SESSION_AUDIT_EVENT_TYPE,
      verdict: "deny",
      reason: STEEL_SESSION_DENIAL_REASON,
      fields: ["solve_captcha", "profile_id"],
    });
    expect(JSON.stringify(result.audit)).not.toContain("do-not-leak-this-id");
  });

  // Not the ADR-005 liveness proof (renamed from "LIVENESS" per Fable 5.1's
  // re-review: this swaps in an injected no-op guard, so it can only show
  // the harness's own dispatch is well-formed — it cannot observe the real
  // wiring in decidePreToolUse. That proof is the mutation-verified pair in
  // packages/broker/src/index.test.ts (the real-path deny test plus its own
  // LIVENESS test), which mirrors secretPathGuard.test.ts's precedent.
  it("documents the harness's own guard-disabled shape (real wiring liveness lives in index.test.ts)", () => {
    const input = { solve_captcha: true };

    expect(invokeTool(GUARDED_TOOL, input)).toMatchObject({ outcome: "denied" });
    expect(invokeTool(GUARDED_TOOL, input, undefined, () => ({ decision: "allow" }))).toEqual({ outcome: "executed" });
  });
});
