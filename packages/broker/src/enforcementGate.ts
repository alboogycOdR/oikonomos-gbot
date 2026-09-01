import {
  resolveEnforcement,
  type EnforcedActionClass,
  type EnforcementResolution,
  type RequireApprovalRule,
  type TargetValue,
} from "@oikonomos/policy";

/**
 * L1's policy-only enforcement gate. Transport, capability lookup and the
 * broker's fail-closed map remain in index.ts; this module only turns an
 * already-valid action into the Addendum F §5.4 resolution.
 */
export interface EnforcementGateInput {
  readonly capabilityId: string;
  readonly target: Readonly<Record<string, TargetValue>>;
  readonly actionClasses: readonly EnforcedActionClass[];
  readonly requireApprovalRules: readonly RequireApprovalRule[];
  readonly refusalMemoryHit: boolean;
  readonly roleGrantCeilingExceeded: boolean;
}

export function resolveEnforcementGate(input: EnforcementGateInput): EnforcementResolution {
  return resolveEnforcement({
    brokerInput: "valid",
    capabilityKnown: true,
    actionDescribable: true,
    capabilityId: input.capabilityId,
    target: input.target,
    actionClasses: input.actionClasses,
    requireApprovalRules: input.requireApprovalRules,
    // An allow rule is intentionally incapable of relaxing ranks 2–5.
    alwaysAllow: false,
    refusalMemoryHit: input.refusalMemoryHit,
    roleGrantCeilingExceeded: input.roleGrantCeilingExceeded,
  });
}

export type { EnforcedActionClass, EnforcementResolution, RequireApprovalRule, TargetValue };
