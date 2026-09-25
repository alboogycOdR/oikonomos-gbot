// TASK-107 (Chat-1c): right panel, Members/Routines tabs (spec §5).
// Routines is read-only for v1 (role_routines list); creating routines
// from chat is Chat-2/OIK-135, out of scope here. Static fixture data.
//
// TASK-119 (Grants-1c) extends the Members tab with the active bot's
// standing grants (capability + tier) and a revoke button per row,
// against the real `GET/DELETE /roles/:roleId/grants[...]` endpoints.
// `apps/dashboard/src/lib/api.ts` is NOT in this task's Owned_Paths, so
// the fetch calls are made directly here (same `credentials:
// "same-origin"` / `VITE_CONTROL_API_BASE_URL` convention api.ts uses)
// rather than adding helpers to a file this task cannot touch.
//
// `activeRoleId` is optional and nothing in `ChatShell.tsx`/`ChatPage.tsx`
// passes it today (neither file is in this task's Owned_Paths either) —
// the permissions section simply doesn't render without it, the same
// degrade-safely gap pattern TASK-118 left for ApprovalCard's
// roleId/capabilityId/maxTier (see PLAN.md TASK-118). A follow-up task
// threading `activeRoleId` from ChatShell down is needed to make this
// visible in the live app.
import { useEffect, useState } from "react";

import { getAutoReview, setAutoReview } from "../../lib/api";
import { BotToolsPanel } from "./BotToolsPanel";
import { ReviewRulesPanel } from "./ReviewRulesPanel";
import type { MemberSummary, RoutineSummary } from "./types";
import { Avatar } from "./Avatar";

type Tab = "members" | "routines" | "tools";

interface RoleGrantSummary {
  capabilityId: string;
  maxTier: string;
}

const BASE_URL: string =
  (import.meta.env.VITE_CONTROL_API_BASE_URL as string | undefined) ?? "";

export interface RightPanelProps {
  members: MemberSummary[];
  routines: RoutineSummary[];
  collapsed?: boolean;
  /** The active bot's role id — grants are fetched/revoked against this. */
  activeRoleId?: string;
}

