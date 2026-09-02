import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthProvider } from "../lib/AuthContext";
import { EvidenceBrowserPage } from "./EvidenceBrowserPage";

/**
 * TASK-104 AC: "Given any run_id, the audit browser reconstructs its full
 * decision trail (every policy.decision event, verdict, reason where
 * present) — no direct DB access, everything through
 * `GET /runs/:id/evidence`."
 */
describe("EvidenceBrowserPage", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/runs/run-42")) {
        return new Response(
          JSON.stringify({
            runId: "run-42",
            taskId: "task-9",
            tenantId: "basileia",
            provider: "claude",
            sessionRef: null,
            status: "completed",
            startedAt: "2026-09-02T10:00:00.000Z",
            endedAt: "2026-09-02T10:05:00.000Z",
            failureNote: null,
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/runs/run-42/evidence")) {
        return new Response(
          JSON.stringify([
            {
              eventId: "evt-1",
              tenantId: "basileia",
              runId: "run-42",
              at: "2026-09-02T10:01:00.000Z",
              actor: "policy-engine",
              eventType: "policy.decision",
              capability: "gmail.send",
              tier: "1",
              payload: { verdict: "denied", reason: "capability not granted" },
              evidenceUri: null,
            },
          ]),
          { status: 200 },
        );
      }
      if (url.endsWith("/runs/missing-run") || url.endsWith("/runs/missing-run/evidence")) {
        return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      }
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("looks up a run_id typed directly into the form and reconstructs its decision trail", async () => {
    const user = userEvent.setup();
    render(
      <AuthProvider>
        <MemoryRouter initialEntries={["/evidence"]}>
          <Routes>
            <Route path="/evidence" element={<EvidenceBrowserPage />} />
            <Route path="/evidence/:runId" element={<EvidenceBrowserPage />} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>,
    );

    await user.type(screen.getByLabelText(/run id/i), "run-42");
    await user.click(screen.getByRole("button", { name: /look up/i }));

    await waitFor(() => expect(screen.getByText("Run run-42")).toBeInTheDocument());
    expect(screen.getByText("policy.decision")).toBeInTheDocument();
    expect(screen.getByText("denied")).toBeInTheDocument();
    expect(screen.getByText("capability not granted")).toBeInTheDocument();
    expect(screen.getByText("gmail.send")).toBeInTheDocument();
  });

  it("deep-links directly to /evidence/:runId and loads that run's trail without any prior navigation", async () => {
    render(
      <AuthProvider>
        <MemoryRouter initialEntries={["/evidence/run-42"]}>
          <Routes>
            <Route path="/evidence" element={<EvidenceBrowserPage />} />
            <Route path="/evidence/:runId" element={<EvidenceBrowserPage />} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByText("Run run-42")).toBeInTheDocument());
  });

  it("shows a not-found message rather than a crash for an unknown run_id", async () => {
    render(
      <AuthProvider>
        <MemoryRouter initialEntries={["/evidence/missing-run"]}>
          <Routes>
            <Route path="/evidence" element={<EvidenceBrowserPage />} />
            <Route path="/evidence/:runId" element={<EvidenceBrowserPage />} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
  });
});
