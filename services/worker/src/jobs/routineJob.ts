import {
  createTaskExecutionRun,
  getOrCreateThreadForRole,
  getRole,
  getSkill,
  listRoutines,
  recordRoutineFire,
  resolveRoleRuntime,
  routineInputsAvailable,
  type DatabaseOptions,
  type Routine,
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
  outcome: "queued" | "missed" | "stopped" | "skipped_paused";
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

  return Promise.all(
    dueRoutines.map(async (routine) => {
      if (routine.paused) {
        await recordRoutineFire(options, routine.routineId, "skipped_paused", routine.nextFireAt, "routine is paused");
        return { routineId: routine.routineId, outcome: "skipped_paused" as const };
      }
      const unavailableReason = await routineInputsAvailable(options, routine);
      if (unavailableReason !== null && (routine.onMissingSource ?? "report_and_stop") === "report_and_stop") {
        await recordRoutineFire(options, routine.routineId, "stopped", routine.nextFireAt, unavailableReason);
        return { routineId: routine.routineId, outcome: "stopped" as const };
      }
      const outcome = await scheduler.fireRoutine(await toRoutineFire(options, routine, now), {
        environmentIsUp: async (roleId) => (await getRole(options, roleId))?.status === "active",
        createTask: async (input) => {
          await createAndEnqueueRoutineRun(options, input);
        },
        recordFire: async (routineId, fireOutcome, nextFireAt) => {
          await recordRoutineFire(options, routineId, fireOutcome, nextFireAt);
        },
      });
      return { routineId: routine.routineId, outcome };
    }),
  );
}
