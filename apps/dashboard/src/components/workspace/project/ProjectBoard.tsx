import { useEffect, useMemo, useState } from "react";

import { listProjectTasks, UnauthorizedError, type ProjectTask, type ProjectTaskState } from "../../../lib/api";

const BOARD_STATES: ProjectTaskState[] = ["todo", "doing", "review", "done"];

export interface ProjectBoardProps {
  projectId: string;
  projectName: string;
  onUnauthorized: () => void;
}

function TaskCard({ task }: { task: ProjectTask }) {
  return (
    <li className="rounded-lg bg-surface-raised p-3">
      <p className="text-sm font-medium text-slate-100">{task.title}</p>
      {task.description.length > 0 ? <p className="mt-1 text-xs text-slate-400">{task.description}</p> : null}
      {task.ownerRoleId !== null ? <p className="mt-2 text-[10px] uppercase text-slate-500">Owner: {task.ownerRoleId}</p> : null}
    </li>
  );
}

/** Spec §9.2 project-thread Work view. Blocked work is deliberately separate from board columns. */
export function ProjectBoard({ projectId, projectName, onUnauthorized }: ProjectBoardProps) {
  const [tasks, setTasks] = useState<ProjectTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listProjectTasks(projectId)
      .then((items) => {
        if (!cancelled) setTasks(items);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof UnauthorizedError) onUnauthorized();
        else setError(err instanceof Error ? err.message : "failed to load project board");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, onUnauthorized]);

  const blocked = useMemo(() => tasks.filter((task) => task.state === "blocked"), [tasks]);

  return (
    <section aria-label="Work" className="flex-1 overflow-y-auto p-4">
      <h2 className="mb-1 text-sm font-semibold text-slate-100">{projectName} board</h2>
      <p className="mb-4 text-xs text-slate-500">Project work items</p>
      {loading ? <p className="text-sm text-slate-400">Loading project board…</p> : null}
      {error !== null ? <p role="alert" className="text-sm text-red-400">{error}</p> : null}
      {!loading && error === null ? (
        <>
          <section aria-label="Attention inbox" className="mb-5 rounded-lg border border-amber-700/50 bg-amber-950/20 p-3">
            <h3 className="text-xs font-medium uppercase text-amber-300">Attention inbox</h3>
            <ul aria-label="Blocked items" className="mt-2 space-y-2">
              {blocked.map((task) => (
                <li key={task.taskId} className="text-sm text-slate-200">
                  <span className="font-medium">{task.title}</span>
                  <p className="text-xs text-amber-200">{task.blockedReason}</p>
                </li>
              ))}
              {blocked.length === 0 ? <li className="text-xs text-slate-500">No blocked items.</li> : null}
            </ul>
          </section>
          <div className="grid gap-4 lg:grid-cols-4">
            {BOARD_STATES.map((state) => {
              const items = tasks.filter((task) => task.state === state);
              return (
                <section key={state} aria-label={`${state} tasks`}>
                  <h3 className="mb-2 text-[10px] font-medium uppercase text-slate-500">{state}</h3>
                  <ul className="space-y-2">
                    {items.map((task) => <TaskCard key={task.taskId} task={task} />)}
                    {items.length === 0 ? <li className="text-xs text-slate-500">None.</li> : null}
                  </ul>
                </section>
              );
            })}
          </div>
        </>
      ) : null}
    </section>
  );
}
