import {
  matchesRequireApprovalRule,
  type RequireApprovalRule,
  type TargetValue,
} from "./requireApproval.js";

/** The two execution classes introduced by Addendum F §5.1. */
export type EnforcementClass = "autonomous" | "enforced";

export type EnforcedActionClass =
  | "E1_payment"
  | "E2_auth_security_friction"
  | "E3_local_machine_execution"
  | "E4_secret_handling"
  | "E5_d3_path_access";

export type EnforcementRank = 1 | 2 | 3 | 4 | 5 | 6;

export type EnforcementResolution =
  | {
      readonly enforcementClass: EnforcementClass;
      readonly rank: 1 | 2 | 3 | 5 | 6;
      readonly reason:
        | "fail_closed"
        | "enforced_floor"
        | "require_approval_rule"
        | "role_grant_ceiling"
        | "default_autonomous";
    }
  | { readonly enforcementClass: "denied"; readonly rank: 4; readonly reason: "refusal_memory" };

export interface ResolveEnforcementInput {
  /** Whether the broker's existing fail-closed path accepted its own inputs. */
  readonly brokerInput: "valid" | "unreachable" | "timeout" | "malformed";
  /** False when no registered capability describes this action. */
  readonly capabilityKnown: boolean;
  /** False when the action cannot be deterministically described. */
  readonly actionDescribable: boolean;
  readonly capabilityId: string;
  readonly target: Readonly<Record<string, TargetValue>>;
  /** Caller-derived classification from the capability declaration/manifest. */
  readonly actionClasses: readonly EnforcedActionClass[];
  readonly requireApprovalRules: readonly RequireApprovalRule[];
  /**
   * Existing permissive policy input. It is deliberately not consulted:
   * Require Approval and the fixed floor always win over an allow rule.
   */
  readonly alwaysAllow: boolean;
  /** TASK-073's per-run, per-attempt result, passed through without mutation. */
  readonly refusalMemoryHit: boolean;
  /** Caller-derived result of comparing the resolved tier with the role ceiling. */
  readonly roleGrantCeilingExceeded: boolean;
}

/**
 * Resolves Addendum F §5.4's six-rank total order. Tiers are deliberately not
 * an input: tier remains a risk statement, not an approval switch (F12).
 * `alwaysAllow` is likewise intentionally absent from the rank checks.
 */
export function resolveEnforcement(input: ResolveEnforcementInput): EnforcementResolution {
  if (
    input.brokerInput !== "valid" ||
    !input.capabilityKnown ||
    !input.actionDescribable
  ) {
    return { enforcementClass: "enforced", rank: 1, reason: "fail_closed" };
  }

  if (input.actionClasses.length > 0) {
    return { enforcementClass: "enforced", rank: 2, reason: "enforced_floor" };
  }

  if (
    input.requireApprovalRules.some((rule) =>
      matchesRequireApprovalRule(rule, input.capabilityId, input.target),
    )
  ) {
    return { enforcementClass: "enforced", rank: 3, reason: "require_approval_rule" };
  }

  if (input.refusalMemoryHit) {
    return { enforcementClass: "denied", rank: 4, reason: "refusal_memory" };
  }

  if (input.roleGrantCeilingExceeded) {
    return { enforcementClass: "enforced", rank: 5, reason: "role_grant_ceiling" };
  }

  return { enforcementClass: "autonomous", rank: 6, reason: "default_autonomous" };
}
