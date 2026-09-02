import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthProvider } from "../lib/AuthContext";
import { RunDetailPage } from "./RunDetailPage";

/** TASK-102 AC: run detail view shows the real audit trail from GET /runs/:id/evidence. */
describe("RunDetailPage", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/runs/run-1")) {
        return new Response(
          JSON.stringify({
            runId: "run-1",
            taskId: "task-1",
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
      if (url.endsWith("/runs/run-1/evidence")) {
        return new Response(
          JSON.stringify([
            {
              eventId: "evt-1",
              tenantId: "basileia",
              runId: "run-1",
              at: "2026-09-02T10:01:00.000Z",
              actor: "agent",
              eventType: "tool_call",
              capability: "gmail.send",
              tier: "1",
              payload: {},
              evidenceUri: null,
            },
          ]),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("renders the real audit trail for the selected run", async () => {
    render(
      <AuthProvider>
        <MemoryRouter initialEntries={["/runs/run-1"]}>
          <Routes>
            <Route path="/runs/:runId" element={<RunDetailPage />} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByText("Run run-1")).toBeInTheDocument());
    expect(screen.getByText("tool_call")).toBeInTheDocument();
    expect(screen.getByText("gmail.send")).toBeInTheDocument();
  });
});
