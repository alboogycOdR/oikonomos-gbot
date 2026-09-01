import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { actionDigest } from "@oikonomos/shared";
import { describe, expect, it } from "vitest";

import { denyDecision } from "./decision.js";
import {
  REFUSAL_MEMORY_CAP,
  RefusalMemory,
  decideWithRefusalMemory,
  type PolicyDecision,
  type RefusalAction,
} from "./refusalMemory.js";

const RUN = "run-073";
const OTHER_RUN = "run-073-other";
const TOOL = "mcp__gmail__send_message";
const OTHER_TOOL = "mcp__gmail__trash_message";
const TARGET = "review@example.test";
const OTHER_TARGET = "eve@example.test";

function action(overrides: Partial<RefusalAction> = {}): RefusalAction {
  return {
    runId: RUN,
    tool: TOOL,
    target: TARGET,
    ...overrides,
  };
}

function sourceOf(name: "refusalMemory.ts"): string {
  return readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8");
}

describe("RefusalMemory — identity and first-sight proceed", () => {
  it("lets an unseen action proceed and does not saturate a fresh run", () => {
    const memory = new RefusalMemory();
    const check = memory.consult(action());
    expect(check).toEqual({
      decision: "proceed",
      grantEpoch: 0,
      grantsApply: true,
    });
    expect(Object.isFrozen(check)).toBe(true);
    expect(memory.isSaturated(RUN)).toBe(false);
    expect(memory.grantEpoch).toBe(0);
  });

  it("treats key-order-permuted structured targets as the same action (N10)", () => {
    const memory = new RefusalMemory();
    const first = action({ target: { b: 1, a: 2 } });
    const permuted = action({ target: { a: 2, b: 1 } });
    memory.rememberDenial(first);
    const check = memory.consult(permuted);
    expect(check.decision).toBe("deny");
    if (check.decision === "deny") {
      expect(check.code).toBe("refusal.abandoned");
    }
  });

  it("keeps different tools, targets, and runs independent", () => {
    const memory = new RefusalMemory();
    memory.rememberDenial(action());
    expect(memory.consult(action({ tool: OTHER_TOOL })).decision).toBe("proceed");
    expect(memory.consult(action({ target: OTHER_TARGET })).decision).toBe("proceed");
    expect(memory.consult(action({ runId: OTHER_RUN })).decision).toBe("proceed");
    expect(memory.consult(action()).decision).toBe("deny");
  });

  it("hashes the canonical target via actionDigest, not a local sha256", () => {
    const src = sourceOf("refusalMemory.ts");
    expect(src).toMatch(/from ["']@oikonomos\/shared["']/);
    expect(src).toMatch(/\bactionDigest\b/);
    expect(src).not.toMatch(/createHash\s*\(/);
    expect(src).not.toMatch(/from ["']node:crypto["']/);
    const namespaced = actionDigest({
      toolName: "refusal.target",
      input: TARGET,
      destination: "",
    });
    expect(namespaced).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects empty runId or tool as a programming error", () => {
    const memory = new RefusalMemory();
    expect(() => memory.consult(action({ runId: "" }))).toThrow(RangeError);
    expect(() => memory.consult(action({ tool: "" }))).toThrow(RangeError);
    expect(() => memory.rememberDenial(action({ runId: "" }))).toThrow(RangeError);
  });
});

describe("RefusalMemory — same (tool, target) sticks; no second ask", () => {
  it("auto-denies a re-attempt with TASK-067 abandoned guidance and does not re-ask", () => {
    const memory = new RefusalMemory();
    const firstAsk: PolicyDecision = denyDecision("approval.not_granted");
    let asks = 0;
    const ask = (): PolicyDecision => {
      asks += 1;
      return firstAsk;
    };

    const first = decideWithRefusalMemory(memory, action(), ask);
    expect(first).toEqual(firstAsk);
    expect(asks).toBe(1);

    const second = decideWithRefusalMemory(memory, action(), ask);
    expect(second.decision).toBe("deny");
    if (second.decision !== "deny") return;
    expect(second).toEqual(denyDecision("refusal.abandoned"));
    expect(second.modelGuidance.toLowerCase()).toContain("already");
    expect(second.modelGuidance.toLowerCase()).toContain("do not retry");
    expect(second.modelGuidance).toMatch(/later permission change does not authorize/i);
    expect(second.modelGuidance).toMatch(/will not be asked again/i);
    expect(asks).toBe(1);
  });

  it("rememberDenial is idempotent for the same action", () => {
    const memory = new RefusalMemory();
    memory.rememberDenial(action());
    memory.rememberDenial(action());
    expect(memory.consult(action()).decision).toBe("deny");
    expect(memory.isSaturated(RUN)).toBe(false);
  });
});

describe("RefusalMemory — saturation fails closed", () => {
  it(`caps at ${REFUSAL_MEMORY_CAP} and saturating does not forget earlier refusals`, () => {
    expect(REFUSAL_MEMORY_CAP).toBe(512);
    const memory = new RefusalMemory();
    for (let i = 0; i < REFUSAL_MEMORY_CAP; i += 1) {
      memory.rememberDenial(action({ target: `target-${i}` }));
    }
    expect(memory.isSaturated(RUN)).toBe(false);
    expect(memory.consult(action({ target: "target-0" })).decision).toBe("deny");
    expect(memory.consult(action({ target: "target-511" })).decision).toBe("deny");

    const overflow = action({ target: "target-512" });
    expect(memory.consult(overflow).decision).toBe("proceed");
    memory.rememberDenial(overflow);
    expect(memory.isSaturated(RUN)).toBe(true);

    const overflowCheck = memory.consult(overflow);
    expect(overflowCheck.decision).toBe("deny");
    if (overflowCheck.decision === "deny") {
      expect(overflowCheck).toEqual(denyDecision("refusal.saturated"));
      expect(overflowCheck.modelGuidance.toLowerCase()).toContain("do not retry");
    }

    const further = memory.consult(action({ target: "target-513" }));
    expect(further.decision).toBe("deny");
    if (further.decision === "deny") {
      expect(further.code).toBe("refusal.saturated");
    }

    const firstStillHeld = memory.consult(action({ target: "target-0" }));
    expect(firstStillHeld.decision).toBe("deny");
    if (firstStillHeld.decision === "deny") {
      expect(firstStillHeld.code).toBe("refusal.abandoned");
    }

    expect(memory.consult(action({ runId: OTHER_RUN })).decision).toBe("proceed");
    expect(memory.isSaturated(OTHER_RUN)).toBe(false);
  });

  it("does not evict refusals — saturation is a flag, not a delete", () => {
    const src = sourceOf("refusalMemory.ts");
    expect(src).toContain("REFUSAL_MEMORY_CAP = 512");
    expect(src).toMatch(/saturated\s*=\s*true/);
    expect(src).not.toMatch(/refusals\.delete\b/);
    expect(src).not.toMatch(/refusals\.clear\b/);
  });
});

describe("RefusalMemory — grant-widening is not retroactive", () => {
  it("does not resurrect a previously denied action after policy widens to auto-allow", () => {
    const memory = new RefusalMemory();
    let asks = 0;
    const denyThenAllow = (): PolicyDecision => {
      asks += 1;
      if (asks === 1) return denyDecision("approval.not_granted");
      return { decision: "allow" };
    };

    expect(decideWithRefusalMemory(memory, action(), denyThenAllow).decision).toBe("deny");
    expect(asks).toBe(1);

    const epoch = memory.widenGrants();
    expect(epoch).toBe(1);
    expect(memory.grantEpoch).toBe(1);

    const retry = decideWithRefusalMemory(memory, action(), denyThenAllow);
    expect(retry.decision).toBe("deny");
    if (retry.decision === "deny") {
      expect(retry.code).toBe("refusal.abandoned");
      expect(retry.modelGuidance).toMatch(/later permission change does not authorize/i);
    }
    expect(asks).toBe(1);
  });

  it("applies a widened auto-allow only to actions initiated after the change", () => {
    const memory = new RefusalMemory();
    const prior = action({ target: "initiated-before-widen" });
    const first = memory.consult(prior);
    expect(first.decision).toBe("proceed");
    if (first.decision === "proceed") {
      expect(first.grantsApply).toBe(true);
      expect(first.grantEpoch).toBe(0);
    }

    memory.widenGrants();

    const priorAgain = memory.consult(prior);
    expect(priorAgain.decision).toBe("proceed");
    if (priorAgain.decision === "proceed") {
      expect(priorAgain.grantsApply).toBe(false);
    }

    let asks = 0;
    const allow = (): PolicyDecision => {
      asks += 1;
      return { decision: "allow" };
    };
    const gated = decideWithRefusalMemory(memory, prior, allow);
    expect(gated).toEqual({ decision: "proceed" });
    expect(asks).toBe(1);

    const fresh = action({ target: "initiated-after-widen" });
    const after = decideWithRefusalMemory(memory, fresh, allow);
    expect(after).toEqual({ decision: "allow" });
    expect(asks).toBe(2);
  });
});

describe("decideWithRefusalMemory — MUTATION-PROVEN liveness", () => {
  it("MUTATION-PROVEN: disabling the memory (always re-ask) turns this test RED", () => {
    const source = sourceOf("refusalMemory.ts");
    const fn = source.slice(source.indexOf("export function decideWithRefusalMemory"));
    const consultIdx = fn.indexOf("memory.consult(action)");
    const askIdx = fn.indexOf("ask()");
    expect(consultIdx).toBeGreaterThanOrEqual(0);
    expect(askIdx).toBeGreaterThan(consultIdx);
    expect(fn).toContain('if (check.decision === "deny")');
    expect(fn).toContain("memory.rememberDenial(action)");

    const memory = new RefusalMemory();
    let asks = 0;
    const ask = (): PolicyDecision => {
      asks += 1;
      return denyDecision("approval.not_granted");
    };

    const first = decideWithRefusalMemory(memory, action(), ask);
    expect(first.decision).toBe("deny");
    expect(asks).toBe(1);

    const second = decideWithRefusalMemory(memory, action(), ask);
    // If consult were skipped (always re-ask), asks would be 2 and this goes red.
    expect(second.decision).toBe("deny");
    if (second.decision === "deny") {
      expect(second.code).toBe("refusal.abandoned");
    }
    expect(second.decision).not.toBe("allow");
    expect(asks).toBe(1);
  });
});
