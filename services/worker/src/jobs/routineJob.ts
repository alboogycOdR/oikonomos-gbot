import {
  createTask,
  getRole,
  listRoutines,
  recordRoutineFire,
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
  outcome: "queued" | "missed";
}

function requireNonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`${field} must not be empty.`);
  return trimmed;
}

function routineGoal(routine: Routine): string {
  const goal = routine.definition.goal;
  return typeof goal === "string" && goal.trim().length > 0 ? goal.trim() : routine.name;
}

function toRoutineFire(routine: Routine): RoutineFire {
  return {
    routineId: routine.routineId,
    roleId: routine.roleId,
    lane: routine.lane,
    task: {
      title: routine.name,
      goal: routineGoal(routine),
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
      const outcome = await scheduler.fireRoutine(toRoutineFire(routine), {
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
