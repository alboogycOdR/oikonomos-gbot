// TASK-243 (spec §7.3) — the workspace's "Work" segment: lists the active
// role's routines (`GET /roles/:roleId/routines`), pause/resume/test-run
// against the existing routes (`app.ts:1203-1217`), next fire labelled
// "UTC" (no time-zone support exists — TASK-247/spec §9.3), and the latest
// run state carried over from §4 (`GET /workspace/summary`, already polled
// by `ChatPage`). Pausing a routine only ever calls `setRoutinePaused` —
// it never touches run state, so a run in flight stays exactly as
// `latestRunSummary` already shows it (spec §1 "pausing a routine never
// cancels a running run").
import { useCallback, useState } from "react";

import {
  pauseRoutine,
  resumeRoutine,
  testRunRoutine,
  UnauthorizedError,
  type Routine,
  type RunStatus,
} from "../../lib/api";

/** The exact server-side warning text (`app.ts:1216`) — surfaced verbatim, before the user confirms (spec §7.3). */
const TEST_RUN_WARNING = "test run performs real work";

export interface WorkViewProps {
  routines: Routine[];
  loading: boolean;
  error: string | null;
  /** The workspace's latest run state (spec §4), shown alongside each routine — never derived from routine state itself. */
  latestRunStatus: RunStatus | undefined;
  onRoutineChanged: (routine: Routine) => void;
  onUnauthorized: () => void;
  onError: (message: string) => void;
}

function formatNextFire(nextFireAt: string | null): string {
  if (nextFireAt === null) return "not scheduled";
  const date = new Date(nextFireAt);
  if (Number.isNaN(date.getTime())) return nextFireAt;
  return `${date.toISOString().replace(/\.\d{3}Z$/, "Z")} UTC`;
}

function RoutineRow({
  routine,
  latestRunStatus,
  onRoutineChanged,
  onUnauthorized,
  onError,
}: {
  routine: Routine;
  latestRunStatus: RunStatus | undefined;
  onRoutineChanged: (routine: Routine) => void;
  onUnauthorized: () => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirmingTestRun, setConfirmingTestRun] = useState(false);

  const handleError = useCallback(
    (err: unknown) => {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      onError(err instanceof Error ? err.message : "routine action failed");
    },
    [onUnauthorized, onError],
  );

  const handleTogglePause = useCallback(async () => {
    setBusy(true);
    try {
      const updated = routine.paused === true
        ? await resumeRoutine(routine.routineId)
        : await pauseRoutine(routine.routineId);
      onRoutineChanged(updated);
    } catch (err) {
      handleError(err);
    } finally {
      setBusy(false);
    }
  }, [routine.paused, routine.routineId, onRoutineChanged, handleError]);

  const handleConfirmTestRun = useCallback(async () => {
    setBusy(true);
    try {
      const result = await testRunRoutine(routine.routineId);
      onRoutineChanged(result.routine);
    } catch (err) {
      handleError(err);
    } finally {
      setBusy(false);
      setConfirmingTestRun(false);
    }
  }, [routine.routineId, onRoutineChanged, handleError]);

  return (
    <li className="rounded-lg bg-surface-raised p-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-slate-100">{routine.name}</p>
        <span className="text-[10px] uppercase text-slate-500">
          {routine.paused === true ? "paused" : "active"}
        </span>
      </div>
      <p className="text-xs text-slate-500">Next fire: {formatNextFire(routine.nextFireAt)}</p>
      {latestRunStatus !== undefined ? (
        <p className="text-xs text-slate-500">Latest run: {latestRunStatus}</p>
      ) : null}

      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void handleTogglePause()}
          className="rounded bg-chrome px-2 py-1 text-xs text-slate-200 hover:bg-chrome-panel disabled:opacity-50"
        >
          {routine.paused === true ? "Resume" : "Pause"}
        </button>
        {!confirmingTestRun ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => setConfirmingTestRun(true)}
            className="rounded bg-chrome px-2 py-1 text-xs text-slate-200 hover:bg-chrome-panel disabled:opacity-50"
          >
            Test run
          </button>
        ) : (
          <div className="flex items-center gap-2">
            <p role="alert" className="text-xs text-amber-400">
              {TEST_RUN_WARNING}
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleConfirmTestRun()}
              className="rounded bg-amber-600 px-2 py-1 text-xs text-white hover:bg-amber-500 disabled:opacity-50"
            >
              Confirm test run
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirmingTestRun(false)}
              className="text-xs text-slate-400 hover:text-slate-300"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

export function WorkView({
  routines,
  loading,
  error,
  latestRunStatus,
  onRoutineChanged,
  onUnauthorized,
  onError,
}: WorkViewProps) {
  return (
    <section aria-label="Work" className="flex-1 overflow-y-auto p-4">
      {loading ? <p className="text-sm text-slate-400">Loading routines…</p> : null}
      {error !== null ? (
        <p role="alert" className="mb-2 text-sm text-red-400">
          {error}
        </p>
      ) : null}
      <ul aria-label="Routines" className="space-y-3">
        {routines.map((routine) => (
          <RoutineRow
            key={routine.routineId}
            routine={routine}
            latestRunStatus={latestRunStatus}
            onRoutineChanged={onRoutineChanged}
            onUnauthorized={onUnauthorized}
            onError={onError}
          />
        ))}
        {!loading && routines.length === 0 ? (
          <li className="text-xs text-slate-500">No routines yet.</li>
        ) : null}
      </ul>
    </section>
  );
}

// re-exported for tests that want to assert the exact server literal without duplicating it.
export { TEST_RUN_WARNING };
