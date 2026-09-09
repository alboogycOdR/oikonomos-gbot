import { CronExpressionParser } from "cron-parser";

import { createRoutine, insertMessage, type DatabaseOptions } from "@oikonomos/db";

/**
 * `create_routine` — the governed tool letting a bot schedule its own
 * future work from a natural-language request in chat ("check the weather
 * every day at 2pm"), instead of the human having to type a raw cron
 * expression into a separate form (the only way this worked before).
 *
 * Deliberately does NO natural-language parsing here: the MODEL is asked
 * to produce the cron expression itself (see `CREATE_ROUTINE_TOOL_DESCRIPTION`
 * below) — a real LLM is already good at "every day at 2pm" -> "0 14 * * *",
 * and building a bespoke NL-to-cron engine would be strictly worse at that
 * job for a fraction of the reliability. `nextFireAtFromCron` below mirrors
 * `services/control-api/src/app.ts`'s own validation exactly (same package,
 * same 5-field-cron requirement) — the same cron the human-facing form
 * already relies on, so a routine created this way is due-selected by
 * TASK-134's existing routine-poll path identically either way.
 *
 * Shared between the Claude lane (`workspaceMcpServer.ts`, a stdio MCP
 * tool) and the Gemini lane (`geminiToolExecutors.ts`'s
 * `createWorkspaceGeminiTools`) so the actual DB write, cron validation,
 * and confirmation-message logic exist exactly once.
 */

export const CREATE_ROUTINE_TOOL_DESCRIPTION =
  "Schedule a recurring routine for yourself. Translate the user's natural-language " +
  "timing request into a standard 5-field cron expression yourself (minute hour day " +
  "month weekday) — e.g. 'every day at 2pm' -> '0 14 * * *', 'every Monday at 9am' -> " +
  "'0 9 * * 1'. Use UTC unless the user names a timezone.";

export const createRoutineInputSchema = {
  type: "object",
  required: ["name", "schedule"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 200, description: "Short, human-readable routine name." },
    schedule: { type: "string", description: "5-field cron expression (minute hour day month weekday)." },
    goal: { type: "string", description: "What the bot should do each time this fires. Defaults to the routine name." },
    skillId: { type: "string", description: "Optional skill id to run this routine with." },
  },
} as const;

export interface CreateRoutineToolInput {
  readonly name: string;
  readonly schedule: string;
  readonly goal?: string;
  readonly skillId?: string;
}

export interface CreateRoutineToolIdentity {
  readonly connectionString: string;
  readonly tenantId: string;
  readonly roleId: string;
  readonly threadId?: string;
}

export interface CreateRoutineToolResult {
  readonly routineId: string;
  readonly name: string;
  readonly schedule: string;
  readonly nextFireAt: string;
  readonly description: string;
}

/** Mirrors `services/control-api/src/app.ts`'s own `nextFireAtFromCron` exactly. */
export function nextFireAtFromCron(schedule: string): Date {
  const normalized = schedule.trim();
  if (normalized.split(/\s+/).length !== 5) {
    throw new Error("schedule must be a valid 5-field cron expression.");
  }
  try {
    return CronExpressionParser.parse(normalized).next().toDate();
  } catch {
    throw new Error("schedule must be a valid 5-field cron expression.");
  }
}

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function formatHourMinute(hour: number, minute: number): string {
  const period = hour >= 12 ? "PM" : "AM";
  const twelveHour = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelveHour}:${minute.toString().padStart(2, "0")} ${period}`;
}

/**
 * Best-effort human description for the confirmation message in chat — NOT
 * a general cron-to-English translator. Handles the two shapes a
 * model-generated "every day/weekday at HH:MM" request actually produces;
 * anything else falls back to the raw expression rather than guessing at
 * a wrong-sounding sentence for an interval it doesn't recognize.
 */
export function describeCron(schedule: string): string {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return `on schedule: ${schedule}`;
  const [minuteField, hourField, dayField, monthField, weekdayField] = parts;
  const minute = Number.parseInt(minuteField!, 10);
  const hour = Number.parseInt(hourField!, 10);
  if (!Number.isInteger(minute) || !Number.isInteger(hour) || dayField !== "*" || monthField !== "*") {
    return `on schedule: ${schedule}`;
  }
  const time = formatHourMinute(hour, minute);
  if (weekdayField === "*") return `every day at ${time}`;
  const weekday = Number.parseInt(weekdayField!, 10);
  if (Number.isInteger(weekday) && weekday >= 0 && weekday <= 6) {
    return `every ${WEEKDAY_NAMES[weekday]} at ${time}`;
  }
  return `on schedule: ${schedule}`;
}

export function parseCreateRoutineInput(args: Record<string, unknown>): CreateRoutineToolInput {
  if (typeof args.name !== "string" || args.name.trim().length === 0) {
    throw new Error("create_routine requires a non-empty name.");
  }
  if (typeof args.schedule !== "string" || args.schedule.trim().length === 0) {
    throw new Error("create_routine requires a non-empty schedule.");
  }
  if (args.goal !== undefined && typeof args.goal !== "string") {
    throw new Error("create_routine's goal must be a string.");
  }
  if (args.skillId !== undefined && typeof args.skillId !== "string") {
    throw new Error("create_routine's skillId must be a string.");
  }
  return {
    name: args.name.trim(),
    schedule: args.schedule.trim(),
    ...(typeof args.goal === "string" && args.goal.trim().length > 0 ? { goal: args.goal.trim() } : {}),
    ...(typeof args.skillId === "string" && args.skillId.trim().length > 0 ? { skillId: args.skillId.trim() } : {}),
  };
}

/**
 * Creates the routine, then — real, persisted, not just returned to the
 * model — inserts a `role: 'system'` confirmation message into the thread
 * (the small "New routine …" line the mobile client already knows how to
 * render for a system-role message, matching the existing "Context
 * compacted" treatment) so the human sees it happened without having to
 * trust the bot's own prose. `threadId` is optional only because a
 * routine-triggered run (no live thread the model is chatting in) can also
 * reach this tool in principle; a genuine interactive chat turn always
 * supplies it.
 */
export async function createRoutineFromToolInput(
  identity: CreateRoutineToolIdentity,
  input: CreateRoutineToolInput,
): Promise<CreateRoutineToolResult> {
  const db: DatabaseOptions = { connectionString: identity.connectionString };
  const nextFireAt = nextFireAtFromCron(input.schedule);
  const routine = await createRoutine(db, {
    roleId: identity.roleId,
    tenantId: identity.tenantId,
    name: input.name,
    schedule: input.schedule,
    nextFireAt,
    definition: input.goal === undefined ? {} : { goal: input.goal },
    ...(input.skillId === undefined ? {} : { skillId: input.skillId }),
  });
  const description = describeCron(input.schedule);
  if (identity.threadId !== undefined) {
    await insertMessage(db, {
      threadId: identity.threadId,
      role: "system",
      body: `New routine "${routine.name}" — ${description}`,
    });
  }
  return {
    routineId: routine.routineId,
    name: routine.name,
    schedule: input.schedule,
    nextFireAt: nextFireAt.toISOString(),
    description,
  };
}
