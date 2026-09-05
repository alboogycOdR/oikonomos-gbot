/**
 * TASK-143 / OIK-110/111 (narrowed scope: Codex/Grok subprocess path only).
 *
 * Pure decision logic for the budget-enforcement gate, mirroring
 * `enforcementGate.ts`'s split: this module only turns already-resolved
 * spend/ceiling figures into a decision. The live DB reads and the
 * subprocess-spawn interception point live in
 * `services/worker/src/subprocessProviders.ts` (the real construction site
 * `withBudgetSink`/TASK-072 documented, per this task's investigation) —
 * kept out of this package because `packages/broker` has no `@oikonomos/db`
 * dependency and must not gain I/O here.
 *
 * Fail-closed is the caller's responsibility (CLAUDE.md non-negotiable 3):
 * if a live spend read fails, the caller must deny before ever calling
 * `resolveBudgetGate`, not pass a fabricated zero through it.
 */

export interface BudgetGateInput {
  /** Null when the run has no owning routine (no per-routine ceiling to check). */
  readonly routineSpendUsd: number | null;
  /** Null when the routine has no configured budget ceiling. */
  readonly routineBudgetUsd: number | null;
  readonly platformSpendUsd: number;
  readonly platformCeilingUsd: number;
}

export type BudgetGateDenyReason = "budget.routine_exceeded" | "budget.platform_exceeded";

export type BudgetGateDecision =
  | { readonly decision: "allow" }
  | { readonly decision: "deny"; readonly reason: BudgetGateDenyReason };

function requireFiniteNonNegative(value: number, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a finite number >= 0.`);
  }
  return value;
}

/**
 * Platform-wide ceiling is checked first: it is the harder constraint
 * (CLAUDE.md's hard ceiling applies across every routine at once), and a
 * routine that is individually within its own budget must still be denied
 * once the platform-wide ceiling is breached.
 */
export function resolveBudgetGate(input: BudgetGateInput): BudgetGateDecision {
  if (typeof input !== "object" || input === null) {
    throw new Error("resolveBudgetGate requires an input object");
  }
  const platformSpendUsd = requireFiniteNonNegative(input.platformSpendUsd, "platformSpendUsd");
  const platformCeilingUsd = requireFiniteNonNegative(input.platformCeilingUsd, "platformCeilingUsd");

  if (platformSpendUsd > platformCeilingUsd) {
    return { decision: "deny", reason: "budget.platform_exceeded" };
  }

  if (input.routineBudgetUsd !== null && input.routineSpendUsd !== null) {
    const routineSpendUsd = requireFiniteNonNegative(input.routineSpendUsd, "routineSpendUsd");
    const routineBudgetUsd = requireFiniteNonNegative(input.routineBudgetUsd, "routineBudgetUsd");
    if (routineSpendUsd > routineBudgetUsd) {
      return { decision: "deny", reason: "budget.routine_exceeded" };
    }
  }

  return { decision: "allow" };
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe("@oikonomos/broker budgetGate — resolveBudgetGate (TASK-143)", () => {
    it("allows when both routine and platform spend are within ceiling", () => {
      expect(
        resolveBudgetGate({
          routineSpendUsd: 5,
          routineBudgetUsd: 10,
          platformSpendUsd: 100,
          platformCeilingUsd: 1_000,
        }),
      ).toEqual({ decision: "allow" });
    });

    it("allows when the routine has no configured budget ceiling", () => {
      expect(
        resolveBudgetGate({
          routineSpendUsd: 999,
          routineBudgetUsd: null,
          platformSpendUsd: 1,
          platformCeilingUsd: 1_000,
        }),
      ).toEqual({ decision: "allow" });
    });

    it("allows when the run has no owning routine (null spend)", () => {
      expect(
        resolveBudgetGate({
          routineSpendUsd: null,
          routineBudgetUsd: null,
          platformSpendUsd: 1,
          platformCeilingUsd: 1_000,
        }),
      ).toEqual({ decision: "allow" });
    });

    it("denies budget.routine_exceeded when a routine's spend exceeds its own budget", () => {
      expect(
        resolveBudgetGate({
          routineSpendUsd: 10.01,
          routineBudgetUsd: 10,
          platformSpendUsd: 1,
          platformCeilingUsd: 1_000,
        }),
      ).toEqual({ decision: "deny", reason: "budget.routine_exceeded" });
    });

    it("denies budget.platform_exceeded even when the routine is within its own budget", () => {
      expect(
        resolveBudgetGate({
          routineSpendUsd: 1,
          routineBudgetUsd: 10,
          platformSpendUsd: 1_000.01,
          platformCeilingUsd: 1_000,
        }),
      ).toEqual({ decision: "deny", reason: "budget.platform_exceeded" });
    });

    it("checks the platform ceiling before the routine ceiling", () => {
      // Both would independently deny; the reason must be the platform one.
      expect(
        resolveBudgetGate({
          routineSpendUsd: 999,
          routineBudgetUsd: 1,
          platformSpendUsd: 2_000,
          platformCeilingUsd: 1_000,
        }),
      ).toEqual({ decision: "deny", reason: "budget.platform_exceeded" });
    });

    it("rejects a negative platformSpendUsd rather than silently allowing", () => {
      expect(() =>
        resolveBudgetGate({
          routineSpendUsd: null,
          routineBudgetUsd: null,
          platformSpendUsd: -1,
          platformCeilingUsd: 1_000,
        }),
      ).toThrow(/platformSpendUsd/);
    });
  });
}
