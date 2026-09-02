import { useCallback, useEffect, useState } from "react";

import {
  decideApproval,
  listPendingApprovals,
  UnauthorizedError,
  type ApprovalSummary,
} from "../lib/api";
import { useAuth } from "../lib/AuthContext";

/**
 * TASK-103 / E9.1b — approval inbox.
 *
 * `approvals` (including each entry's `nonce`) lives ONLY in this
 * component's React state — never written to the URL (no route param, no
 * query string), never pushed to browser history, never persisted to
 * `localStorage`/`sessionStorage`. Each Approve/Reject handler closes over
 * the approval object already held in state and passes its `nonce`
 * straight into the single `POST /approvals/:nonce/decide` request that
 * consumes it, mirroring the "nonce stays in this process until sent to
 * control-api" discipline documented in
 * `services/gateway-telegram/src/approvals/index.ts`.
 */
export function ApprovalInboxPage() {
  const { markUnauthenticated } = useAuth();
  const [approvals, setApprovals] = useState<ApprovalSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingNonce, setPendingNonce] = useState<string | null>(null);
  const [notice, setNotice] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await listPendingApprovals();
      setApprovals(result);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        markUnauthenticated();
        return;
      }
      setError(err instanceof Error ? err.message : "failed to load approvals");
    } finally {
      setLoading(false);
    }
  }, [markUnauthenticated]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleDecide(approval: ApprovalSummary, decision: "granted" | "rejected") {
    setPendingNonce(approval.nonce);
    setNotice((prev) => {
      const next = { ...prev };
      delete next[approval.approvalId];
      return next;
    });
    try {
      const result = await decideApproval(approval.nonce, decision);
      if (!result.decided) {
        setNotice((prev) => ({
          ...prev,
          [approval.approvalId]: "Already decided or no longer valid.",
        }));
        await load();
        return;
      }
      setApprovals((prev) => prev.filter((item) => item.approvalId !== approval.approvalId));
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        markUnauthenticated();
        return;
      }
      setNotice((prev) => ({
        ...prev,
        [approval.approvalId]: err instanceof Error ? err.message : "decision failed",
      }));
    } finally {
      setPendingNonce(null);
    }
  }

  return (
    <main>
      <h1>Approvals</h1>
      {loading && <p>Loading…</p>}
      {error !== null && <p role="alert">{error}</p>}
      {!loading && error === null && (
        <>
          {approvals.length === 0 && <p>No pending approvals.</p>}
          <ul>
            {approvals.map((approval) => (
              <li key={approval.approvalId}>
                <pre>{approval.actionRender}</pre>
                <button
                  type="button"
                  disabled={pendingNonce === approval.nonce}
                  onClick={() => void handleDecide(approval, "granted")}
                >
                  Approve
                </button>
                <button
                  type="button"
                  disabled={pendingNonce === approval.nonce}
                  onClick={() => void handleDecide(approval, "rejected")}
                >
                  Reject
                </button>
                {notice[approval.approvalId] !== undefined && (
                  <p role="alert">{notice[approval.approvalId]}</p>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
