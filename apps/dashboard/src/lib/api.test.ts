import { afterEach, describe, expect, it, vi } from "vitest";

import {
  TemplateExportRefusedError,
  exportRoleTemplate,
  installTemplate,
  createReviewRule,
  getAutoReview,
  listProjectArtifacts,
  listProjectTasks,
  listProjects,
  listRoleTools,
  listTemplates,
  removeReviewRule,
  setAutoReview,
} from "./api";

describe("template API client", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("lists templates and sends an encoded export request", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/templates") && (init?.method ?? "GET") === "GET") return new Response(JSON.stringify([]), { status: 200 });
      expect(String(input)).toContain("/roles/role%2Fone/templates");
      expect(init?.method).toBe("POST");
      expect(init?.body).toBe(JSON.stringify({ name: "My template" }));
      return new Response(JSON.stringify({ templateId: "template-1", version: 1, digest: "digest" }), { status: 201 });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(listTemplates()).resolves.toEqual([]);
    await expect(exportRoleTemplate("role/one", "My template")).resolves.toEqual({ templateId: "template-1", version: 1, digest: "digest" });
  });

  it("preserves the 422 field paths and classes rather than genericizing refusal", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ field_paths: ["/identity/instructions"], classes: ["secret_reference"] }), { status: 422 })) as unknown as typeof fetch;

    await expect(exportRoleTemplate("role-1", "Safe name")).rejects.toEqual(
      expect.objectContaining({ name: "TemplateExportRefusedError", fieldPaths: ["/identity/instructions"], classes: ["secret_reference"] }),
    );
  });

  it("installs a specified template version", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toContain("/templates/template-1/install");
      expect(init?.body).toBe(JSON.stringify({ version: 2 }));
      return new Response(JSON.stringify({ role: { roleId: "new-role", name: "New", title: "New", description: "" }, grant_checklist: [], next: "run one supervised turn before enabling routines" }), { status: 201 });
    }) as unknown as typeof fetch;

    await expect(installTemplate("template-1", 2)).resolves.toEqual(expect.objectContaining({ role: { roleId: "new-role", name: "New", title: "New", description: "" } }));
  });

  it("lists project state from the project API with encoded identifiers", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/projects")) return new Response(JSON.stringify([{ projectId: "project-1", threadId: "thread-1" }]), { status: 200 });
      if (url.endsWith("/projects/project%2Fone/tasks")) return new Response(JSON.stringify([]), { status: 200 });
      if (url.endsWith("/projects/project%2Fone/artifacts")) return new Response(JSON.stringify([]), { status: 200 });
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(listProjects()).resolves.toEqual([{ projectId: "project-1", threadId: "thread-1" }]);
    await expect(listProjectTasks("project/one")).resolves.toEqual([]);
    await expect(listProjectArtifacts("project/one")).resolves.toEqual([]);
  });

  it("uses the server's auto-review, rule, and tool catalog contracts", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/auto-review") && (init?.method ?? "GET") === "GET") return new Response(JSON.stringify({ enabled: false, rules: [] }), { status: 200 });
      if (url.endsWith("/auto-review")) return new Response(JSON.stringify({ enabled: true, rules: [] }), { status: 200 });
      if (url.endsWith("/tools")) return new Response(JSON.stringify({ systems: [] }), { status: 200 });
      if (url.endsWith("/review-rules") && init?.method === "POST") return new Response(JSON.stringify({ ruleId: "rule-1", capabilityId: "email.send", enabled: true }), { status: 201 });
      if (url.endsWith("/review-rules/rule%2Fone")) return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    }) as unknown as typeof fetch;

    await expect(getAutoReview("role/one")).resolves.toEqual({ enabled: false, rules: [] });
    await expect(setAutoReview("role/one", true)).resolves.toEqual({ enabled: true, rules: [] });
    await expect(listRoleTools("role/one")).resolves.toEqual({ systems: [] });
    await expect(createReviewRule("role/one", "email.send")).resolves.toMatchObject({ ruleId: "rule-1" });
    await expect(removeReviewRule("role/one", "rule/one")).resolves.toBeUndefined();
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("/roles/role%2Fone/auto-review"), expect.objectContaining({ method: "PUT", body: JSON.stringify({ enabled: true }) }));
  });
});
