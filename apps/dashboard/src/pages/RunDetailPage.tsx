import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { getRun, getRunEvidence, UnauthorizedError, type AuditEvent, type Run } from "../lib/api";
import { useAuth } from "../lib/AuthContext";

/** TASK-102 AC: run detail view shows the real audit trail from `GET /runs/:id/evidence`. */
export function RunDetailPage() {
  const { runId } = useParams<{ runId: string }>();
  const { markUnauthenticated } = useAuth();
  const [run, setRun] = useState<Run | null>(null);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (runId === undefined) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([getRun(runId), getRunEvidence(runId)])
      .then(([runResult, eventsResult]) => {
        if (cancelled) {
          return;
        }
        setRun(runResult);
        setEvents(eventsResult);
      })
      .catch((err: unknown) => {
        if (cancelled) {
          return;
        }
        if (err instanceof UnauthorizedError) {
          markUnauthenticated();
          return;
        }
        setError(err instanceof Error ? err.message : "failed to load run");
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [runId, markUnauthenticated]);

  return (
    <main>
      <p>
        <Link to="/runs">&larr; Back to runs</Link>
      </p>
      {loading && <p>Loading…</p>}
      {error !== null && <p role="alert">{error}</p>}
      {!loading && error === null && run !== null && (
        <>
          <h1>Run {run.runId}</h1>
          <dl>
            <dt>Task</dt>
            <dd>{run.taskId}</dd>
            <dt>Status</dt>
            <dd>{run.status}</dd>
            <dt>Provider</dt>
            <dd>{run.provider}</dd>
            <dt>Started</dt>
            <dd>{run.startedAt}</dd>
            <dt>Ended</dt>
            <dd>{run.endedAt ?? "—"}</dd>
            {run.failureNote !== null && (
              <>
                <dt>Failure</dt>
                <dd>{run.failureNote}</dd>
              </>
            )}
          </dl>
          <h2>Audit trail</h2>
          <table>
            <thead>
              <tr>
                <th>At</th>
                <th>Actor</th>
                <th>Event</th>
                <th>Capability</th>
                <th>Tier</th>
                <th>Evidence</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.eventId}>
                  <td>{event.at}</td>
                  <td>{event.actor}</td>
                  <td>{event.eventType}</td>
                  <td>{event.capability ?? "—"}</td>
                  <td>{event.tier ?? "—"}</td>
                  <td>
                    {event.evidenceUri !== null ? (
                      <a href={event.evidenceUri} target="_blank" rel="noreferrer">
                        link
                      </a>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {events.length === 0 && <p>No audit events for this run.</p>}
        </>
      )}
    </main>
  );
}