export function RightPanel({
  members,
  routines,
  collapsed = false,
  activeRoleId,
}: RightPanelProps) {
  const [tab, setTab] = useState<Tab>("members");
  const [grants, setGrants] = useState<RoleGrantSummary[]>([]);
  const [grantsError, setGrantsError] = useState<string | null>(null);
  const [revokingCapabilityId, setRevokingCapabilityId] = useState<string | null>(null);
  const [autoReviewEnabled, setAutoReviewEnabled] = useState<boolean | null>(null);
  const [autoReviewError, setAutoReviewError] = useState<string | null>(null);
  const [savingAutoReview, setSavingAutoReview] = useState(false);

  useEffect(() => {
    if (activeRoleId === undefined) {
      setGrants([]);
      setGrantsError(null);
      return;
    }
    let cancelled = false;
    fetch(`${BASE_URL}/roles/${encodeURIComponent(activeRoleId)}/grants`, {
      credentials: "same-origin",
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`failed to load grants (${response.status})`);
        }
        return (await response.json()) as RoleGrantSummary[];
      })
      .then((data) => {
        if (!cancelled) {
          setGrants(data);
          setGrantsError(null);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setGrantsError(error instanceof Error ? error.message : "failed to load grants");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeRoleId]);

  useEffect(() => {
    if (tab !== "tools" || activeRoleId === undefined) return;
    let cancelled = false;
    getAutoReview(activeRoleId)
      .then((settings) => {
        if (!cancelled) {
          setAutoReviewEnabled(settings.enabled);
          setAutoReviewError(null);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setAutoReviewError(error instanceof Error ? error.message : "Could not load Auto-review.");
      });
    return () => { cancelled = true; };
  }, [activeRoleId, tab]);

  const handleRevoke = async (capabilityId: string) => {
    if (activeRoleId === undefined) {
      return;
    }
    setRevokingCapabilityId(capabilityId);
    try {
      const response = await fetch(
        `${BASE_URL}/roles/${encodeURIComponent(activeRoleId)}/grants/${encodeURIComponent(capabilityId)}`,
        { method: "DELETE", credentials: "same-origin" },
      );
      if (!response.ok && response.status !== 204) {
        throw new Error(`failed to revoke grant (${response.status})`);
      }
      setGrants((current) => current.filter((grant) => grant.capabilityId !== capabilityId));
      setGrantsError(null);
    } catch (error) {
      setGrantsError(error instanceof Error ? error.message : "failed to revoke grant");
    } finally {
      setRevokingCapabilityId(null);
    }
  };

  const handleAutoReview = async (enabled: boolean) => {
    if (activeRoleId === undefined || savingAutoReview) return;
    const previous = autoReviewEnabled;
    setAutoReviewEnabled(enabled);
    setSavingAutoReview(true);
    try {
      const saved = await setAutoReview(activeRoleId, enabled);
      setAutoReviewEnabled(saved.enabled);
      setAutoReviewError(null);
    } catch (error) {
      setAutoReviewEnabled(previous);
      setAutoReviewError(error instanceof Error ? error.message : "Could not update Auto-review.");
    } finally {
      setSavingAutoReview(false);
    }
  };

  if (collapsed) {
    return (
      <aside
        aria-label="Panel (collapsed)"
        className="w-0 shrink-0 overflow-hidden border-l border-chrome-border bg-chrome-panel transition-all"
      />
    );
  }

  return (
    <aside
      aria-label="Bot details"
      className="flex h-full w-72 shrink-0 flex-col border-l border-chrome-border bg-chrome-panel"
    >
      <div role="tablist" aria-label="Panel tabs" className="flex border-b border-chrome-border">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "members"}
          onClick={() => setTab("members")}
          className={`flex-1 px-3 py-2 text-xs font-medium ${
            tab === "members"
              ? "border-b-2 border-bubble-user text-slate-100"
              : "text-slate-500 hover:text-slate-300"
          }`}
        >
          Members
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "routines"}
          onClick={() => setTab("routines")}
          className={`flex-1 px-3 py-2 text-xs font-medium ${
            tab === "routines"
              ? "border-b-2 border-bubble-user text-slate-100"
              : "text-slate-500 hover:text-slate-300"
          }`}
        >
          Routines
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "tools"}
          onClick={() => setTab("tools")}
          className={`flex-1 px-3 py-2 text-xs font-medium ${
            tab === "tools"
              ? "border-b-2 border-bubble-user text-slate-100"
              : "text-slate-500 hover:text-slate-300"
          }`}
        >
          Tools
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {tab === "members" ? (
          <>
            <ul aria-label="Members" className="space-y-2">
              {members.map((member) => (
                <li key={member.id} className="flex items-center gap-2">
                  <Avatar seed={member.id} name={member.name} size="sm" />
                  <span className="text-sm text-slate-200">{member.name}</span>
                  <span className="ml-auto text-[10px] uppercase text-slate-500">
                    {member.role}
                  </span>
                </li>
              ))}
            </ul>
            {activeRoleId !== undefined ? (
              <div className="mt-4 border-t border-chrome-border pt-3">
                <p className="mb-2 text-[10px] font-medium uppercase text-slate-500">
                  Permissions
                </p>
                {grantsError !== null ? (
                  <p role="alert" className="text-xs text-red-400">
                    {grantsError}
                  </p>
                ) : null}
                <ul aria-label="Permissions" className="space-y-2">
                  {grants.map((grant) => (
                    <li
                      key={grant.capabilityId}
                      className="flex items-center gap-2 rounded-lg bg-surface-raised p-2"
                    >
                      <span className="text-sm text-slate-200">{grant.capabilityId}</span>
                      <span className="text-[10px] uppercase text-slate-500">{grant.maxTier}</span>
                      <button
                        type="button"
                        className="ml-auto text-xs text-red-400 hover:text-red-300 disabled:opacity-50"
                        disabled={revokingCapabilityId === grant.capabilityId}
                        onClick={() => void handleRevoke(grant.capabilityId)}
                      >
                        Revoke
                      </button>
                    </li>
                  ))}
                  {grants.length === 0 && grantsError === null ? (
                    <li className="text-xs text-slate-500">No standing grants.</li>
                  ) : null}
                </ul>
              </div>
            ) : null}
          </>
        ) : tab === "routines" ? (
          <ul aria-label="Routines" className="space-y-3">
            {routines.map((routine) => (
              <li key={routine.id} className="rounded-lg bg-surface-raised p-2">
                <p className="text-sm font-medium text-slate-100">
                  {routine.name}
                </p>
                {routine.description ? (
                  <p className="text-xs text-slate-500">
                    {routine.description}
                  </p>
                ) : null}
              </li>
            ))}
            {routines.length === 0 ? (
              <li className="text-xs text-slate-500">No routines yet.</li>
            ) : null}
          </ul>
        ) : activeRoleId === undefined ? (
          <p className="text-xs text-slate-500">Select a bot to configure its tools.</p>
        ) : (
          <div className="space-y-4">
            <section aria-labelledby="auto-review-heading">
              <div className="flex items-center gap-2">
                <label id="auto-review-heading" className="flex flex-1 items-center gap-2 text-sm font-medium text-slate-100">
                  <input
                    type="checkbox"
                    role="switch"
                    aria-label="Auto-review"
                    checked={autoReviewEnabled ?? false}
                    disabled={autoReviewEnabled === null || savingAutoReview}
                    onChange={(event) => void handleAutoReview(event.currentTarget.checked)}
                  />
                  Auto-review
                </label>
              </div>
              <p className="mt-1 text-xs text-slate-500">Require approval for risky shell, MCP, and computer actions.</p>
              {autoReviewError !== null ? <p role="alert" className="mt-1 text-xs text-red-400">{autoReviewError}</p> : null}
            </section>
            <ReviewRulesPanel roleId={activeRoleId} />
            <BotToolsPanel roleId={activeRoleId} />
          </div>
        )}
      </div>
    </aside>
  );
}
