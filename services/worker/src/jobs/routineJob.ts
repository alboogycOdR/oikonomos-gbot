import {
  createTaskExecutionRun,
  getLatestAuditEvent,
  getOrCreateThreadForRole,
  getRole,
  getSkill,
  listProjectArtifacts,
  listRecentRoutineOutcomes,
  listRoutines,
  insertMessage,
  insertAuditEvent,
  recordRoutineFire,
  resolveRoleRuntime,
  routineInputsAvailable,
  setRoutinePaused,
  type DatabaseOptions,
  type Routine,
  type RoutineFireOutcome,
} from "@oikonomos/db";

import { nextFireAtFromCron } from "../routineTool.js";
import { RoleRunScheduler, type RoutineFire } from "../scheduler/scheduler.js";
import { enqueueRunExecution } from "./workerJobQueue.js";

export interface RoutinePollingOptions extends DatabaseOptions {
  tenantId: string;
  now?: () => Date;
}

export interface RoutinePollResult {
  routineId: string;
  outcome: "queued" | "missed" | "stopped" | "skipped_paused" | "skipped_unchanged";
}

function requireNonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`${field} must not be empty.`);
  return trimmed;
}

async function routineGoal(options: DatabaseOptions, routine: Routine): Promise<string> {
  const goal = routine.definition.goal;
  const base = typeof goal === "string" && goal.trim().length > 0 ? goal.trim() : routine.name;
  if (routine.skillId === null || routine.skillId === undefined) return base;
  const skill = await getSkill(options, routine.skillId);
  if (skill === null || skill.tenantId !== routine.tenantId) throw new Error(`routine skill '${routine.skillId}' is unavailable.`);
  // TASK-177's prompt assembly scans message text for this exact token.
  return `/${skill.name} ${base}`;
}

/**
 * TASK-247 / §9.3 — the routine's own IANA `timezone` is what
 * `nextFireAtFromCron` uses to advance the schedule, so a fire in
 * `America/New_York` lands on the correct UTC instant on both sides of a
 * DST transition. The base instant for "next" is the fire that just
 * happened (`routine.nextFireAt`, the exact instant this poll matched
 * against), not wall-clock `now` — a late poll must not compound drift into
 * the following occurrence. A `null` schedule (no recurrence) advances
 * nothing, matching the pre-TASK-247 behaviour for such routines.
 */
function computeNextFireAt(routine: Routine, now: Date): Date | null {
  if (routine.schedule === null) return null;
  return nextFireAtFromCron(routine.schedule, routine.timezone, routine.nextFireAt ?? now);
}

const ROUTINE_SWEEP_EVENT_TYPE = "routine.sweep";

/**
 * ADR-005 liveness check for this tenant's routine poller. A durable sweep
 * event is the evidence: a configured queue or a live-looking process is not.
 */
export async function routineSweepIsStale(
  options: RoutinePollingOptions,
  now: Date,
  maxAgeMinutes = 15,
): Promise<boolean> {
  const tenantId = requireNonEmpty(options.tenantId, "tenantId");
  if (Number.isNaN(now.getTime())) throw new Error("now must be a valid Date.");
  if (!Number.isFinite(maxAgeMinutes) || maxAgeMinutes < 0) {
    throw new Error("maxAgeMinutes must be a non-negative finite number.");
  }
  const latestSweep = await getLatestAuditEvent(options, ROUTINE_SWEEP_EVENT_TYPE, tenantId);
  return latestSweep === null || now.getTime() - latestSweep.at.getTime() > maxAgeMinutes * 60_000;
}

/**
 * TASK-329: a `stopped` fire is a routine failure. `missed` deliberately
 * does not participate: Addendum F §3.4 says an unavailable environment is
 * not a catch-up failure. `changes_only` stops are intentional no-op fires,
 * likewise outside the streak. A queued run resets it; paused/skipped
 * outcomes end the scan defensively.
 */
function consecutiveRoutineFailures(outcomes: ReadonlyArray<{ outcome: RoutineFireOutcome; reason: string | null }>): number {
  let failures = 0;
  for (const { outcome, reason } of outcomes) {
    if (outcome === "missed") continue;
    if (outcome === "stopped" && reason?.startsWith("changes_only:")) continue;
    if (outcome === "stopped") {
      failures += 1;
      continue;
    }
    break;
  }
  return failures;
}

