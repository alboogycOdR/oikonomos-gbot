import { recordAuditEvent } from "@oikonomos/audit";
import { getAuditEventsForRun, getRun, type DatabaseOptions, type Run } from "@oikonomos/db";

import { resumeInterruptedRun } from "./runLifecycle.js";

/**
 * TASK-188 (G-07) — the worker-side half of human take-over: distinguishing
 * a takeover park from an ordinary approval park, and completing the
 * hand-back.
 *
 * Deliberately does NOT introduce a new DB column or `RunParkPort` "kind"
 * argument for this: `parkTaskRun` (runLifecycle.ts) is a single, shared
 * accessor both TASK-136's `RunParkPort.park()` (approval-gate denials) and
 * TASK-204/225's outer-catch takeover handling already call, and both set
 * the exact same `runs.status = 'waiting_approval'` — the run row itself
 * carries no "why". `services/worker/src/runLifecycle.ts` and
 * `services/control-api/src/app.ts`'s existing park/resume machinery are
 * both outside this task's `Owned_Paths` and, more to the point, changing
 * them isn't actually necessary: `HUMAN_TAKEOVER_REQUIRED_EVENT_TYPE`
 * (`run.human_takeover_required`, chatRunDriver.ts) is ALREADY a real,
 * persisted, timestamped marker recorded at the moment of parking. "Is this
 * park a takeover" is answerable purely by reading the audit trail —
 * genuinely simpler than adding a column, not a workaround for being
 * unable to touch one.
 *
 * Real control-api wiring (a `TakeoverPort` implementation backed by these
 * functions, injected via `ports.ts`/`index.ts`) is left to a follow-up
 * task — `services/control-api/src/app.ts` defines the port shape and
 * route logic now, answering `501` until that wiring lands, matching
 * TASK-171's `LiveAgentPort`/TASK-179's `ThreadContextPort`/TASK-187's
 * `SecretRequestsPort` precedent exactly (all three make the same
 * "route logic in-territory now, real DI is real follow-up work" call, for
 * the same reason: the DB/wiring files a real implementation needs are
 * outside this task's own `Owned_Paths`).
 */

/** Mirrors `chatRunDriver.ts`'s own constant — see that file for why this string, not re-exported. */
const HUMAN_TAKEOVER_REQUIRED_EVENT_TYPE = "run.human_takeover_required";

/** Recorded once a human has completed the required step (signed in, solved a CAPTCHA, etc.). */
export const TAKEOVER_COMPLETED_EVENT_TYPE = "run.human_takeover_completed";

export interface TakeoverState {
  readonly runId: string;
  /** True iff the run is genuinely still parked awaiting a human takeover — not a regular approval park, and not already completed. */
  readonly pending: boolean;
  /** Present only when `pending` is true. */
  readonly kind?: string;
  readonly detail?: string;
}

/**
 * Reads the run's own audit trail to decide whether it is parked FOR A
 * TAKEOVER specifically, not merely parked (an ordinary approval wait looks
 * identical at the `runs.status` level). Ascending order
 * (`getAuditEventsForRun`'s own documented order) means the LAST matching
 * event is the most recent — a `human_takeover_completed` after the most
 * recent `human_takeover_required` means this exact takeover was already
 * handled (e.g. a retried hand-back call), even though the run itself may
 * since have parked again for a second, later takeover.
 */
export async function getTakeoverState(options: DatabaseOptions, runId: string): Promise<TakeoverState> {
  const run = await getRun(options, runId);
  if (run === null || run.status !== "waiting_approval") return { runId, pending: false };

  const events = await getAuditEventsForRun(options, runId);
  let lastRequired: { kind: string; detail: string; at: Date } | undefined;
  let lastCompletedAt: Date | undefined;
  for (const event of events) {
    if (event.eventType === HUMAN_TAKEOVER_REQUIRED_EVENT_TYPE) {
      const payload = event.payload;
      lastRequired = {
        kind: typeof payload.kind === "string" ? payload.kind : "unknown",
        detail: typeof payload.detail === "string" ? payload.detail : "",
        at: event.at,
      };
    } else if (event.eventType === TAKEOVER_COMPLETED_EVENT_TYPE) {
      lastCompletedAt = event.at;
    }
  }
  if (lastRequired === undefined) return { runId, pending: false };
  if (lastCompletedAt !== undefined && lastCompletedAt >= lastRequired.at) return { runId, pending: false };
  return { runId, pending: true, kind: lastRequired.kind, detail: lastRequired.detail };
}

export interface CompleteTakeoverResult {
  readonly completed: true;
  readonly run: Run;
}

export type CompleteTakeoverOutcome =
  | CompleteTakeoverResult
  | { readonly completed: false; readonly reason: "not_pending" | "cannot_resume" };

/**
 * Hand-back: records the completed event, then resumes the run through the
 * SAME `resumeInterruptedRun` path (runLifecycle.ts) TASK-133's own
 * boot-time reconciliation and TASK-135's durable-resume both already use
 * — deliberately not a bespoke takeover-only resume mechanism, so it
 * inherits those paths' existing guarantees (re-derives `session_ref` from
 * the database, throws on an illegal source status) rather than
 * duplicating them.
 *
 * Refuses (`cannot_resume`) rather than resuming into an unusable state
 * when the run has no persisted `session_ref` — the exact same real,
 * disclosed gap `resumeApprovedChatRun` (app.ts) already surfaces for a
 * Gemini run with no resumable session, not a new one this task
 * introduces.
 */
export async function completeTakeover(options: DatabaseOptions, runId: string): Promise<CompleteTakeoverOutcome> {
  const state = await getTakeoverState(options, runId);
  if (!state.pending) return { completed: false, reason: "not_pending" };

  const before = await getRun(options, runId);
  if (before?.sessionRef === null || before === null) return { completed: false, reason: "cannot_resume" };

  await recordAuditEvent(options, {
    tenantId: before.tenantId,
    runId,
    actor: "human",
    eventType: TAKEOVER_COMPLETED_EVENT_TYPE,
    payload: { kind: state.kind, detail: state.detail },
  });

  const run = await resumeInterruptedRun(options, runId);
  return { completed: true, run };
}
