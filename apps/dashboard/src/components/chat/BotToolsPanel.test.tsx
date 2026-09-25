import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { BotToolsPanel } from "./BotToolsPanel";

const catalog = (granted: boolean) => ({
  systems: [{ id: "email", label: "Email", tools: [
    { id: "email.send", label: "Send email", description: "Send a message.", defaultTier: "T2", granted, maxTier: granted ? "T2" : null, grantable: true },
    { id: "system.audit", label: "Audit log", description: "Read audit events.", defaultTier: "T1", granted: true, maxTier: "T1", grantable: false },
  ] }],
});

describe("BotToolsPanel", () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; vi.restoreAllMocks(); });

  it("groups tools, grants and revokes through the server-backed catalog", async () => {
    const user = userEvent.setup();
    let granted = false;
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/tools")) return new Response(JSON.stringify(catalog(granted)), { status: 200 });
      if (init?.method === "POST") { granted = true; return new Response(JSON.stringify({}), { status: 201 }); }
      if (init?.method === "DELETE") { granted = false; return new Response(null, { status: 204 }); }
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    }) as unknown as typeof fetch;

    render(<BotToolsPanel roleId="role/one" />);
    await screen.findByText("Email");
    const toggle = screen.getByRole("switch", { name: "Send email" });
    expect(toggle).not.toBeChecked();
    await user.click(toggle);
    await waitFor(() => expect(toggle).toBeChecked());
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("/roles/role%2Fone/grants"), expect.objectContaining({ method: "POST" }));
    await user.click(toggle);
    await waitFor(() => expect(toggle).not.toBeChecked());
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("/roles/role%2Fone/grants/email.send"), expect.objectContaining({ method: "DELETE" }));
  });

  it("shows locked tools as disabled", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify(catalog(false)), { status: 200 })) as unknown as typeof fetch;
    render(<BotToolsPanel roleId="role-1" />);
    expect(await screen.findByText("Locked — this tool cannot be changed here.")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Audit log" })).toBeDisabled();
  });
});
