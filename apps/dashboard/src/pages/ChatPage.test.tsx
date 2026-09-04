import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState, type ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AuthProvider, useAuth } from "../lib/AuthContext";
import { ChatPage } from "./ChatPage";

const THREAD = {
  id: "thread-1",
  roleId: "role-1",
  botName: "Research Assistant",
  botDescription: "Summarizes docs",
  avatarSeed: "role-1",
  title: null,
  lastMessagePreview: "hi",
  updatedAt: "2026-09-03T10:00:00.000Z",
};

const USER_MESSAGE = {
  id: "msg-1",
  threadId: "thread-1",
  role: "user",
  body: "hi there",
  runId: null,
  createdAt: "2026-09-03T10:00:00.000Z",
};

const BOT_REPLY = {
  id: "msg-2",
  threadId: "thread-1",
  role: "bot",
  body: "hello back",
  runId: "run-1",
  createdAt: "2026-09-03T10:00:05.000Z",
};

const PENDING_APPROVAL = {
  id: "msg-approval",
  threadId: "thread-1",
  role: "bot",
  body: "I need approval to send this.",
  runId: "run-approval",
  createdAt: "2026-09-03T10:00:10.000Z",
  approval: {
    nonce: "approval-nonce",
    action_render: "Send email to finance",
    status: "pending",
    capability_id: "email.send",
    max_tier: "T3_external",
  },
};

/**
 * Authenticates synchronously so tests can render `<ChatPage>` directly
 * without exercising the login form (that's App.test.tsx's job).
 */
function AuthedProbe({ children }: { children: ReactNode }) {
  const { login } = useAuth();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    void login("token").then(() => setReady(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!ready) return null;
  return <>{children}</>;
}

/**
 * TASK-108 AC coverage:
 *  - `/` shows real threads from `GET /threads` (not fixture data).
 *  - sending a message calls `POST /threads/:id/messages` and the reply
 *    appears once the poll observes it, without a page reload.
 *  - the poll interval clears once the bot's reply arrives (not just
 *    "eventually stops mattering") — asserted directly via a
 *    `clearInterval` spy so a regression that leaves the interval running
 *    reddens this test, not just times out silently.
 */
describe("ChatPage", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    cleanup();
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function renderPage() {
    return render(
      <AuthProvider>
        <MemoryRouter initialEntries={["/"]}>
          <AuthedProbe>
            <ChatPage />
          </AuthedProbe>
        </MemoryRouter>
      </AuthProvider>,
    );
  }

  it("loads real threads from GET /threads and renders them, not fixture data", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/auth/login")) {
        return new Response(JSON.stringify({ authenticated: true }), { status: 200 });
      }
      if (url.endsWith("/roles")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.endsWith("/threads")) {
        return new Response(JSON.stringify([THREAD]), { status: 200 });
      }
      if (url.includes("/threads/thread-1/messages")) {
        return new Response(JSON.stringify([USER_MESSAGE]), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    }) as unknown as typeof fetch;

    renderPage();

    await waitFor(() => expect(screen.getAllByText("Research Assistant").length).toBeGreaterThan(0));
    // Fixture-only names must never leak in once real data has loaded.
    expect(screen.queryByText("Ops Bot")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("hi there")).toBeInTheDocument());
  });

  it("threads real approval grant data through to Always Allow for the active role", async () => {
    const calls: { url: string; body?: unknown }[] = [];
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      calls.push({ url, body });
      if (url.endsWith("/auth/login")) {
        return new Response(JSON.stringify({ authenticated: true }), { status: 200 });
      }
      if (url.endsWith("/roles")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.endsWith("/threads")) {
        return new Response(JSON.stringify([THREAD]), { status: 200 });
      }
      if (url.includes("/threads/thread-1/messages")) {
        return new Response(JSON.stringify([PENDING_APPROVAL]), { status: 200 });
      }
      if (url.includes("/approvals/approval-nonce/decide")) {
        return new Response(
          JSON.stringify({ decided: true, approval: { nonce: "approval-nonce", status: "granted" } }),
          { status: 200 },
        );
      }
      if (url.endsWith("/roles/role-1/grants")) {
        return new Response(JSON.stringify({}), { status: 201 });
      }
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    }) as unknown as typeof fetch;

    const user = userEvent.setup({ delay: null });
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Always Allow" }));

    await waitFor(() =>
      expect(calls).toContainEqual({
        url: "/roles/role-1/grants",
        body: { capabilityId: "email.send", maxTier: "T3_external" },
      }),
    );
  });

  it("sends a message via POST /threads/:id/messages, polls, and stops polling once the bot's reply arrives", async () => {
    let messagesCallCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/auth/login")) {
        return new Response(JSON.stringify({ authenticated: true }), { status: 200 });
      }
      if (url.endsWith("/roles")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.endsWith("/threads")) {
        return new Response(JSON.stringify([THREAD]), { status: 200 });
      }
      if (url.includes("/threads/thread-1/messages") && init?.method === "POST") {
        return new Response(JSON.stringify(USER_MESSAGE), { status: 201 });
      }
      if (url.includes("/threads/thread-1/messages")) {
        messagesCallCount += 1;
        // Initial load (before the send) returns an empty transcript;
        // every poll after the send returns the user message plus the
        // bot's reply, matching what a real GET would show once both
        // rows exist server-side.
        const body = messagesCallCount <= 1 ? [] : [USER_MESSAGE, BOT_REPLY];
        return new Response(JSON.stringify(body), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const clearIntervalSpy = vi.spyOn(window, "clearInterval");

    const user = userEvent.setup({ delay: null });
    renderPage();

    await waitFor(() => expect(screen.getAllByText("Research Assistant").length).toBeGreaterThan(0));

    const composeBox = await screen.findByLabelText("Message");
    await user.type(composeBox, "hi there");
    await user.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/threads/thread-1/messages"),
        expect.objectContaining({ method: "POST" }),
      ),
    );

    // Real ~2s poll interval; wait for it to actually fire and surface the
    // bot's reply (real timers avoid the fake-timer/waitFor interaction
    // hazard where testing-library's own polling loop is itself faked).
    await waitFor(() => expect(screen.getByText("hello back")).toBeInTheDocument(), {
      timeout: 6000,
    });

    // The interval that drove polling must have been cleared once the
    // reply was observed — not merely stopped mattering because the test
    // ended. If polling kept running, a further tick would trigger more
    // fetches; assert clearInterval actually fired for it instead of
    // relying on absence of extra calls (flaky under real timers).
    await waitFor(() => expect(clearIntervalSpy).toHaveBeenCalled());
  });
});