async function recordRoutineOutcome(
  options: DatabaseOptions,
  routine: Routine,
  outcome: RoutineFireOutcome,
  nextFireAt: Date | null | undefined,
  reason: string | null,
  reportedStatusSha?: string | null,
): Promise<void> {
  await recordRoutineFire(options, routine.routineId, outcome, nextFireAt, reason, reportedStatusSha);
  if (outcome !== "stopped") return;

  const failures = consecutiveRoutineFailures(await listRecentRoutineOutcomes(options, routine.routineId, 20));
  if (failures !== 1 && failures !== 10) return;

  const thread = await getOrCreateThreadForRole(options, { roleId: routine.roleId });
  if (failures === 10) {
    await setRoutinePaused(options, routine.routineId, true);
    await insertMessage(options, {
      threadId: thread.id,
      role: "system",
      body: `Routine "${routine.name}" was paused after 10 consecutive failures: ${reason ?? "no reason recorded"}`,
    });
    return;
  }
  await insertMessage(options, {
    threadId: thread.id,
    role: "system",
    body: `Routine "${routine.name}" failed: ${reason ?? "no reason recorded"}`,
  });
}

/**
 * TASK-305 / spec §1.3, §11: a `changes_only` project status routine fires
 * (and so notifies) only when the project's latest STATUS.md artifact digest
 * differs from the one last reported, persisted in
 * `definition.lastReportedStatusSha`. Returns `{ gated: false }` for any
 * routine that is not a changes_only project routine.
 */
async function statusGate(
  options: DatabaseOptions,
  routine: Routine,
): Promise<{ gated: false } | { gated: true; sha: string | null; unchanged: boolean }> {
  const projectId = routine.definition["projectId"];
  if (routine.notifyThreshold !== "changes_only" || typeof projectId !== "string") return { gated: false };
  const artifacts = await listProjectArtifacts(options, { projectId });
  const status = artifacts
    .filter((artifact) => artifact.label === "STATUS.md")
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  const sha = status?.sha256 ?? null;
  const last = routine.definition["lastReportedStatusSha"];
  return { gated: true, sha, unchanged: sha === null || sha === last };
}

async function toRoutineFire(options: DatabaseOptions, routine: Routine, now: Date): Promise<RoutineFire> {
  return {
    routineId: routine.routineId,
    roleId: routine.roleId,
    lane: routine.lane,
    task: {
      title: routine.name,
      goal: await routineGoal(options, routine),
      tenantId: routine.tenantId,
    },
    nextFireAt: computeNextFireAt(routine, now),
  };
}

/**
 * TASK-258 — the durable, atomic path a scheduled routine fire must go
 * through so it actually produces work, not just a task row.
 *
 * Before this fix, the scheduler's `createTask` port called `@oikonomos/db`'s
 * bare `createTask` directly: a plain INSERT with no run and no
 * `worker.run-execution` enqueue. Nothing else in the system reconciles a
 * run-less task (`reconcileInterruptedRuns` only recovers runs that already
 * exist in an open status), so every automatically-scheduled fire was
 * silently orphaned forever -- confirmed live against the dev database
 * during this task: 238,105/238,105 `requested_by LIKE 'routine:%'` tasks
 * had zero matching `runs` row, spanning 2026-09-05 through the live poll at
 * the time of this fix (see dossiers/TASK-258.md for the query and full
 * finding; remediation of those rows is a separate decision, out of this
 * task's scope per its own Acceptance_Criteria).
 *
 * This mirrors `services/control-api/src/ports.ts`'s `testRunRoutine` /
 * `submitTaskExecution` reference path: create the task and its initial run
 * in one atomic transaction (`createTaskExecutionRun`, chat-kind execution
 * against the role's own conversation thread), then enqueue the durable
 * `worker.run-execution` job that actually drives it -- the same two steps
 * a manual "test run" already performed correctly.
 */
