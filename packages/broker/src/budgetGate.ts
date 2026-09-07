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

/**
 * A single provider's own spend against its own cap (TASK-209).
 *
 * ADR-011 §7 (2026-09-06 addendum): after the R30,000 → R350 reset,
 * `gemini-3.7-flash` must not become an uncapped default for tool-executing
 * runs — Stage 2 promotion is gated on a documented per-provider hard cap,
 * not on the liveness canary alone. Before this, "Gemini may spend at most
 * X" was inexpressible: the gate knew one routine budget and one platform
 * ceiling and nothing else.
 *
 * The cap is ABSOLUTE (a USD figure), deliberately not a share of the
 * platform ceiling. A share silently rises whenever the ceiling is raised,
 * which is precisely the failure §7 was written against: the ceiling moved
 * by ~86x in this project's own history, and a percentage cap would have
 * moved with it without anyone deciding to. An absolute cap has to be
 * re-decided by a human to change.
 */
export interface ProviderBudgetInput {
  /** Provider whose spend this is, e.g. "gemini". Named in the deny reason. */
  readonly provider: string;
  /** That provider's own spend over the same window as the platform figure. */
  readonly spendUsd: number;
  /** Null when this provider has no configured cap (uncapped, platform ceiling still applies). */
  readonly capUsd: number | null;
}

export interface BudgetGateInput {
  /** Null when the run has no owning routine (no per-routine ceiling to check). */
  readonly routineSpendUsd: number | null;
  /** Null when the routine has no configured budget ceiling. */
  readonly routineBudgetUsd: number | null;
  readonly platformSpendUsd: number;
  readonly platformCeilingUsd: number;
  /** Omitted for callers with no provider dimension; behaviour is then unchanged. */
  readonly provider?: ProviderBudgetInput | null;
}

export type BudgetGateDenyReason =
  | "budget.routine_exceeded"
  | "budget.platform_exceeded"
  | "budget.provider_exceeded";

export type BudgetGateDecision =
  | { readonly decision: "allow" }
  | {
    readonly decision: "deny";
    readonly reason: BudgetGateDenyReason;
    /** Present only on `budget.provider_exceeded`, naming which provider capped out. */
    readonly provider?: string;
  };

/**
 * Env var holding a provider's absolute monthly cap in USD, e.g.
 * `OIK_PROVIDER_CAP_USD_GEMINI=5`. Configuration rather than a literal so a
 * cap can be tightened without a deploy — ADR-011 §7 requires the cap to be
 * *documented*, and a number buried in a compiled bundle is not that.
 */
export function providerCapEnvVar(provider: string): string {
  return `OIK_PROVIDER_CAP_USD_${provider.trim().toUpperCase().replaceAll(/[^A-Z0-9]+/g, "_")}`;
}

/**
 * Resolves a provider's configured cap, or `null` when none is set.
 *
 * Deliberately NOT defaulted to some built-in number: a wrong default here
 * either throttles a provider nobody meant to throttle, or invents a ceiling
 * an operator never agreed to. Unset means uncapped, and the platform
 * ceiling still binds. A malformed value throws rather than being treated as
 * absent — a typo'd cap must not silently become "no cap at all".
 */
