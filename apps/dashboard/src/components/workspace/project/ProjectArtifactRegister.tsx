import { useEffect, useState } from "react";

import { listProjectArtifacts, UnauthorizedError, type ProjectArtifact } from "../../../lib/api";

export interface ProjectArtifactRegisterProps {
  projectId: string;
  projectName: string;
  onUnauthorized: () => void;
}

function formatSize(byteSize: number | null): string | null {
  if (byteSize === null) return null;
  return `${byteSize.toLocaleString()} bytes`;
}

/** Spec §9.2 project-thread Results view. The register is server-owned; no filesystem inference occurs here. */
export function ProjectArtifactRegister({ projectId, projectName, onUnauthorized }: ProjectArtifactRegisterProps) {
  const [artifacts, setArtifacts] = useState<ProjectArtifact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listProjectArtifacts(projectId)
      .then((items) => {
        if (!cancelled) setArtifacts(items);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof UnauthorizedError) onUnauthorized();
        else setError(err instanceof Error ? err.message : "failed to load artifact register");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, onUnauthorized]);

  return (
    <section aria-label="Results" className="flex-1 overflow-y-auto p-4">
      <h2 className="mb-1 text-sm font-semibold text-slate-100">{projectName} artifact register</h2>
      <p className="mb-4 text-xs text-slate-500">Registered project outputs</p>
      {loading ? <p className="text-sm text-slate-400">Loading artifact register…</p> : null}
      {error !== null ? <p role="alert" className="text-sm text-red-400">{error}</p> : null}
      {!loading && error === null ? (
        <ul aria-label="Artifact register" className="space-y-2">
          {artifacts.map((artifact) => (
            <li key={artifact.artifactId} className="rounded-lg bg-surface-raised p-3">
              <p className="text-sm font-medium text-slate-100">{artifact.label}</p>
              <p className="mt-1 break-all text-xs text-slate-400">{artifact.ref}</p>
              <p className="mt-2 text-[10px] uppercase text-slate-500">
                {artifact.kind}{formatSize(artifact.byteSize) === null ? "" : ` · ${formatSize(artifact.byteSize)}`}
              </p>
            </li>
          ))}
          {artifacts.length === 0 ? <li className="text-xs text-slate-500">No registered artifacts yet.</li> : null}
        </ul>
      ) : null}
    </section>
  );
}
