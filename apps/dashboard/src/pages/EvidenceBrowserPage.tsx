import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { getRun, getRunEvidence, UnauthorizedError, type AuditEvent, type Run } from "../lib/api";
import { useAuth } from "../lib/AuthContext";

/**
 * TASK-104 AC / OIK-090 — standalone evidence/audit browser: given any
 * run_id (typed in directly, not just reached by clicking through the run
 * list), reconstructs that run's full decision trail — every event's
 * type, verdict, reason (where present), capability, and tier — entirely
 * from `GET /runs/:id/evidence`, no direct DB access. Together with
 * TASK-102's run detail page, this is meant to be sufficient on its own to
 * answer "what did this run do and why," per OIK-090's bar.
 *
 * `verdict` and `reason` aren't top-level `AuditEvent` fields — control-api
 * carries them inside each event's `payload` for policy.decision-shaped
 * events — so they're read defensively from there rather than assumed
 * present on every event type.
 */

function readPayloadString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" ? value : null;
}

export function EvidenceBrowserPage() {
  const params = useParams<{ runId?: string }>();
  const navigate = useNavigate();
  const { markUnauthenticated } = useAuth();

  const [runIdInput, setRunIdInput] = useState(params.runId ?? "");
  const [run, setRun] = useState<Run | null>(null);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchedRunId, setSearchedRunId] = useState<string | null>(null);

  useEffect(() => {
    const runId = params.runId;
    if (runId === undefined || runId.trim().length === 0) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSearchedRunId(runId);
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
        setRun(null);
        setEvents([]);
        setError(err instanceof Error ? err.message : "failed to load run evidence");
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [params.runId, markUnauthenticated]);

  function handleSubmit(evt: React.FormEvent<HTMLFormElement>) {
    evt.preventDefault();
    const trimmed = runIdInput.trim();
    if (trimmed.length === 0) {
      return;
    }
    navigate(`/evidence/${encodeURIComponent(trimmed)}`);
  }

  return (
    <main>
      <h1>Evidence browser</h1>
      <p>Look up a run by ID to reconstruct its full decision trail.</p>
      <form onSubmit={handleSubmit}>
        <label htmlFor="evidence-run-id">Run ID</label>
        <input
          id="evidence-run-id"
          name="runId"
          type="text"
          value={runIdInput}
          onChange={(e) => setRunIdInput(e.target.value)}
          placeholder="run-..."
        />
        <button type="submit">Look up</button>
      </form>

      {loading && <p>Loading…</p>}
      {error !== null && <p role="alert">{error}</p>}
      {!loading && error === null && searchedRunId !== null && run === null && (
        <p>No run found for &ldquo;{searchedRunId}&rdquo;.</p>
      )}

      {!loading && error === null && run !== null && (
        <>
          <h2>Run {run.runId}</h2>
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
          </dl>

          <h3>Decision trail</h3>
          <table>
            <thead>
              <tr>
                <th>At</th>
                <th>Actor</th>
                <th>Event</th>
                <th>Verdict</th>
                <th>Reason</th>
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
                  <td>{readPayloadString(event.payload, "verdict") ?? "—"}</td>
                  <td>{readPayloadString(event.payload, "reason") ?? "—"}</td>
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
