import type { RiskTier } from "./index.js";

/** Ordered from least to most restrictive. Exhaustive over `RiskTier`. */
const tierRanks = {
  T0_observe: 0,
  T1_draft: 1,
  T2_internal: 2,
  T3_external: 3,
  T4_irreversible: 4,
} satisfies Record<RiskTier, number>;

/**
 * Applies an optional administrative ceiling to a resolved tier.
 *
 * Higher ranks are more restrictive, so a ceiling can only tighten a request.
 * Omitting a ceiling preserves the platform-resolved tier.
 */
export function resolveEffectiveTier(
  requested: RiskTier,
  ceiling: RiskTier | undefined,
): RiskTier {
  if (ceiling === undefined) {
    return requested;
  }

  return tierRanks[requested] >= tierRanks[ceiling] ? requested : ceiling;
}
