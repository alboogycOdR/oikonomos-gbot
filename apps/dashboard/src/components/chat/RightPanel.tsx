// TASK-107 (Chat-1c): right panel, Members/Routines tabs (spec §5).
// Routines is read-only for v1 (role_routines list); creating routines
// from chat is Chat-2/OIK-135, out of scope here. Static fixture data.
import { useState } from "react";

import type { MemberSummary, RoutineSummary } from "./types";
import { Avatar } from "./Avatar";

type Tab = "members" | "routines";

export interface RightPanelProps {
  members: MemberSummary[];
  routines: RoutineSummary[];
  collapsed?: boolean;
}

export function RightPanel({
  members,
  routines,
  collapsed = false,
}: RightPanelProps) {
  const [tab, setTab] = useState<Tab>("members");

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
