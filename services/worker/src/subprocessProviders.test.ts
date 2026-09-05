import { CodexProvider } from "@oikonomos/agent-providers";
import { createRole, createRoutine, getRoutineSpendUsd, type DatabaseOptions } from "@oikonomos/db";
import type { GateSubprocess } from "@oikonomos/harness-factory";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createGatedSubprocessProviders,
  DEFAULT_PLATFORM_CEILING_ZAR,
  DEFAULT_USD_TO_ZAR_RATE,
  wrapGateWithBudget,
  withRecordedSpend,
  type GatedSubprocessBudgetOptions,
} from "./subprocessProviders.js";

const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

const allowAll: GateSubprocess = async (request) => ({ allow: true, request });

describe("services/worker subprocessProviders — createGatedSubprocessProviders (TASK-143)", () => {
  it("passes the gate through unchanged when unsafeAllowUnbudgeted opts out of budget enforcement", () => {
    const factories = createGatedSubprocessProviders({
      codex: { bin: "codex", defaultModel: "gpt-5.4", sandbox: "workspace-write" },
      grok: { bin: "grok", defaultModel: "grok-5", sandbox: "workspace", alwaysApprove: true },
      unsafeAllowUnbudgeted: true,
    });
    const codex = factories.createCodex(allowAll);
    expect(codex).toBeInstanceOf(CodexProvider);
  });

  it("rejects a non-numeric options argument", () => {
    expect(() => createGatedSubprocessProviders(null as never)).toThrow(/requires provider options/);
  });

  it("requires a budget option or an explicit unsafeAllowUnbudgeted opt-out (REWORK session 3 liveness fix)", () => {
    expect(() =>
      createGatedSubprocessProviders({
        codex: { bin: "codex", defaultModel: "gpt-5.4", sandbox: "workspace-write" },
        grok: { bin: "grok", defaultModel: "grok-5", sandbox: "workspace", alwaysApprove: true },
      }),
    ).toThrow(/requires a `budget` option/);
  });
});

describe("services/worker subprocessProviders — wrapGateWithBudget (TASK-143, no DB required)", () => {
  it("fails closed (denies) when the DB read rejects", async () => {
    const budget: GatedSubprocessBudgetOptions = {
      db: { connectionString: "postgres://unreachable-host-for-test:1/db" },
      runId: "run-x",
      routineId: null,
    };
    const gated = wrapGateWithBudget(allowAll, budget);
    const result = await gated({ provider: "codex", command: "codex", args: [], cwd: "/tmp" });
    expect(result.allow).toBe(false);
    expect((result as { message: string }).message).toMatch(/budget\.check_failed/);
  });

  it("fails closed when USD_TO_ZAR_RATE is not a positive finite number", async () => {
    const budget: GatedSubprocessBudgetOptions = {
      db: { connectionString: "postgres://unreachable-host-for-test:1/db" },
      runId: "run-x",
      routineId: null,
      usdToZarRate: 0,
    };
    const gated = wrapGateWithBudget(allowAll, budget);
    const result = await gated({ provider: "codex", command: "codex", args: [], cwd: "/tmp" });
    expect(result.allow).toBe(false);
  });

  it("fails closed when platformCeilingZar is not a finite non-negative number (REWORK fix)", async () => {
    const budget: GatedSubprocessBudgetOptions = {
      db: { connectionString: "postgres://unreachable-host-for-test:1/db" },
      runId: "run-x",
      routineId: null,
      platformCeilingZar: Number.NaN,
    };
    const gated = wrapGateWithBudget(allowAll, budget);
    const result = await gated({ provider: "codex", command: "codex", args: [], cwd: "/tmp" });
    expect(result.allow).toBe(false);
  });
});