export function resolveProviderCapUsd(
  provider: string,
  env: Record<string, string | undefined> = process.env,
): number | null {
  const raw = env[providerCapEnvVar(provider)]?.trim();
  if (raw === undefined || raw.length === 0) return null;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${providerCapEnvVar(provider)} must be a finite number >= 0.`);
  }
  return parsed;
}

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

  // Ceiling semantics are "hard ceiling" (CLAUDE.md "Budget"): spend AT the
  // ceiling must already deny the next spawn, not allow one more turn past
  // it. `>=`, not `>` (REWORK finding, 2026-09-05).
  if (platformSpendUsd >= platformCeilingUsd) {
    return { decision: "deny", reason: "budget.platform_exceeded" };
  }

  // Checked after the platform ceiling and before the routine budget, in
  // order of how broadly each constraint binds: platform covers every run,
  // a provider cap covers every routine using that provider, a routine
  // budget covers one routine. Same hard-ceiling semantics as the others
  // (`>=`): spend AT the cap already denies the next call.
  const provider = input.provider;
  if (provider !== undefined && provider !== null && provider.capUsd !== null) {
    if (typeof provider.provider !== "string" || provider.provider.length === 0) {
      throw new Error("provider.provider must be a non-empty string.");
    }
    const providerSpendUsd = requireFiniteNonNegative(provider.spendUsd, "provider.spendUsd");
    const providerCapUsd = requireFiniteNonNegative(provider.capUsd, "provider.capUsd");
    if (providerSpendUsd >= providerCapUsd) {
      return { decision: "deny", reason: "budget.provider_exceeded", provider: provider.provider };
    }
  }

  if (input.routineBudgetUsd !== null && input.routineSpendUsd !== null) {
    const routineSpendUsd = requireFiniteNonNegative(input.routineSpendUsd, "routineSpendUsd");
    const routineBudgetUsd = requireFiniteNonNegative(input.routineBudgetUsd, "routineBudgetUsd");
    if (routineSpendUsd >= routineBudgetUsd) {
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

    it("denies budget.routine_exceeded when spend equals the ceiling exactly (hard ceiling, REWORK fix)", () => {
      expect(
        resolveBudgetGate({
          routineSpendUsd: 10,
          routineBudgetUsd: 10,
          platformSpendUsd: 1,
          platformCeilingUsd: 1_000,
        }),
      ).toEqual({ decision: "deny", reason: "budget.routine_exceeded" });
    });

    it("denies budget.platform_exceeded when spend equals the ceiling exactly, including a zero/zero routine (hard ceiling, REWORK fix)", () => {
      expect(
        resolveBudgetGate({
          routineSpendUsd: 0,
          routineBudgetUsd: 0,
          platformSpendUsd: 1_000,
          platformCeilingUsd: 1_000,
        }),
      ).toEqual({ decision: "deny", reason: "budget.platform_exceeded" });
    });

    // TASK-209 — ADR-011 §7's per-provider hard cap.
    const withinEverythingElse = {
      routineSpendUsd: 1,
      routineBudgetUsd: 1_000,
      platformSpendUsd: 1,
      platformCeilingUsd: 1_000,
    } as const;

    it("denies budget.provider_exceeded and names the provider that capped out", () => {
      expect(
        resolveBudgetGate({
          ...withinEverythingElse,
          provider: { provider: "gemini", spendUsd: 5, capUsd: 5 },
        }),
      ).toEqual({ decision: "deny", reason: "budget.provider_exceeded", provider: "gemini" });
    });

    it("applies the same hard-ceiling semantics as the other two ceilings (>=, not >)", () => {
      expect(
        resolveBudgetGate({
          ...withinEverythingElse,
          provider: { provider: "gemini", spendUsd: 4.999, capUsd: 5 },
        }),
      ).toEqual({ decision: "allow" });
    });

    it("allows an uncapped provider, leaving the platform ceiling as its only bound", () => {
      expect(
        resolveBudgetGate({
          ...withinEverythingElse,
          provider: { provider: "claude", spendUsd: 999, capUsd: null },
        }),
      ).toEqual({ decision: "allow" });
    });

    it("leaves every existing caller's behaviour unchanged when no provider is supplied", () => {
      expect(resolveBudgetGate(withinEverythingElse)).toEqual({ decision: "allow" });
      expect(resolveBudgetGate({ ...withinEverythingElse, provider: null })).toEqual({ decision: "allow" });
    });

    it("checks the platform ceiling before the provider cap", () => {
      // Both would independently deny; platform is the broader constraint.
      expect(
        resolveBudgetGate({
          routineSpendUsd: null,
          routineBudgetUsd: null,
          platformSpendUsd: 2_000,
          platformCeilingUsd: 1_000,
          provider: { provider: "gemini", spendUsd: 999, capUsd: 1 },
        }),
      ).toEqual({ decision: "deny", reason: "budget.platform_exceeded" });
    });

    it("denies on the provider cap before the routine budget, when both would deny", () => {
      expect(
        resolveBudgetGate({
          routineSpendUsd: 999,
          routineBudgetUsd: 1,
          platformSpendUsd: 1,
          platformCeilingUsd: 1_000,
          provider: { provider: "gemini", spendUsd: 9, capUsd: 5 },
        }),
      ).toEqual({ decision: "deny", reason: "budget.provider_exceeded", provider: "gemini" });
    });

    it("rejects a malformed provider cap rather than silently allowing an uncapped run", () => {
      expect(() =>
        resolveBudgetGate({
          ...withinEverythingElse,
          provider: { provider: "gemini", spendUsd: -1, capUsd: 5 },
        }),
      ).toThrow(/provider\.spendUsd/);
      expect(() =>
        resolveBudgetGate({
          ...withinEverythingElse,
          provider: { provider: "", spendUsd: 1, capUsd: 5 },
        }),
      ).toThrow(/provider\.provider/);
    });

    it("reads a provider cap from configuration, treating unset as uncapped", () => {
      expect(providerCapEnvVar("gemini")).toBe("OIK_PROVIDER_CAP_USD_GEMINI");
      expect(providerCapEnvVar("free-llm-api")).toBe("OIK_PROVIDER_CAP_USD_FREE_LLM_API");
      expect(resolveProviderCapUsd("gemini", {})).toBeNull();
      expect(resolveProviderCapUsd("gemini", { OIK_PROVIDER_CAP_USD_GEMINI: "  " })).toBeNull();
      expect(resolveProviderCapUsd("gemini", { OIK_PROVIDER_CAP_USD_GEMINI: "5.25" })).toBe(5.25);
      expect(resolveProviderCapUsd("gemini", { OIK_PROVIDER_CAP_USD_GEMINI: "0" })).toBe(0);
    });

    it("throws on a malformed cap rather than silently treating it as uncapped", () => {
      // A typo'd cap must not read as "no cap at all" — that is the exact
      // failure ADR-011 §7 exists to prevent.
      expect(() => resolveProviderCapUsd("gemini", { OIK_PROVIDER_CAP_USD_GEMINI: "five dollars" })).toThrow(/OIK_PROVIDER_CAP_USD_GEMINI/);
      expect(() => resolveProviderCapUsd("gemini", { OIK_PROVIDER_CAP_USD_GEMINI: "-1" })).toThrow(/OIK_PROVIDER_CAP_USD_GEMINI/);
    });

    it("LIVENESS: an inert provider cap is detectable — a capped-out provider must not reach allow", () => {
      // ADR-005: keyed on the deny this gate actually emits when it does its
      // job, not on the cap being configured. Deleting the provider block in
      // resolveBudgetGate turns this red, because a provider at 100x its cap
      // would then be allowed on the strength of the platform ceiling alone.
      const cappedOut = resolveBudgetGate({
        routineSpendUsd: null,
        routineBudgetUsd: null,
        platformSpendUsd: 0.01,
        platformCeilingUsd: 1_000,
        provider: { provider: "gemini", spendUsd: 100, capUsd: 1 },
      });

      expect(cappedOut.decision).toBe("deny");
      expect(cappedOut.decision).not.toBe("allow");
      expect(cappedOut).toMatchObject({ reason: "budget.provider_exceeded", provider: "gemini" });
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
