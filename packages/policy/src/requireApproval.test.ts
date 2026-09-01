import { describe, expect, it } from "vitest";

import { matchesRequireApprovalRule, type RequireApprovalRule } from "./requireApproval.js";

const rule: RequireApprovalRule = {
  capabilityId: "email.send",
  enabled: true,
  targetPredicate: { destination: { domain: "example.test" }, labels: ["external"] },
};

describe("matchesRequireApprovalRule", () => {
  it("matches an enabled capability rule using a deterministic target predicate", () => {
    expect(
      matchesRequireApprovalRule(rule, "email.send", {
        destination: { domain: "example.test", address: "operator@example.test" },
        labels: ["external"],
        subject: "Status",
      }),
    ).toBe(true);
  });

  it("does not match disabled rules, another capability, or a nonmatching target", () => {
    expect(matchesRequireApprovalRule({ ...rule, enabled: false }, "email.send", {})).toBe(false);
    expect(matchesRequireApprovalRule(rule, "calendar.write", {})).toBe(false);
    expect(
      matchesRequireApprovalRule(rule, "email.send", {
        destination: { domain: "other.test" },
        labels: ["external"],
      }),
    ).toBe(false);
  });

  it("requires exact scalar and array values and rejects missing or non-object target values", () => {
    const scalarRule: RequireApprovalRule = {
      capabilityId: "email.send",
      enabled: true,
      targetPredicate: { priority: 2, archived: false },
    };
    const arrayRule: RequireApprovalRule = {
      capabilityId: "email.send",
      enabled: true,
      targetPredicate: { recipients: ["a@example.test", "b@example.test"] },
    };

    expect(matchesRequireApprovalRule(scalarRule, "email.send", { priority: 2, archived: false })).toBe(true);
    expect(matchesRequireApprovalRule(scalarRule, "email.send", { priority: 2 })).toBe(false);
    expect(matchesRequireApprovalRule(scalarRule, "email.send", { priority: 3, archived: false })).toBe(false);
    expect(matchesRequireApprovalRule(arrayRule, "email.send", { recipients: ["a@example.test"] })).toBe(false);
    expect(matchesRequireApprovalRule(arrayRule, "email.send", { recipients: "a@example.test" })).toBe(false);
    expect(matchesRequireApprovalRule(scalarRule, "email.send", null as never)).toBe(false);
  });
});
