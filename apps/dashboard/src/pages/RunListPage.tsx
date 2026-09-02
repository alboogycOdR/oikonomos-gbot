import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { listRuns, UnauthorizedError, type Run } from "../lib/api";
import { useAuth } from "../lib/AuthContext";

/**
 * TASK-102 AC: run list from real `GET /runs`, status/timestamps shown,
 * paginated using the endpoint's real `nextCursor` cursor shape. `role`
 * called out in this task's AC lives on `Task`, not `Run` (control-api's
 * `/runs` response never joins it in) — `taskId` is shown instead so the
 * viewer can still identify which task/role a run belongs to; a join to
 * show the role label directly would need a new control-api endpoint,
 * out of this task's scope.
 */
export function RunListPage() {
  const { markUnauthenticated } = useAuth();
  const [runs, setRuns] = useState<Run[]>([]);
  const [cursorStack, setCursorStack] = useState<Array<string | undefined>>([undefined]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const currentCursor = cursorStack[cursorStack.length - 1];

  const load = useCallback(
    async (cursor: string | undefined) => {
      setLoading(true);
      setError(null);
      try {
        const page = await listRuns(cursor !== undefined ? { cursor } : {});
        setRuns(page.runs);
        setNextCursor(page.nextCursor);
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          markUnauthenticated();
          return;
        }
        setError(err instanceof Error ? err.message : "failed to load runs");
      } finally {
        setLoading(false);
      }
    },
    [markUnauthenticated],
  );

  useEffect(() => {
    void load(currentCursor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentCursor]);

  function handleNext() {
    if (nextCursor !== null) {
      setCursorStack((stack) => [...stack, nextCursor]);
    }
  }

  function handlePrevious() {
    setCursorStack((stack) => (stack.length > 1 ? stack.slice(0, -1) : stack));
  }

  return (
    <main>
      <h1>Runs</h1>
      {loading && <p>Loading…</p>}
      {error !== null && <p role="alert">{error}</p>}
      {!loading && error === null && (
        <>
          <table>
            <thead>
              <tr>
                <th>Run</th>
                <th>Task</th>
                <th>Status</th>
                <th>Started</th>
                <th>Ended</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.runId}>
                  <td>
                    <Link to={`/runs/${run.runId}`}>{run.runId}</Link>
                  </td>
                  <td>{run.taskId}</td>
                  <td>{run.status}</td>
                  <td>{run.startedAt}</td>
                  <td>{run.endedAt ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {runs.length === 0 && <p>No runs yet.</p>}
          <button type="button" onClick={handlePrevious} disabled={cursorStack.length <= 1}>
            Previous
          </button>
          <button type="button" onClick={handleNext} disabled={nextCursor === null}>
            Next
          </button>
        </>
      )}
    </main>
  );
}
