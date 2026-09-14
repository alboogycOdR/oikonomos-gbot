// TASK-243 (spec §7.1/§7.2) — the workspace's "Results" segment: renders
// `GET /runs/:id/receipt` (TASK-242) for the workspace's latest *completed*
// run, distinguishing three sections per the spec's own wording:
//   - "Completed action" — the run's final bot message plus the audit
//     actions actually taken (capability/tier/verdict/reason).
//   - "Prepared draft" — approvals that were rendered and have already
//     been resolved one way or another (granted/rejected/expired/
//     invalidated/consumed) — something the bot prepared and which is no
//     longer awaiting a decision.
//   - "Proposed next action" — `unresolvedApprovals` (status `pending`):
//     an action the bot has proposed and that still needs a decision.
// This three-way split is not a separate field the receipt API returns
// (TASK-242's `RunReceipt` has only `approvals`/`unresolvedApprovals`); it
// is derived here from the `ApprovalStatus` values already defined in
// `lib/api.ts`, which is the closest unambiguous signal the API exposes —
// see dossiers/TASK-243.md for the reasoning.
import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";

import {
  getRunReceipt,
  UnauthorizedError,
  type RunReceipt,
  type RunReceiptApproval,
} from "../../lib/api";

export interface ResultsViewProps {
  /** The workspace's latest run id, only when its status is `completed` — `undefined` otherwise (spec: "latest completed run"). */
  completedRunId: string | undefined;
  onUnauthorized: () => void;
}

function formatSpend(spend: RunReceipt["spend"]): string {
  if (spend.kind === "unavailable") return "unavailable";
  const tokens = spend.tokens === null ? "" : ` · ${spend.tokens} tokens`;
  return `$${spend.costUsd.toFixed(4)}${tokens}`;
}

function ApprovalRow({
  approval,
  children,
}: {
  approval: RunReceiptApproval;
  children?: ReactNode;
}) {
  return (
    <li className="rounded-lg bg-surface-raised p-2">
      <p className="text-sm text-slate-200">{approval.actionRender}</p>
      <p className="text-[10px] uppercase text-slate-500">
        {approval.capabilityId} · {approval.destination} · {approval.status}
      </p>
      {children}
    </li>
  );
}

export function ResultsView({ completedRunId, onUnauthorized }: ResultsViewProps) {
  const [receipt, setReceipt] = useState<RunReceipt | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (completedRunId === undefined) {
      setReceipt(null);
      setError(null);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    getRunReceipt(completedRunId)
      .then((data) => {
        if (!cancelled) setReceipt(data);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        setError(err instanceof Error ? err.message : "failed to load receipt");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [completedRunId, onUnauthorized]);

  if (completedRunId === undefined) {
    return (
      <section aria-label="Results" className="flex-1 overflow-y-auto p-4">
        <p className="text-sm text-slate-500">No completed run yet.</p>
      </section>
    );
  }

  if (loading) {
    return (
      <section aria-label="Results" className="flex-1 overflow-y-auto p-4">
        <p className="text-sm text-slate-400">Loading receipt…</p>
      </section>
    );
  }

  if (error !== null) {
    return (
      <section aria-label="Results" className="flex-1 overflow-y-auto p-4">
        <p role="alert" className="text-sm text-red-400">
          {error}
        </p>
      </section>
    );
  }

  if (receipt === null) {
    return null;
  }

  const resolvedApprovals = receipt.approvals.filter((approval) => approval.status !== "pending");

  return (
    <section aria-label="Results" className="flex-1 overflow-y-auto p-4">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-100">Receipt — run {receipt.run.runId}</h2>
        <div className="flex gap-3 text-xs">
          <Link className="text-bubble-user hover:underline" to={`/ops/runs/${encodeURIComponent(receipt.run.runId)}`}>
            Run detail
          </Link>
          <Link
            className="text-bubble-user hover:underline"
            to={`/ops/evidence/${encodeURIComponent(receipt.run.runId)}`}
          >
            Evidence
          </Link>
        </div>
      </div>

      <p className="mb-4 text-xs text-slate-500">
        Status: {receipt.run.status} · Spend: {formatSpend(receipt.spend)}
      </p>

      <div className="mb-4">
        <p className="mb-2 text-[10px] font-medium uppercase text-slate-500">Completed action</p>
        {receipt.finalMessage !== null ? (
          <p className="mb-2 rounded-lg bg-surface-raised p-2 text-sm text-slate-200">
            {receipt.finalMessage.body}
          </p>
        ) : (
          <p className="mb-2 text-xs text-slate-500">No final message recorded.</p>
        )}
        <ul aria-label="Actions taken" className="space-y-2">
          {receipt.actions.map((action, index) => (
            <li key={`${action.capability ?? "unknown"}-${index}`} className="rounded-lg bg-surface-raised p-2">
              <span className="text-sm text-slate-200">{action.capability ?? "unknown capability"}</span>{" "}
              <span className="text-[10px] uppercase text-slate-500">
                {action.tier ?? "no tier"} · {action.verdict ?? "no verdict"}
              </span>
              {action.reason !== null ? (
                <p className="text-xs text-slate-500">{action.reason}</p>
              ) : null}
            </li>
          ))}
          {receipt.actions.length === 0 ? (
            <li className="text-xs text-slate-500">No audited actions.</li>
          ) : null}
        </ul>
      </div>

      <div className="mb-4">
        <p className="mb-2 text-[10px] font-medium uppercase text-slate-500">Prepared draft</p>
        <ul aria-label="Prepared drafts" className="space-y-2">
          {resolvedApprovals.map((approval) => (
            <ApprovalRow key={approval.approvalId} approval={approval} />
          ))}
          {resolvedApprovals.length === 0 ? (
            <li className="text-xs text-slate-500">No prepared drafts.</li>
          ) : null}
        </ul>
      </div>

      <div>
        <p className="mb-2 text-[10px] font-medium uppercase text-slate-500">Proposed next action</p>
        <ul aria-label="Unresolved approvals" className="space-y-2">
          {receipt.unresolvedApprovals.map((approval) => (
            <ApprovalRow key={approval.approvalId} approval={approval}>
              <Link className="text-xs text-bubble-user hover:underline" to="/ops/approvals">
                Decide in Approvals
              </Link>
            </ApprovalRow>
          ))}
          {receipt.unresolvedApprovals.length === 0 ? (
            <li className="text-xs text-slate-500">Nothing proposed.</li>
          ) : null}
        </ul>
      </div>
    </section>
  );
}
