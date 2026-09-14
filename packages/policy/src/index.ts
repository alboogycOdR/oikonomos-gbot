import { resolveEffectiveTier } from "./ceiling.js";

export { resolveEffectiveTier } from "./ceiling.js";
export { resolveEgressPolicy, type EgressManifest, type EgressPolicy, type EgressPolicyMode, type EgressRole, type EgressRoleGrant } from "./egress.js";
export {
  ApprovalResolution,
  resolveApprovalRequest,
  type ApprovalRequestDecision,
  type ApprovalRequestResolution,
  type ResolveApprovalRequestInput,
  type StandingApprovalMode,
} from "./approvalResolution.js";
export {
  resolveEnforcement,
  type EnforcedActionClass,
  type EnforcementClass,
  type EnforcementRank,
  type EnforcementResolution,
  type ResolveEnforcementInput,
} from "./enforcement.js";
export {
  matchesRequireApprovalRule,
  type RequireApprovalRule,
  type TargetValue,
} from "./requireApproval.js";

/** Ordered from least to most restrictive. */
export const riskTiers = [
  "T0_observe",
  "T1_draft",
  "T2_internal",
  "T3_external",
  "T4_irreversible",
] as const;

export type RiskTier = (typeof riskTiers)[number];

/** The policy data required to resolve an incoming tool name. */
export interface CapabilityTier {
  toolName: string;
  defaultTier: RiskTier;
}
export interface ResolveCapabilityTierInput {
  toolName: string;
  capabilities: readonly CapabilityTier[];
  roleGrantOverride?: RiskTier;
  /** Optional organisation policy that may only make the resolved tier stricter. */
  ceiling?: RiskTier;
}

export type CapabilityTierResolution =
  | { decision: "allow"; tier: RiskTier }
  | { decision: "deny"; reason: "capability.unregistered" };

/**
 * Shape of `role_grants.constraints` (Handover §4.4 / Synthesis §5.1).
 * Keys match the persisted JSON exactly — do not rename at this boundary.
 *
 * `domains` is deliberately NOT enforced here (TASK-227): it is already
 * enforced at the network layer by `resolveEgressPolicy`/
 * `toOpenSandboxNetworkPolicy`, reading this exact same `constraints.domains`
 * field and wired into production (`services/worker/src/chatRunDriver.ts`).
 * A second, app-level allow/deny check against the same field would be a
 * redundant, driftable duplicate of live enforcement (CLAUDE.md's
 * control-liveness rule / ADR-005) — the field is kept here only as
 * documentation of the persisted shape the egress layer reads.
 */
export interface RoleConstraints {
  rate_per_hour?: number;
  domains?: readonly string[];
}

/** Stable audit reasons — one per constraint, never collapsed. */
export type ConstraintDenialReason = "constraint.rate_per_hour";

export type ConstraintDecision =
  | { decision: "allow" }
  | { decision: "deny"; reason: ConstraintDenialReason };

export interface EvaluateRateLimitInput {
  /** From `role_grants.constraints.rate_per_hour`; omitted ⇒ no rate constraint. */
  ratePerHour: number | undefined;
  /**
   * Calls already counted in the current hour window.
   * Caller-supplied plain data — no clock or DB access here.
   */
  currentUsageCount: number;
}

/**
 * Resolves a registered tool's tier and fails closed for unknown tool names.
 * The denial reason is stable for inclusion in an audit event.
 */
export function resolveCapabilityTier(
  input: ResolveCapabilityTierInput,
): CapabilityTierResolution {
  const capability = input.capabilities.find(
    ({ toolName }) => toolName === input.toolName,
  );

  if (capability === undefined) {
    return { decision: "deny", reason: "capability.unregistered" };
  }

  return {
    decision: "allow",
    tier: resolveEffectiveTier(
      resolveEffectiveTier(capability.defaultTier, input.roleGrantOverride),
      input.ceiling,
    ),
  };
}

/**
 * Enforces `rate_per_hour` independently of domain constraints.
 * Denies when usage has already reached or exceeded the configured ceiling.
 */
export function evaluateRateLimitConstraint(
  input: EvaluateRateLimitInput,
): ConstraintDecision {
  if (input.ratePerHour === undefined) {
    return { decision: "allow" };
  }

  if (input.currentUsageCount >= input.ratePerHour) {
    return { decision: "deny", reason: "constraint.rate_per_hour" };
  }

  return { decision: "allow" };
}
