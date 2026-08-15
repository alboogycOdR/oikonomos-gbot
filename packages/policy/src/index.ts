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

function tierRank(tier: RiskTier): number {
  return riskTiers.indexOf(tier);
}
