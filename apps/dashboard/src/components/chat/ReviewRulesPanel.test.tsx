import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ReviewRulesPanel } from "./ReviewRulesPanel";

describe("ReviewRulesPanel", () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; vi.restoreAllMocks(); });

  it("lists rules and adds then removes a rule", async () => {
    const user = userEvent.setup();
    let rules = [{ ruleId: "rule-1", capabilityId: "email.send", enabled: true, createdBy: "manual" }];
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/review-rules") && (init?.method ?? "GET") === "GET") return new Response(JSON.stringify(rules), { status: 200 });
      if (url.endsWith("/grants")) return new Response(JSON.stringify([{ roleId: "role-1", capabilityId: "email.send", maxTier: "T2", constraints: {} }, { roleId: "role-1", capabilityId: "calendar.read", maxTier: "T1", constraints: {} }]), { status: 200 });
      if (url.endsWith("/review-rules") && init?.method === "POST") { const rule = { ruleId: "rule-2", capabilityId: "calendar.read", enabled: true, createdBy: "manual" }; rules = [...rules, rule]; return new Response(JSON.stringify(rule), { status: 201 }); }
      if (url.endsWith("/review-rules/rule-1") && init?.method === "DELETE") { rules = rules.filter((rule) => rule.ruleId !== "rule-1"); return new Response(null, { status: 204 }); }
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    }) as unknown as typeof fetch;

    render(<ReviewRulesPanel roleId="role-1" />);
    const rulesList = await screen.findByRole("list", { name: "Review rules" });
    expect(within(rulesList).getByText("email.send")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Capability for review rule"), "calendar.read");
    await user.click(screen.getByRole("button", { name: "Add rule" }));
    await waitFor(() => expect(within(rulesList).getByText("calendar.read")).toBeInTheDocument());
    await user.click(screen.getAllByRole("button", { name: "Remove" })[0]!);
    await waitFor(() => expect(within(rulesList).queryByText("email.send")).not.toBeInTheDocument());
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("/review-rules/rule-1"), expect.objectContaining({ method: "DELETE" }));
  });
});
