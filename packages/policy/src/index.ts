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
}

export type CapabilityTierResolution =
  | { decision: "allow"; tier: RiskTier }
  | { decision: "deny"; reason: "capability.unregistered" };

/**
 * Shape of `role_grants.constraints` (Handover §4.4 / Synthesis §5.1).
 * Keys match the persisted JSON exactly — do not rename at this boundary.
 */
export interface RoleConstraints {
  rate_per_hour?: number;
  domains?: readonly string[];
}

/** Stable audit reasons — one per constraint, never collapsed. */
export type ConstraintDenialReason =
  | "constraint.rate_per_hour"
  | "constraint.domains";

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

export interface EvaluateDomainConstraintInput {
  /** From `role_grants.constraints.domains`; omitted ⇒ no domain constraint. */
  allowedDomains: readonly string[] | undefined;
  /** Target domain extracted by the caller from tool input. */
  targetDomain: string;
}

/**
 * Returns the more restrictive of the capability default and role override.
 * Callers supply all data, keeping policy resolution free of I/O.
 */
export function resolveEffectiveTier(
  defaultTier: RiskTier,
  roleGrantOverride: RiskTier | undefined,
): RiskTier {
  if (roleGrantOverride === undefined) {
    return defaultTier;
  }

  return tierRank(roleGrantOverride) > tierRank(defaultTier)
    ? roleGrantOverride
    : defaultTier;
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
    tier: resolveEffectiveTier(capability.defaultTier, input.roleGrantOverride),
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

/**
 * Enforces `domains` independently of rate limits.
 * `"*"` allows any target; otherwise exact membership is required.
 * An empty allowlist denies (fail closed).
 */
export function evaluateDomainConstraint(
  input: EvaluateDomainConstraintInput,
): ConstraintDecision {
  if (input.allowedDomains === undefined) {
    return { decision: "allow" };
  }

  if (input.allowedDomains.includes("*")) {
    return { decision: "allow" };
  }

  if (input.allowedDomains.includes(input.targetDomain)) {
    return { decision: "allow" };
  }

  return { decision: "deny", reason: "constraint.domains" };
}

function tierRank(tier: RiskTier): number {
  return riskTiers.indexOf(tier);
}
