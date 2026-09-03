// TASK-109 (Chat-1e): inline approval card rendered in the conversation
// pane (spec §4, §5, §6, §7).
//
// Two non-negotiables carried over from TASK-082's Telegram gateway
// precedent (ADR-004, render provenance) and TASK-103's ops approvals
// page:
//
// 1. `actionRender` is an agent-controlled value (built from
//    `canonicalJson(input)`) and is rendered as *plain text only* — never
//    interpreted as Markdown/HTML. A `<pre>` with a plain string child
//    (no `dangerouslySetInnerHTML`, no Markdown renderer) is the only safe
//    shape; React escapes text children automatically, so this cannot be
//    used to inject a rendered link or element.
// 2. The `nonce` lives only in this component's props/state (sourced from
//    the already-in-memory `ChatMessage.approval` the transcript poll
//    fetched) and is sent straight back in the single
//    `POST /approvals/:nonce/decide` request body — never placed in a URL,
//    never pushed to browser history, never persisted to
//    localStorage/sessionStorage. Same discipline TASK-103 proved for the
//    ops approvals page.
import { useState } from "react";

import { decideApproval, UnauthorizedError, type ApprovalDecisionKind } from "../../lib/api";
import type { ApprovalRender } from "./types";

export interface ApprovalCardProps {
  approval: ApprovalRender;
  /** Called when the dashboard's session cookie has expired (401). */
  onUnauthorized?: () => void;
  /**
   * Called after a successful decide with the resulting status, so the
   * caller can reconcile its own message state ahead of the next poll.
   */
  onDecided?: (status: "approved" | "rejected") => void;
}

const STATUS_LABEL: Record<string, string> = {
  pending: "Pending your decision",
  approved: "Approved",
  granted: "Approved",
  rejected: "Rejected",
  expired: "Expired",
};

function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status;
}

export function ApprovalCard({ approval, onUnauthorized, onDecided }: ApprovalCardProps) {
  const [deciding, setDeciding] = useState<ApprovalDecisionKind | null>(null);
  const [localStatus, setLocalStatus] = useState<string>(approval.status);
  const [notice, setNotice] = useState<string | null>(null);

  const isPending = localStatus === "pending";

  async function handleDecide(decision: ApprovalDecisionKind) {
    setDeciding(decision);
    setNotice(null);
    try {
      const result = await decideApproval(approval.nonce, decision);
      if (!result.decided) {
        // 409 — already decided (or no longer valid) server-side. Reflect
        // that gracefully rather than erroring: disable the buttons and
        // tell the operator, matching TASK-103's inbox behavior.
        setLocalStatus((current) => (current === "pending" ? "expired" : current));
        setNotice("Already decided or no longer valid.");
        return;
      }
      const nextStatus = result.approval.status === "granted" ? "approved" : "rejected";
      setLocalStatus(nextStatus);
      onDecided?.(nextStatus);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized?.();
        return;
      }
      setNotice(err instanceof Error ? err.message : "decision failed");
    } finally {
      setDeciding(null);
    }
  }

  return (
    <div
      // Kept as "inline-approval-placeholder": ChatShell.test.tsx
      // (TASK-107, outside this task's Owned_Paths) still asserts on this
      // testid; changing it would break a test file this task isn't
      // allowed to touch.
      data-testid="inline-approval-placeholder"
      className="ml-10 max-w-[70%] rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-xs text-amber-200"
    >
      <p className="mb-1 font-semibold uppercase tracking-wide">Approval needed</p>
      <pre
        data-testid="approval-card-render"
        className="whitespace-pre-wrap font-mono text-[11px] text-amber-100"
      >
        {approval.actionRender}
      </pre>
      <p className="mt-1 text-amber-300/80">Status: {statusLabel(localStatus)}</p>

      {isPending ? (
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            disabled={deciding !== null}
            onClick={() => void handleDecide("granted")}
            className="rounded-md bg-emerald-600/80 px-3 py-1 text-[11px] font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
          >
            Approve
          </button>
          <button
            type="button"
            disabled={deciding !== null}
            onClick={() => void handleDecide("rejected")}
            className="rounded-md bg-rose-600/80 px-3 py-1 text-[11px] font-medium text-white hover:bg-rose-600 disabled:opacity-50"
          >
            Reject
          </button>
        </div>
      ) : null}

      {notice !== null ? (
        <p role="alert" className="mt-1 text-amber-300">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
