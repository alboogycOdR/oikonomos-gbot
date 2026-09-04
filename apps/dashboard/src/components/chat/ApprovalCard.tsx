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

import {
  createRoleGrant,
  decideApproval,
  UnauthorizedError,
  type ApprovalDecisionKind,
} from "../../lib/api";
import type { ApprovalRender } from "./types";

/**
 * TASK-118 (Grants-1b) — `capabilityId`/`maxTier` (the grant this
 * approval's capability would need) and `roleId` (the bot the standing
 * grant is scoped to) are ALL required to call `POST /roles/:roleId/
 * grants`, but none of them exist yet on `ApprovalRender`/`BotSummary`
 * (`components/chat/types.ts`) or reach this component through
 * `ConversationPane.tsx` → `ChatPage.tsx`'s message mapping today — none
 * of those three files are in this task's `Owned_Paths`. They're kept
 * optional here so the "Always Allow" action degrades to "hidden"
 * (rather than a broken button) until a follow-up task wires them
 * through; see the TASK-118 dossier's blocked note for the exact three
 * files and the field names (`api.ts`'s `ThreadMessage.approval` already
 * carries `capability_id`/`max_tier` server-side, ready to be threaded
 * through once that follow-up lands).
 */
export interface ApprovalCardProps {
  approval: ApprovalRender & { capabilityId?: string; maxTier?: string };
  /** The bot (role) this approval belongs to — required for "Always Allow". */
  roleId?: string;
  /** Called when the dashboard's session cookie has expired (401). */
  onUnauthorized?: () => void;
  /**
   * Called after a successful decide with the resulting status, so the
   * caller can reconcile its own message state ahead of the next poll.
   */
  onDecided?: (status: "approved" | "rejected") => void;
}

type Deciding = ApprovalDecisionKind | "always_allow" | null;

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

export function ApprovalCard({ approval, roleId, onUnauthorized, onDecided }: ApprovalCardProps) {
  const [deciding, setDeciding] = useState<Deciding>(null);
  const [localStatus, setLocalStatus] = useState<string>(approval.status);
  const [notice, setNotice] = useState<string | null>(null);

  const isPending = localStatus === "pending";
  // Always Allow needs the capability, its tier, and the owning role —
  // hide the button rather than call the grants endpoint with a hole in
  // the payload (see ApprovalCardProps' doc comment for why these are
  // still optional here).
  const canAlwaysAllow =
    roleId !== undefined && approval.capabilityId !== undefined && approval.maxTier !== undefined;

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

  /**
   * TASK-118: "Always Allow" both decides the current approval as
   * granted (reusing `decideApproval`, the exact call "Approve" makes —
   * not duplicated) AND writes a standing grant. The nonce discipline
   * TASK-109 proved (never in URL/history/storage) is unchanged: `nonce`
   * only ever leaves this component's state in the one decide request
   * body, same as every other path here; the grants call carries no
   * nonce at all.
   */
  async function handleAlwaysAllow() {
    if (!canAlwaysAllow || roleId === undefined || approval.capabilityId === undefined || approval.maxTier === undefined) {
      return;
    }
    setDeciding("always_allow");
    setNotice(null);
    try {
      const result = await decideApproval(approval.nonce, "granted");
      if (!result.decided) {
        setLocalStatus((current) => (current === "pending" ? "expired" : current));
        setNotice("Already decided or no longer valid.");
        return;
      }
      await createRoleGrant(roleId, approval.capabilityId, approval.maxTier);
      setLocalStatus("approved");
      onDecided?.("approved");
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized?.();
        return;
      }
      setNotice(err instanceof Error ? err.message : "always-allow failed");
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
          {canAlwaysAllow ? (
            <button
              type="button"
              disabled={deciding !== null}
              onClick={() => void handleAlwaysAllow()}
              className="rounded-md bg-sky-600/80 px-3 py-1 text-[11px] font-medium text-white hover:bg-sky-600 disabled:opacity-50"
            >
              Always Allow
            </button>
          ) : null}
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
