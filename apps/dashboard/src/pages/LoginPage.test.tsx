import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AuthProvider } from "../lib/AuthContext";
import { LoginPage } from "./LoginPage";

/**
 * TASK-239 (spec §3.1) — `LoginPage` is where the "reload with a valid
 * cookie never shows the login screen" behavior actually lives (see
 * `AuthContext.tsx`'s own comment on why the bootstrap check doesn't gate
 * `RequireAuth` directly): once `AuthContext`'s bootstrap `GET /auth/me`
 * check resolves authenticated, this page renders nothing and navigates
 * away instead of ever showing the sign-in form.
 */
function renderLogin(initialPath = "/login") {
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/" element={<p>Workspace</p>} />
          <Route path="/ops/runs" element={<p>Runs</p>} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}

describe("LoginPage", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    cleanup();
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("shows the sign-in form when the bootstrap check finds no valid session", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })) as unknown as typeof fetch;

    renderLogin();

    expect(await screen.findByLabelText(/access token/i)).toBeInTheDocument();
  });

  it("navigates straight to the workspace once the bootstrap check resolves authenticated, without ever showing the form staying put", async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ tenantId: "basileia", kind: "user", expiresAt: "2026-09-13T00:00:00.000Z" }), {
        status: 200,
      }),
    ) as unknown as typeof fetch;

    renderLogin();

    await waitFor(() => expect(screen.getByText("Workspace")).toBeInTheDocument());
    expect(screen.queryByLabelText(/access token/i)).not.toBeInTheDocument();
  });

  it("navigates back to a captured deep link (`from`) once bootstrap resolves authenticated", async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ tenantId: "basileia", kind: "user", expiresAt: "2026-09-13T00:00:00.000Z" }), {
        status: 200,
      }),
    ) as unknown as typeof fetch;

    render(
      <AuthProvider>
        <MemoryRouter
          initialEntries={[{ pathname: "/login", state: { from: { pathname: "/ops/runs", search: "" } } }]}
        >
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/ops/runs" element={<p>Runs</p>} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByText("Runs")).toBeInTheDocument());
  });

  it("signs in via POST /auth/login and navigates to the workspace", async () => {
    const calls: string[] = [];
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/auth/me")) {
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
      }
      if (url.endsWith("/auth/login")) {
        return new Response(JSON.stringify({ authenticated: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    }) as unknown as typeof fetch;

    const user = userEvent.setup({ delay: null });
    renderLogin();

    await user.type(await screen.findByLabelText(/access token/i), "a-token");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => expect(screen.getByText("Workspace")).toBeInTheDocument());
    expect(calls).toContainEqual(expect.stringContaining("/auth/login"));
  });

  it("shows an error and stays on the form when the token is rejected", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/auth/me")) {
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
      }
      if (url.endsWith("/auth/login")) {
        return new Response(JSON.stringify({ error: "invalid token" }), { status: 401 });
      }
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    }) as unknown as typeof fetch;

    const user = userEvent.setup({ delay: null });
    renderLogin();

    await user.type(await screen.findByLabelText(/access token/i), "wrong-token");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/invalid token/i);
    expect(screen.getByLabelText(/access token/i)).toBeInTheDocument();
  });
});
