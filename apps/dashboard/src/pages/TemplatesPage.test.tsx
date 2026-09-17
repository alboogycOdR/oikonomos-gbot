import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, listTemplates: vi.fn(), listRoles: vi.fn(), exportRoleTemplate: vi.fn(), installTemplate: vi.fn() };
});

import { exportRoleTemplate, installTemplate, listRoles, listTemplates, TemplateExportRefusedError } from "../lib/api";
import { AuthProvider } from "../lib/AuthContext";
import { TemplatesPage } from "./TemplatesPage";

const ROLE = { id: "role-1", name: "Research bot", description: "Finds facts", avatarSeed: "research" };
const TEMPLATE = { templateId: "template-1", version: 2, tenantId: "tenant-1", name: "Researcher", digest: "digest", visibility: "private" as const, createdBy: "tenant:tenant-1", createdAt: "2026-09-17T08:00:00.000Z", manifest: {} };

function renderPage() {
  return render(<AuthProvider><MemoryRouter><TemplatesPage /></MemoryRouter></AuthProvider>);
}

describe("TemplatesPage", () => {
  beforeEach(() => {
    vi.mocked(listRoles).mockResolvedValue([ROLE]);
    vi.mocked(listTemplates).mockResolvedValue([TEMPLATE]);
  });

  afterEach(() => vi.restoreAllMocks());

  it("renders real loading, empty, and error outcomes from template listing", async () => {
    let resolveTemplates!: (templates: typeof TEMPLATE[]) => void;
    vi.mocked(listTemplates).mockReturnValue(new Promise((resolve) => { resolveTemplates = resolve; }));
    renderPage();
    expect(screen.getByText(/loading templates/i)).toBeInTheDocument();
    resolveTemplates([]);
    await waitFor(() => expect(screen.getByText(/no templates yet/i)).toBeInTheDocument());

    vi.restoreAllMocks();
    vi.mocked(listRoles).mockResolvedValue([ROLE]);
    vi.mocked(listTemplates).mockRejectedValue(new Error("templates service unavailable"));
    renderPage();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("templates service unavailable"));
  });

  it("exports the selected role and refreshes the list after a 201", async () => {
    vi.mocked(exportRoleTemplate).mockResolvedValue({ templateId: "template-2", version: 1, digest: "new-digest" });
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Researcher");
    await user.type(screen.getByLabelText(/template name/i), "My research template");
    await user.click(screen.getByRole("button", { name: /export template/i }));

    await waitFor(() => expect(exportRoleTemplate).toHaveBeenCalledWith("role-1", "My research template"));
    expect(screen.getByRole("status")).toHaveTextContent("Template created (version 1)");
  });

  it("shows exact export refusal field paths and classes from the 422 response", async () => {
    vi.mocked(exportRoleTemplate).mockRejectedValue(new TemplateExportRefusedError(["/identity/instructions"], ["secret_reference"]));
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Researcher");
    await user.type(screen.getByLabelText(/template name/i), "Unsafe template");
    await user.click(screen.getByRole("button", { name: /export template/i }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("/identity/instructions"));
    expect(screen.getByRole("alert")).toHaveTextContent("secret_reference");
  });

  it("installs a template and renders its real integration grant checklist", async () => {
    vi.mocked(installTemplate).mockResolvedValue({ role: { roleId: "new-role", name: "New Researcher", title: "New Researcher", description: "" }, grant_checklist: [{ capability_id: "gmail.send", requested_max_tier: "T2_internal", status: "disabled" }], next: "run one supervised turn before enabling routines" });
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Researcher");
    await user.click(screen.getByRole("button", { name: /install as new role/i }));

    await waitFor(() => expect(installTemplate).toHaveBeenCalledWith("template-1", 2));
    expect(screen.getByRole("link", { name: /open the new role/i })).toHaveAttribute("href", "/?roleId=new-role");
    expect(screen.getByText(/gmail\.send: disabled \(requested T2_internal\)/i)).toBeInTheDocument();
  });
});
