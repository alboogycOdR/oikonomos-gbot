export const riskTiers = [
  "T0_observe",
  "T1_draft",
  "T2_internal",
  "T3_external",
  "T4_irreversible",
] as const;

export type RiskTier = (typeof riskTiers)[number];

export interface Capability {
  capabilityId: string;
  description: string;
  defaultTier: RiskTier;
  adapter: string;
  enabled: boolean;
}

export interface RoleGrant {
  roleId: string;
  capabilityId: string;
  maxTier: RiskTier;
  constraints: Record<string, unknown>;
}
