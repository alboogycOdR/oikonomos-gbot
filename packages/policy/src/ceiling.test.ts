import { describe, expect, it } from "vitest";

import {
  resolveCapabilityTier,
  resolveEffectiveTier,
  riskTiers,
} from "./index.js";

describe("resolveEffectiveTier", () => {
  it("returns the stricter tier for every requested and ceiling pair", () => {
    for (const requested of riskTiers) {
      for (const ceiling of riskTiers) {
        const expected =
          riskTiers.indexOf(requested) >= riskTiers.indexOf(ceiling)
            ? requested
            : ceiling;

        expect(resolveEffectiveTier(requested, ceiling)).toBe(expected);
      }
    }
  });

  it("preserves the platform-resolved tier when no ceiling is configured", () => {
    for (const requested of riskTiers) {
      expect(resolveEffectiveTier(requested, undefined)).toBe(requested);
    }
  });
});

describe("resolveCapabilityTier ceiling integration", () => {
  it("routes the final capability resolution through the ceiling clamp", () => {
    expect(
      resolveCapabilityTier({
        toolName: "mcp__gmail__send_message",
        capabilities: [
          {
            toolName: "mcp__gmail__send_message",
            defaultTier: "T1_draft",
          },
        ],
        roleGrantOverride: "T2_internal",
        ceiling: "T4_irreversible",
      }),
    ).toEqual({ decision: "allow", tier: "T4_irreversible" });
  });
});
