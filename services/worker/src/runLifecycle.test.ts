import { describe, expect, it, vi } from "vitest";

vi.mock("@oikonomos/approvals", () => ({ invalidatePendingApproval: vi.fn() }));
vi.mock("@oikonomos/audit", () => ({ recordAuditEvent: vi.fn() }));
vi.mock("@oikonomos/db", () => ({
  cancelRun: vi.fn(),
  completeRun: vi.fn(),
  failRun: vi.fn(),
  getRun: vi.fn(),
  listPendingApprovals: vi.fn(),
  listRuns: vi.fn(),
  parkRun: vi.fn(),
  resumeRun: vi.fn(),
  startRun: vi.fn(),
}));

import { listRuns, type Run } from "@oikonomos/db";

import { isNonExecutableTestFixtureRun, reconcileInterruptedRuns } from "./runLifecycle.js";

describe("isNonExecutableTestFixtureRun (TASK-257)", () => {
  it("skips only the fixture-only test provider", () => {
    expect(isNonExecutableTestFixtureRun({ provider: "test" })).toBe(true);
  });

  it("keeps every executable provider eligible for interrupted-run recovery", () => {
    for (const provider of ["claude", "claude-code", "codex", "grok-build", "test-double"]) {
      expect(isNonExecutableTestFixtureRun({ provider })).toBe(false);
    }
  });

  it("does not enqueue stale test fixtures while preserving a real interrupted run", async () => {
    const fixture: Run = {
      runId: "fixture-run", taskId: "fixture-task", tenantId: "basileia", provider: "test",
      sessionRef: null, status: "started" as const, startedAt: new Date(), endedAt: null, failureNote: null,
    };
    const realRun: Run = { ...fixture, runId: "real-run", provider: "claude" };
    vi.mocked(listRuns).mockImplementation(async (_options, filter) => ({
      runs: filter?.status === "started" ? [fixture, realRun] : [],
      nextCursor: null,
    }));
    const enqueue = vi.fn(async (run: Run) => ({ runId: run.runId, mode: "resume" as const }));

    const outcomes = await reconcileInterruptedRuns(
      { connectionString: "postgres://not-used-by-mocked-list-runs" },
      {},
      enqueue,
    );

    expect(enqueue).toHaveBeenCalledExactlyOnceWith(realRun);
    expect(outcomes).toEqual([{ runId: realRun.runId, outcome: "requeued" }]);
  });
});
