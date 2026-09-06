import {
  createTask,
  getRole,
  getSkill,
  listRoutines,
  recordRoutineFire,
  routineInputsAvailable,
  type DatabaseOptions,
  type Routine,
} from "@oikonomos/db";

import { RoleRunScheduler, type RoutineFire } from "../scheduler/scheduler.js";

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

async function toRoutineFire(options: DatabaseOptions, routine: Routine): Promise<RoutineFire> {
  return {
    routineId: routine.routineId,
    roleId: routine.roleId,
    lane: routine.lane,
    task: {
      title: routine.name,
      goal: await routineGoal(options, routine),
      tenantId: routine.tenantId,
    },
  };
}

/**
 * Fires all enabled routines whose persisted timestamp is due. Computing the
 * following timestamp remains the scheduler-authoring concern (OIK-109), so
 * this worker consumes the stored next_fire_at without parsing schedule text.
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
      const outcome = await scheduler.fireRoutine(await toRoutineFire(options, routine), {
        environmentIsUp: async (roleId) => (await getRole(options, roleId))?.status === "active",
        createTask: async (input) => {
          await createTask(options, {
            tenantId: input.tenantId,
            roleId: input.roleId,
            title: input.title,
            goal: input.goal,
            routineId: input.routineId,
            requestedBy: `routine:${input.routineId}`,
          });
        },
        recordFire: async (routineId, fireOutcome, nextFireAt) => {
          await recordRoutineFire(options, routineId, fireOutcome, nextFireAt);
        },
      });
      return { routineId: routine.routineId, outcome };
    }),
  );
}
