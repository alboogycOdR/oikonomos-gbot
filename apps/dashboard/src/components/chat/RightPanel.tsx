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

import type { MemberSummary, RoutineSummary } from "./types";
import { Avatar } from "./Avatar";

type Tab = "members" | "routines";

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
        ) : (
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
        )}
      </div>
    </aside>
  );
}
