import { useEffect, useState } from "react";

import {
  grantRoleTool,
  listRoleTools,
  revokeRoleTool,
  type RoleTool,
  type RoleToolCatalog,
} from "../../lib/api";

export interface BotToolsPanelProps {
  roleId: string;
}

/** Connector capability controls; the server remains the grant authority. */
export function BotToolsPanel({ roleId }: BotToolsPanelProps) {
  const [catalog, setCatalog] = useState<RoleToolCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savingToolId, setSavingToolId] = useState<string | null>(null);

  const load = async () => {
    try {
      const nextCatalog = await listRoleTools(roleId);
      setCatalog(nextCatalog);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load connectors and tools.");
    }
  };

  useEffect(() => {
    void load();
  }, [roleId]);

  const setGranted = async (tool: RoleTool, granted: boolean) => {
    if (!tool.grantable || savingToolId !== null) return;
    setSavingToolId(tool.id);
    try {
      if (granted) {
        await grantRoleTool(roleId, tool);
      } else {
        await revokeRoleTool(roleId, tool.id);
      }
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update this tool.");
    } finally {
      setSavingToolId(null);
    }
  };

  if (error !== null) return <p role="alert" className="text-xs text-red-400">{error}</p>;
  if (catalog === null) return <p className="text-xs text-slate-500">Loading connectors and tools…</p>;
  if (catalog.systems.length === 0) return <p className="text-xs text-slate-500">No connectors or tools are available yet.</p>;

  return (
    <section aria-labelledby="connectors-tools-heading" className="space-y-4">
      <div>
        <h2 id="connectors-tools-heading" className="text-sm font-medium text-slate-100">Connectors &amp; tools</h2>
        <p className="text-xs text-slate-500">Choose the tools this bot can use.</p>
      </div>
      {catalog.systems.map((system) => (
        <div key={system.id}>
          <div className="mb-1 flex items-center gap-2">
            <h3 className="text-xs font-medium uppercase text-slate-500">{system.label}</h3>
            {(system as { configured?: unknown }).configured === false ? (
              <span data-testid={`tool-system-not-configured-${system.id}`} className="rounded bg-slate-700 px-1.5 py-0.5 text-[10px] uppercase text-slate-300">Not configured</span>
            ) : null}
          </div>
          <ul className="space-y-2">
            {system.tools.map((tool) => (
              <li key={tool.id} className="rounded-lg bg-surface-raised p-2">
                <div className="flex items-center gap-2">
                  <label className="flex min-w-0 flex-1 items-center gap-2 text-sm text-slate-200">
                    <input
                      type="checkbox"
                      role="switch"
                      aria-label={tool.label}
                      checked={tool.granted}
                      disabled={(system as { configured?: unknown }).configured === false || !tool.grantable || savingToolId === tool.id}
                      onChange={(event) => void setGranted(tool, event.currentTarget.checked)}
                    />
                    <span>{tool.label}</span>
                  </label>
                  {!tool.grantable ? <span className="text-[10px] uppercase text-slate-500">Locked</span> : null}
                </div>
                <p className="mt-1 text-xs text-slate-500">{tool.description}</p>
                {(system as { configured?: unknown }).configured === false ? <p className="mt-1 text-xs text-slate-500">Ask the workspace owner to configure this connector</p> : null}
                {!tool.grantable ? <p className="mt-1 text-xs text-slate-500">Locked — this tool cannot be changed here.</p> : null}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
