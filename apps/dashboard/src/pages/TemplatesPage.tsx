import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import {
  exportRoleTemplate,
  installTemplate,
  listRoles,
  listTemplates,
  TemplateExportRefusedError,
  UnauthorizedError,
  type GrantChecklistEntry,
  type Role,
  type TemplateSummary,
} from "../lib/api";
import { useAuth } from "../lib/AuthContext";

export function TemplatesPage() {
  const { markUnauthenticated } = useAuth();
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedRoleId, setSelectedRoleId] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<TemplateExportRefusedError | null>(null);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [installed, setInstalled] = useState<{ roleId: string; checklist: GrantChecklistEntry[] } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextTemplates, nextRoles] = await Promise.all([listTemplates(), listRoles()]);
      setTemplates(nextTemplates);
      setRoles(nextRoles);
      setSelectedRoleId((current) => current || nextRoles[0]?.id || "");
    } catch (caught) {
      if (caught instanceof UnauthorizedError) {
        markUnauthenticated();
        return;
      }
      setError(caught instanceof Error ? caught.message : "failed to load templates");
    } finally {
      setLoading(false);
    }
  }, [markUnauthenticated]);

  useEffect(() => { void load(); }, [load]);

  async function handleExport(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setExportNotice(null);
    setRefusal(null);
    try {
      const result = await exportRoleTemplate(selectedRoleId, templateName);
      setExportNotice(`Template created (version ${result.version}).`);
      setTemplateName("");
      await load();
    } catch (caught) {
      if (caught instanceof UnauthorizedError) { markUnauthenticated(); return; }
      if (caught instanceof TemplateExportRefusedError) { setRefusal(caught); return; }
      setExportNotice(caught instanceof Error ? caught.message : "template export failed");
    }
  }

  async function handleInstall(template: TemplateSummary) {
    setInstallingId(template.templateId);
    setInstallError(null);
    setInstalled(null);
    try {
      const result = await installTemplate(template.templateId, template.version);
      setInstalled({ roleId: result.role.roleId, checklist: result.grant_checklist });
    } catch (caught) {
      if (caught instanceof UnauthorizedError) { markUnauthenticated(); return; }
      setInstallError(caught instanceof Error ? caught.message : "template install failed");
    } finally {
      setInstallingId(null);
    }
  }

  return <main>
    <h1>Templates</h1>
    {loading && <p>Loading templates…</p>}
    {error !== null && <p role="alert">{error}</p>}
    {!loading && error === null && <>
      <section aria-labelledby="export-template-heading">
        <h2 id="export-template-heading">Export a role</h2>
        {roles.length === 0 ? <p>No active roles are available to export.</p> : <form onSubmit={(event) => void handleExport(event)}>
          <label>Role<select aria-label="Role to export" value={selectedRoleId} onChange={(event) => setSelectedRoleId(event.target.value)}>
            {roles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}
          </select></label>
          <label>Template name<input value={templateName} onChange={(event) => setTemplateName(event.target.value)} required /></label>
          <button type="submit">Export template</button>
        </form>}
        {exportNotice !== null && <p role="status">{exportNotice}</p>}
        {refusal !== null && <div role="alert"><p>Remove the secret from the source and try again.</p><p>Field paths: {refusal.fieldPaths.join(", ") || "none reported"}</p><p>Classes: {refusal.classes.join(", ") || "none reported"}</p></div>}
      </section>
      <section aria-labelledby="template-library-heading">
        <h2 id="template-library-heading">Template library</h2>
        {templates.length === 0 ? <p>No templates yet.</p> : <ul>{templates.map((template) => <li key={`${template.templateId}@${template.version}`}>
          <strong>{template.name}</strong> (version {template.version})
          <button type="button" disabled={installingId === template.templateId} onClick={() => void handleInstall(template)}>Install as new role</button>
        </li>)}</ul>}
      </section>
      {installError !== null && <p role="alert">{installError}</p>}
      {installed !== null && <section aria-labelledby="install-result-heading">
        <h2 id="install-result-heading">Installed</h2>
        <p><Link to={`/?roleId=${encodeURIComponent(installed.roleId)}`}>Open the new role</Link></p>
        <h3>Integration grant checklist</h3>
        {installed.checklist.length === 0 ? <p>No manual integration grants are needed.</p> : <ul>{installed.checklist.map((entry) => <li key={entry.capability_id}>{entry.capability_id}: {entry.status} (requested {entry.requested_max_tier})</li>)}</ul>}
      </section>}
    </>}
  </main>;
}
