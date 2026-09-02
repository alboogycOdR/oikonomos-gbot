import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthProvider } from "../lib/AuthContext";
import { ApprovalInboxPage } from "./ApprovalInboxPage";

const PENDING_APPROVAL = {
  approvalId: "appr-1",
  tenantId: "basileia",
  runId: "run-1",
  capabilityId: "gmail.send",
  actionDigest: "base64digest",
  actionRender: "Send email to alice@example.com: subject \"Q3 report\"",
  destination: "alice@example.com",
  nonce: "nonce-secret-abc",
  status: "pending",
  requestedAt: "2026-09-02T10:00:00.000Z",
  expiresAt: "2026-09-02T10:10:00.000Z",
  decidedBy: null,
  decidedAt: null,
  consumedAt: null,
};

/**
 * TASK-103 AC coverage: real actionRender text verbatim, decide calls the
 * real endpoint and reflects the real result (granted/rejected/409), the
 * nonce never leaks into the URL/history/persisted storage, and a second
 * decide on an already-decided approval is handled gracefully.
 */
describe("ApprovalInboxPage", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();
  });

  function renderPage() {
    return render(
      <AuthProvider>
        <MemoryRouter initialEntries={["/approvals"]}>
          <Routes>
            <Route path="/approvals" element={<ApprovalInboxPage />} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>,
    );
  }

  it("renders the pending approval's actionRender text verbatim from GET /approvals", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify([PENDING_APPROVAL]), { status: 200 })) as unknown as typeof fetch;

    renderPage();

    await waitFor(() =>
      expect(screen.getByText(PENDING_APPROVAL.actionRender)).toBeInTheDocument(),
    );
  });

  it("approves via POST /approvals/:nonce/decide and reflects the granted result", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/approvals") && (init?.method ?? "GET") === "GET") {
        return new Response(JSON.stringify([PENDING_APPROVAL]), { status: 200 });
      }
      if (url.includes("/decide")) {
        expect(url).toContain(encodeURIComponent(PENDING_APPROVAL.nonce));
        const body = JSON.parse(String(init?.body)) as { decision: string; decidedBy: string };
        expect(body.decision).toBe("granted");
        return new Response(
          JSON.stringify({ decided: true, approval: { ...PENDING_APPROVAL, status: "granted" } }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const user = userEvent.setup();
    renderPage();

    await waitFor(() => expect(screen.getByText(PENDING_APPROVAL.actionRender)).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /approve/i }));

    await waitFor(() =>
      expect(screen.queryByText(PENDING_APPROVAL.actionRender)).not.toBeInTheDocument(),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(`/approvals/${encodeURIComponent(PENDING_APPROVAL.nonce)}/decide`),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("rejects via POST /approvals/:nonce/decide with decision=rejected", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/approvals") && (init?.method ?? "GET") === "GET") {
        return new Response(JSON.stringify([PENDING_APPROVAL]), { status: 200 });
      }
      if (url.includes("/decide")) {
        const body = JSON.parse(String(init?.body)) as { decision: string };
        expect(body.decision).toBe("rejected");
        return new Response(
          JSON.stringify({ decided: true, approval: { ...PENDING_APPROVAL, status: "rejected" } }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const user = userEvent.setup();
    renderPage();

    await waitFor(() => expect(screen.getByText(PENDING_APPROVAL.actionRender)).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /reject/i }));

    await waitFor(() =>
      expect(screen.queryByText(PENDING_APPROVAL.actionRender)).not.toBeInTheDocument(),
    );
  });

  it("handles a 409 already-decided response gracefully without crashing", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/approvals") && (init?.method ?? "GET") === "GET") {
        return new Response(JSON.stringify([PENDING_APPROVAL]), { status: 200 });
      }
      if (url.includes("/decide")) {
        return new Response(JSON.stringify({ decided: false }), { status: 409 });
      }
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const user = userEvent.setup();
    renderPage();

    await waitFor(() => expect(screen.getByText(PENDING_APPROVAL.actionRender)).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /approve/i }));

    await waitFor(() =>
      expect(screen.getByText(/already decided or no longer valid/i)).toBeInTheDocument(),
    );
    // page re-loads the pending list after a stale decision; no crash occurred.
    expect(screen.getByText(PENDING_APPROVAL.actionRender)).toBeInTheDocument();
  });

  it("never puts the nonce in the URL bar, history, or persisted client storage", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/approvals") && (init?.method ?? "GET") === "GET") {
        return new Response(JSON.stringify([PENDING_APPROVAL]), { status: 200 });
      }
      if (url.includes("/decide")) {
        return new Response(
          JSON.stringify({ decided: true, approval: { ...PENDING_APPROVAL, status: "granted" } }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const user = userEvent.setup();
    renderPage();

    await waitFor(() => expect(screen.getByText(PENDING_APPROVAL.actionRender)).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /approve/i }));
    await waitFor(() =>
      expect(screen.queryByText(PENDING_APPROVAL.actionRender)).not.toBeInTheDocument(),
    );

    expect(window.location.pathname).toBe("/");
    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain(PENDING_APPROVAL.nonce);
    expect(JSON.stringify(localStorage)).not.toContain(PENDING_APPROVAL.nonce);
    expect(JSON.stringify(sessionStorage)).not.toContain(PENDING_APPROVAL.nonce);
    expect(Object.keys(localStorage)).toHaveLength(0);
    expect(Object.keys(sessionStorage)).toHaveLength(0);
  });
});
