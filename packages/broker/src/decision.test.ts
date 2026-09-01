import { describe, expect, it } from "vitest";

import { ALLOWLIST_MISS_REASON } from "./recheck.js";
import {
  denialCopy,
  denyCodes,
  denyDecision,
  isDenyCode,
  type DenyCode,
} from "./decision.js";

const REQUIRED_CODES = ["describe.undescribable", "allowlist.miss"] as const;

function assertsDoNotRetryAndAlternative(guidance: string): void {
  expect(guidance.toLowerCase()).toContain("do not retry");
  expect(guidance).toMatch(
    /instead|ask the operator|in chat|use a (registered )?tool|continue|split it|finish|wait for a new run/i,
  );
}

describe("denyDecision — model-directed denial shape (study §Tier 1.5)", () => {
  it("returns {decision, code, humanReason, modelGuidance} for every catalog code", () => {
    expect(denyCodes).toHaveLength(12);
    for (const code of denyCodes) {
      const decision = denyDecision(code);
      expect(decision).toEqual({
        decision: "deny",
        code,
        humanReason: expect.any(String),
        modelGuidance: expect.any(String),
      });
      expect(decision.humanReason.length).toBeGreaterThan(0);
      expect(decision.modelGuidance.length).toBeGreaterThan(0);
      expect(Object.isFrozen(decision)).toBe(true);
    }
  });

  it("guidance strings state do-not-retry and an alternative for undescribable and allowlist-miss", () => {
    for (const code of REQUIRED_CODES) {
      const decision = denyDecision(code);
      assertsDoNotRetryAndAlternative(decision.modelGuidance);
      expect(decision.code).toBe(code);
    }
  });

  it("allowlist.miss code is the same token TASK-066 already denies with", () => {
    expect(ALLOWLIST_MISS_REASON).toBe("allowlist.miss");
    const decision = denyDecision(ALLOWLIST_MISS_REASON);
    expect(decision.code).toBe(ALLOWLIST_MISS_REASON);
    expect(decision.decision).toBe("deny");
    assertsDoNotRetryAndAlternative(decision.modelGuidance);
  });

  it("every catalog entry's guidance states do-not-retry and an alternative", () => {
    for (const code of denyCodes) {
      assertsDoNotRetryAndAlternative(denyDecision(code).modelGuidance);
    }
  });

  it("isDenyCode accepts catalog codes and rejects unknown strings", () => {
    expect(isDenyCode("describe.undescribable")).toBe(true);
    expect(isDenyCode(ALLOWLIST_MISS_REASON)).toBe(true);
    expect(isDenyCode("not.a.code")).toBe(false);
    expect(isDenyCode(null)).toBe(false);
    expect(isDenyCode(undefined)).toBe(false);
  });

  it("unknown codes fail closed to undescribable rather than emitting empty guidance", () => {
    const forged = denyDecision("not.a.code" as DenyCode);
    expect(forged.decision).toBe("deny");
    expect(forged.code).toBe("describe.undescribable");
    expect(forged.humanReason.length).toBeGreaterThan(0);
    expect(forged.modelGuidance.length).toBeGreaterThan(0);
    assertsDoNotRetryAndAlternative(forged.modelGuidance);
  });

  it("denialCopy matches denyDecision text and is frozen", () => {
    const copy = denialCopy("describe.unpresentable");
    const decision = denyDecision("describe.unpresentable");
    expect(copy.humanReason).toBe(decision.humanReason);
    expect(copy.modelGuidance).toBe(decision.modelGuidance);
    expect(Object.isFrozen(copy)).toBe(true);
  });

  it("does not mint a denial without guidance — there is no reason-only constructor", () => {
    const decision = denyDecision("describe.undescribable");
    expect("reason" in decision).toBe(false);
    expect(decision.modelGuidance).toEqual(expect.any(String));
  });
});
