import { describe, expect, it } from "vitest";

import {
  resolveEnforcement,
  type EnforcedActionClass,
  type ResolveEnforcementInput,
} from "./enforcement.js";

const input = (overrides: Partial<ResolveEnforcementInput> = {}): ResolveEnforcementInput => ({
  brokerInput: "valid",
  capabilityKnown: true,
  actionDescribable: true,
  capabilityId: "email.send",
  target: { destination: "operator@example.test" },
  actionClasses: [],
  requireApprovalRules: [],
  alwaysAllow: true,
  refusalMemoryHit: false,
  roleGrantCeilingExceeded: false,
  ...overrides,
});

describe("resolveEnforcement", () => {
  it("uses the first matching rank when higher and lower ranks both match", () => {
    expect(
      resolveEnforcement(
        input({
          brokerInput: "timeout",
          actionClasses: ["E1_payment"],
          requireApprovalRules: [
            { capabilityId: "email.send", enabled: true, targetPredicate: {} },
          ],
          refusalMemoryHit: true,
          roleGrantCeilingExceeded: true,
        }),
      ),
    ).toEqual({ enforcementClass: "enforced", rank: 1, reason: "fail_closed" });
  });

  it.each(["unreachable", "timeout", "malformed"] as const)(
    "fails closed at rank 1 when the broker is %s",
    (brokerInput) => {
      expect(resolveEnforcement(input({ brokerInput }))).toMatchObject({ rank: 1 });
    },
  );

  it.each([
    ["unknown capability", { capabilityKnown: false }],
    ["undescribable action", { actionDescribable: false }],
  ] as const)("fails closed at rank 1 for an %s", (_name, overrides) => {
    expect(resolveEnforcement(input(overrides))).toEqual({
      enforcementClass: "enforced",
      rank: 1,
      reason: "fail_closed",
    });
  });

  it.each([
    "E1_payment",
    "E2_auth_security_friction",
    "E3_local_machine_execution",
    "E4_secret_handling",
    "E5_d3_path_access",
  ] as const)("keeps %s enforced despite a maximally permissive rule set", (actionClass) => {
    expect(
      resolveEnforcement(
        input({
          actionClasses: [actionClass],
          requireApprovalRules: [
            { capabilityId: "email.send", enabled: true, targetPredicate: {} },
          ],
        }),
      ),
    ).toEqual({ enforcementClass: "enforced", rank: 2, reason: "enforced_floor" });
  });

  it("gives the enforced floor precedence over Require Approval (mutation guard)", () => {
    expect(
      resolveEnforcement(
        input({
          actionClasses: ["E1_payment"],
          requireApprovalRules: [{ capabilityId: "email.send", enabled: true, targetPredicate: {} }],
        }),
      ),
    ).toMatchObject({ rank: 2 });
  });

  it("makes Require Approval beat an Always Allow rule", () => {
    expect(
      resolveEnforcement(
        input({
          requireApprovalRules: [{ capabilityId: "email.send", enabled: true, targetPredicate: {} }],
        }),
      ),
    ).toEqual({ enforcementClass: "enforced", rank: 3, reason: "require_approval_rule" });
  });

  it("does not re-park an action already denied in this run", () => {
    expect(resolveEnforcement(input({ refusalMemoryHit: true }))).toEqual({
      enforcementClass: "denied",
      rank: 4,
      reason: "refusal_memory",
    });
  });

  it("enforces when the role grant ceiling is exceeded", () => {
    expect(resolveEnforcement(input({ roleGrantCeilingExceeded: true }))).toEqual({
      enforcementClass: "enforced",
      rank: 5,
      reason: "role_grant_ceiling",
    });
  });

  it.each([
    "email.send",
    "post.public",
    "workspace.overwrite",
    "connector.write",
    "routine.create",
    "teammate.message",
  ])("resolves %s autonomous by default", (capabilityId) => {
    expect(resolveEnforcement(input({ capabilityId }))).toEqual({
      enforcementClass: "autonomous",
      rank: 6,
      reason: "default_autonomous",
    });
  });
});
