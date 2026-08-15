import { describe, expect, it } from "vitest";

import {
  resolveCapabilityTier,
  resolveEffectiveTier,
  riskTiers,
  type CapabilityTier,
  type RiskTier,
} from "../src/index.js";

const capability: CapabilityTier = {
  toolName: "mcp__gmail__send_message",
  defaultTier: "T2_internal",
};

describe("resolveEffectiveTier", () => {
  it("uses the default when a role has no override", () => {
    expect(resolveEffectiveTier("T1_draft", undefined)).toBe("T1_draft");
  });

  it("selects the more restrictive tier across the complete matrix", () => {
    for (const defaultTier of riskTiers) {
      for (const roleGrantOverride of riskTiers) {
        const expected =
          riskTiers.indexOf(defaultTier) >= riskTiers.indexOf(roleGrantOverride)
            ? defaultTier
            : roleGrantOverride;

        expect(resolveEffectiveTier(defaultTier, roleGrantOverride)).toBe(expected);
      }
    }
  });
});

describe("resolveCapabilityTier", () => {
  it("returns the resolved tier for a registered capability", () => {
    expect(
      resolveCapabilityTier({
        toolName: capability.toolName,
        capabilities: [capability],
        roleGrantOverride: "T3_external",
      }),
    ).toEqual({ decision: "allow", tier: "T3_external" });
  });

  it("denies an unregistered capability with an audit-ready reason", () => {
    expect(
      resolveCapabilityTier({
        toolName: "mcp__unknown__operation",
        capabilities: [capability],
      }),
    ).toEqual({ decision: "deny", reason: "capability.unregistered" });
  });
});

describe("risk tier ordering", () => {
  it.each(riskTiers)("includes %s", (tier: RiskTier) => {
    expect(riskTiers).toContain(tier);
  });
});
