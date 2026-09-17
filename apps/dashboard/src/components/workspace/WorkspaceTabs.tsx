// TASK-243 (spec §1/§7, D1) — "Two views inside a workspace, switched by a
// segment in the URL". `ChatShell` (Chat-1c, not this task's territory) has
// no notion of these segments, so the switch lives here, rendered by
// `ChatPage` above whichever view is active. Deliberately dumb: it only
// ever calls `onSelect`, navigation itself stays owned by `ChatPage`.
export type WorkspaceView = "chat" | "results" | "work" | "computer";

export interface WorkspaceTabsProps {
  active: WorkspaceView;
  onSelect: (view: WorkspaceView) => void;
}

const TABS: Array<{ id: WorkspaceView; label: string }> = [
  { id: "chat", label: "Chat" },
  { id: "results", label: "Results" },
  { id: "work", label: "Work" },
  { id: "computer", label: "Computer" },
];

export function WorkspaceTabs({ active, onSelect }: WorkspaceTabsProps) {
  return (
    <nav
      role="tablist"
      aria-label="Workspace view"
      className="flex border-b border-chrome-border bg-chrome-panel"
    >
      {TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={active === tab.id}
          onClick={() => onSelect(tab.id)}
          className={`px-4 py-2 text-xs font-medium ${
            active === tab.id
              ? "border-b-2 border-bubble-user text-slate-100"
              : "text-slate-500 hover:text-slate-300"
          }`}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  );
}