integration("services/worker subprocessProviders — live budget enforcement (TASK-143)", () => {
  let pool: Pool;
  const db: DatabaseOptions = { connectionString: connectionString! };
  const roleId = "task-143-subprocess-role";
  let routineIdWithBudget: string;
  let routineIdNoBudget: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString! });
    await pool.query(`DELETE FROM spend_records WHERE run_id LIKE 'task-143-sp-run-%'`);
    await createRole(db, { roleId, name: "TASK-143 subprocess role", title: "Budget test role" });
    const withBudget = await createRoutine(db, {
      roleId,
      name: "task-143-routine-with-budget",
      definition: { budgetUsd: 5 },
    });
    routineIdWithBudget = withBudget.routineId;
    const noBudget = await createRoutine(db, {
      roleId,
      name: "task-143-routine-no-budget",
      definition: {},
    });
    routineIdNoBudget = noBudget.routineId;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM spend_records WHERE run_id LIKE 'task-143-sp-run-%'`);
    await pool.query(`DELETE FROM role_routines WHERE role_id = $1`, [roleId]);
    await pool.query(`DELETE FROM roles WHERE role_id = $1`, [roleId]);
    await pool.end();
  });

  it("allows a spawn when the routine is within its configured budget", async () => {
    const budget: GatedSubprocessBudgetOptions = { db, runId: "task-143-sp-run-1", routineId: routineIdWithBudget };
    const gated = wrapGateWithBudget(allowAll, budget);
    const result = await gated({ provider: "codex", command: "codex", args: [], cwd: "/tmp" });
    expect(result.allow).toBe(true);
  });

  it("denies budget.routine_exceeded once the routine's recorded spend exceeds its budgetUsd", async () => {
    const { recordSpend } = await import("@oikonomos/db");
    await recordSpend(db, {
      runId: "task-143-sp-run-2",
      routineId: routineIdWithBudget,
      provider: "codex",
      model: "gpt-5.4",
      costUsd: 6,
    });
    const budget: GatedSubprocessBudgetOptions = { db, runId: "task-143-sp-run-2", routineId: routineIdWithBudget };
    const gated = wrapGateWithBudget(allowAll, budget);
    const result = await gated({ provider: "codex", command: "codex", args: [], cwd: "/tmp" });
    expect(result.allow).toBe(false);
    expect((result as { message: string }).message).toBe("budget.routine_exceeded");
  });

  it("allows a routine with no configured budgetUsd regardless of its spend", async () => {
    const { recordSpend } = await import("@oikonomos/db");
    await recordSpend(db, {
      runId: "task-143-sp-run-3",
      routineId: routineIdNoBudget,
      provider: "codex",
      model: "gpt-5.4",
      costUsd: 1_000,
    });
    const budget: GatedSubprocessBudgetOptions = { db, runId: "task-143-sp-run-3", routineId: routineIdNoBudget };
    const gated = wrapGateWithBudget(allowAll, budget);
    const result = await gated({ provider: "codex", command: "codex", args: [], cwd: "/tmp" });
    expect(result.allow).toBe(true);
  });

  it("denies budget.platform_exceeded once platform-wide spend exceeds the ZAR ceiling converted at the configured rate", async () => {
    const { recordSpend } = await import("@oikonomos/db");
    // Ceiling well below what a single recorded turn will exceed, in USD terms.
    const tinyCeilingZar = 10;
    const rate = 1; // 1 USD == 1 ZAR for this test, to make the arithmetic exact.
    await recordSpend(db, {
      runId: "task-143-sp-run-4",
      routineId: null,
      provider: "grok",
      model: "grok-5",
      costUsd: tinyCeilingZar + 1,
    });
    const budget: GatedSubprocessBudgetOptions = {
      db,
      runId: "task-143-sp-run-4",
      routineId: null,
      usdToZarRate: rate,
      platformCeilingZar: tinyCeilingZar,
    };
    const gated = wrapGateWithBudget(allowAll, budget);
    const result = await gated({ provider: "grok", command: "grok", args: [], cwd: "/tmp" });
    expect(result.allow).toBe(false);
    expect((result as { message: string }).message).toBe("budget.platform_exceeded");
  });

  it("withRecordedSpend persists a real spend record when the wrapped provider completes a turn", async () => {
    const fakeProvider = {
      id: "codex" as const,
      displayName: "fake",
      capabilities: { agentic: true, resumableSessions: false, permissionPrompts: false, interruptible: false },
      defaultModel: "gpt-5.4",
      availableModels: ["gpt-5.4"] as const,
      async *sendPrompt(_opts: never) {
        yield { type: "turn_complete" as const, sessionId: null, costUsd: 0.42, durationMs: 10, turns: 1 };
      },
      async interrupt() {
        return undefined;
      },
    };
    const budget: GatedSubprocessBudgetOptions = { db, runId: "task-143-sp-run-5", routineId: routineIdWithBudget };
    const wrapped = withRecordedSpend(fakeProvider, budget);
    const events = [];
    for await (const event of wrapped.sendPrompt({ cwd: "/tmp", signal: new AbortController().signal, sessionId: null } as never)) {
      events.push(event);
    }
    expect(events).toHaveLength(1);

    const spend = await getRoutineSpendUsd(db, routineIdWithBudget);
    // 6 (recorded above) + 1000 isn't in this routine; only the 6 + this 0.42 turn.
    expect(spend).toBeCloseTo(6.42);
  });

  it("fails closed (denies) on a dangling routineId that doesn't resolve to any role_routines row (REWORK fix)", async () => {
    const budget: GatedSubprocessBudgetOptions = {
      db,
      runId: "task-143-sp-run-dangling",
      routineId: "task-143-nonexistent-routine-id",
    };
    const gated = wrapGateWithBudget(allowAll, budget);
    const result = await gated({ provider: "codex", command: "codex", args: [], cwd: "/tmp" });
    expect(result.allow).toBe(false);
    expect((result as { message: string }).message).toMatch(/budget\.check_failed/);
  });

  it("exposes the documented placeholder defaults", () => {
    expect(DEFAULT_USD_TO_ZAR_RATE).toBeGreaterThan(0);
    expect(DEFAULT_PLATFORM_CEILING_ZAR).toBe(30_000);
  });
});