async function createAndEnqueueRoutineRun(
  options: DatabaseOptions,
  input: { tenantId: string; roleId: string; title: string; goal: string; routineId: string },
): Promise<void> {
  const role = await getRole(options, input.roleId);
  if (role === null) throw new Error(`Cannot fire routine: role '${input.roleId}' not found.`);
  const thread = await getOrCreateThreadForRole(options, { roleId: input.roleId });
  const { provider } = resolveRoleRuntime(role);
  const { runId } = await createTaskExecutionRun(options, {
    task: {
      tenantId: input.tenantId,
      roleId: input.roleId,
      title: input.title,
      goal: input.goal,
      routineId: input.routineId,
      requestedBy: `routine:${input.routineId}`,
    },
    execution: { version: 1, kind: "chat", threadId: thread.id },
    provider,
  });
  await enqueueRunExecution(options.connectionString, runId);
}

/**
 * Fires all enabled routines whose persisted timestamp is due. Which
 * routines are due is decided purely from the already-stored `next_fire_at`
 * (OIK-109's scheduler-authoring concern; this worker does not parse
 * schedule text to select what is due). TASK-247 / §9.3: once a due routine
 * is actually handed to the scheduler, this file DOES parse its `schedule`
 * (respecting its `timezone`) to compute the *following* `next_fire_at`
 * before the current fire is recorded — see `computeNextFireAt` above.
 */
export async function runDueRoutinePoll(options: RoutinePollingOptions): Promise<RoutinePollResult[]> {
  const tenantId = requireNonEmpty(options.tenantId, "tenantId");
  const now = options.now?.() ?? new Date();
  if (Number.isNaN(now.getTime())) throw new Error("now must be a valid Date.");

  const routines = await listRoutines(options, { tenantId, enabled: true });
  const dueRoutines = routines.filter(
    (routine) => routine.nextFireAt !== null && routine.nextFireAt.getTime() <= now.getTime(),
  );
  const scheduler = new RoleRunScheduler({
    clock: {
      now: () => now,
      setTimeout,
      clearTimeout,
    },
    wallClockBudgetMs: 1,
    audit: () => undefined,
  });

  const results = await Promise.all(
    dueRoutines.map(async (routine) => {
      if (routine.paused) {
        await recordRoutineFire(options, routine.routineId, "skipped_paused", routine.nextFireAt, "routine is paused");
        return { routineId: routine.routineId, outcome: "skipped_paused" as const };
      }
      const unavailableReason = await routineInputsAvailable(options, routine);
      if (unavailableReason !== null && (routine.onMissingSource ?? "report_and_stop") === "report_and_stop") {
        await recordRoutineOutcome(options, routine, "stopped", routine.nextFireAt, unavailableReason);
        return { routineId: routine.routineId, outcome: "stopped" as const };
      }
      const gate = await statusGate(options, routine);
      if (gate.gated && gate.unchanged) {
        // No column for a "silent" outcome (CHECK in 016); `stopped` = no run, reason says why.
        await recordRoutineOutcome(
          options, routine, "stopped", computeNextFireAt(routine, now),
          gate.sha === null ? "changes_only: no STATUS.md to report" : "changes_only: STATUS.md unchanged since last report",
        );
        return { routineId: routine.routineId, outcome: "skipped_unchanged" as const };
      }
      const outcome = await scheduler.fireRoutine(await toRoutineFire(options, routine, now), {
        environmentIsUp: async (roleId) => (await getRole(options, roleId))?.status === "active",
        createTask: async (input) => {
          await createAndEnqueueRoutineRun(options, input);
        },
        recordFire: async (_routineId, fireOutcome, nextFireAt) => {
          await recordRoutineOutcome(
            options, routine, fireOutcome, nextFireAt, null,
            fireOutcome === "queued" && gate.gated ? gate.sha : null,
          );
        },
      });
      return { routineId: routine.routineId, outcome };
    }),
  );
  const counts = { due: dueRoutines.length, fired: 0, missed: 0, failed: 0 };
  for (const result of results) {
    if (result.outcome === "queued") counts.fired += 1;
    if (result.outcome === "missed") counts.missed += 1;
    if (result.outcome === "stopped") counts.failed += 1;
  }
  await insertAuditEvent(options, {
    tenantId,
    at: now,
    actor: "system:routine-poller",
    eventType: ROUTINE_SWEEP_EVENT_TYPE,
    payload: counts,
  });
  return results;
}
