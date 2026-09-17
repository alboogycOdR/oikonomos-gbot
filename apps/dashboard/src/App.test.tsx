import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";

/**
 * TASK-102 AC: "an unauthenticated visit to any other route redirects to
 * login" and "Login screen authenticates against TASK-101's POST
 * /auth/login" — both exercised as an integration test through the real
 * routing tree, with `fetch` stubbed to stand in for control-api.
 */
describe("App auth flow", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    cleanup();
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("redirects an unauthenticated visit to /runs to the login screen", () => {
    render(
      <MemoryRouter initialEntries={["/runs"]}>
        <App />
      </MemoryRouter>,
    );

    expect(screen.getByLabelText(/access token/i)).toBeInTheDocument();
  });

  it("keeps the templates library behind the same authentication guard", () => {
    render(
      <MemoryRouter initialEntries={["/templates"]}>
        <App />
      </MemoryRouter>,
    );

    expect(screen.getByLabelText(/access token/i)).toBeInTheDocument();
  });

  /**
   * TASK-243 (spec §2.6, §7) — `/workspace/:threadId/results` and
   * `.../work` are new routes this task adds; they must be guarded by
   * `RequireAuth` exactly like every other workspace route, not
   * accidentally left public.
   */
  it("redirects an unauthenticated visit to /workspace/:threadId/results or /work to the login screen", () => {
    render(
      <MemoryRouter initialEntries={["/workspace/thread-1/results"]}>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByLabelText(/access token/i)).toBeInTheDocument();
    cleanup();

    render(
      <MemoryRouter initialEntries={["/workspace/thread-1/work"]}>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByLabelText(/access token/i)).toBeInTheDocument();
  });

  it("logs in against POST /auth/login and then loads the run list", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/auth/login")) {
        return new Response(JSON.stringify({ authenticated: true }), { status: 200 });
      }
      if (url.includes("/runs")) {
        return new Response(
          JSON.stringify({
            runs: [
              {
                runId: "run-1",
                taskId: "task-1",
                tenantId: "basileia",
                provider: "claude",
                sessionRef: null,
                status: "completed",
                startedAt: "2026-09-02T10:00:00.000Z",
                endedAt: "2026-09-02T10:05:00.000Z",
                failureNote: null,
              },
            ],
            nextCursor: null,
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/runs"]}>
        <App />
      </MemoryRouter>,
    );

    await user.type(screen.getByLabelText(/access token/i), "test-token");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => expect(screen.getByText("run-1")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/auth/login"),
      expect.objectContaining({ method: "POST" }),
    );
  });
});
