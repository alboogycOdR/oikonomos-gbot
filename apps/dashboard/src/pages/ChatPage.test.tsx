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

/** Encodes a raw SSE frame for a single message, matching the wire shape control-api's `/threads/:id/stream` sends. */
function sseFrame(message: { id: string }): string {
  return `id: ${message.id}\ndata: ${JSON.stringify(message)}\n\n`;
}

/** A `Response`-shaped SSE stream that stays open until the test closes it. */
function openStreamResponse(): { response: Response; push: (message: { id: string }) => void; close: () => void } {
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
    },
  });
  return {
    response: new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    push: (message) => controllerRef?.enqueue(encoder.encode(sseFrame(message))),
    close: () => controllerRef?.close(),
  };
}

/**
 * TASK-108 AC coverage:
 *  - `/` shows real threads from `GET /threads` (not fixture data).
 *  - sending a message calls `POST /threads/:id/messages` and the reply
 *    appears once pushed over the SSE stream, without a page reload
 *    (TASK-129, RT-01 — replaces the old 2s poll loop).
 *  - switching threads/unmounting closes the previous stream's
 *    connection — no leaked connection (TASK-129 AC2, mirrors this
 *    codebase's old `clearIntervalSpy` cleanup-test discipline, now
 *    asserted via an `AbortController.prototype.abort` spy since the new
 *    mechanism is a held-open stream, not an interval).
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
      if (url.includes("/threads/thread-1/stream")) {
        return new Response(new ReadableStream({ start() {} }), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
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
      if (url.includes("/threads/thread-1/stream")) {
        return new Response(new ReadableStream({ start() {} }), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
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
      if (url.endsWith("/roles/role-1/grants") && init?.method === "POST") {
        return new Response(JSON.stringify({}), { status: 201 });
      }
      if (url.endsWith("/roles/role-1/grants")) {
        // RightPanel (TASK-124: activeRoleId now reaches it) GETs this
        // same URL on mount to populate the Permissions section.
        return new Response(JSON.stringify([]), { status: 200 });
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

  it("sends a message via POST /threads/:id/messages and shows the bot's reply the moment it's pushed over the stream, without polling", async () => {
    const stream = openStreamResponse();
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
      if (url.includes("/threads/thread-1/stream")) {
        return stream.response;
      }
      if (url.includes("/threads/thread-1/messages") && init?.method === "POST") {
        return new Response(JSON.stringify(USER_MESSAGE), { status: 201 });
      }
      if (url.includes("/threads/thread-1/messages")) {
        // Initial load only — the bot's reply arrives over the stream,
        // never via a re-fetch of this endpoint (that would be the old
        // poll loop this task removes).
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const user = userEvent.setup({ delay: null });
    renderPage();

    await waitFor(() => expect(screen.getAllByText("Research Assistant").length).toBeGreaterThan(0));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/threads/thread-1/stream"), expect.anything()),
    );

    const composeBox = await screen.findByLabelText("Message");
    await user.type(composeBox, "hi there");
    await user.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/threads/thread-1/messages"),
        expect.objectContaining({ method: "POST" }),
      ),
    );

    // No polling: the reply appears only because it's pushed on the
    // already-open stream, not because of any further GET.
    const messagesGetCallsBeforePush = fetchMock.mock.calls.filter(
      ([reqInput, reqInit]) =>
        String(reqInput).includes("/threads/thread-1/messages") && (reqInit as RequestInit | undefined)?.method !== "POST",
    ).length;
    stream.push(BOT_REPLY);

    await waitFor(() => expect(screen.getByText("hello back")).toBeInTheDocument());
    const messagesGetCallsAfterPush = fetchMock.mock.calls.filter(
      ([reqInput, reqInit]) =>
        String(reqInput).includes("/threads/thread-1/messages") && (reqInit as RequestInit | undefined)?.method !== "POST",
    ).length;
    expect(messagesGetCallsAfterPush).toBe(messagesGetCallsBeforePush);

    stream.close();
  });

  it("closes the stream's connection when the component unmounts — no leaked connection", async () => {
    const abortSpy = vi.spyOn(AbortController.prototype, "abort");
    const stream = openStreamResponse();
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
      if (url.includes("/threads/thread-1/stream")) {
        return stream.response;
      }
      if (url.includes("/threads/thread-1/stream")) {
        return new Response(new ReadableStream({ start() {} }), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (url.includes("/threads/thread-1/messages")) {
        return new Response(JSON.stringify([USER_MESSAGE]), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    }) as unknown as typeof fetch;

    const { unmount } = renderPage();
    await waitFor(() => expect(screen.getAllByText("Research Assistant").length).toBeGreaterThan(0));
    expect(abortSpy).not.toHaveBeenCalled();

    unmount();
    await waitFor(() => expect(abortSpy).toHaveBeenCalled());
    stream.close();
  });

  // TASK-124 (Grants-1e): activeRoleId must reach RightPanel through the
  // real ChatPage -> ChatShell tree (not just when handed to RightPanel
  // directly), otherwise TASK-119's permissions view is dead code in the
  // live app.
  it("threads the active thread's roleId into RightPanel so the permissions view shows real grants", async () => {
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
      if (url.includes("/threads/thread-1/stream")) {
        return new Response(new ReadableStream({ start() {} }), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (url.includes("/threads/thread-1/messages")) {
        return new Response(JSON.stringify([USER_MESSAGE]), { status: 200 });
      }
      if (url.endsWith("/roles/role-1/grants")) {
        return new Response(
          JSON.stringify([{ capabilityId: "email.send", maxTier: "T3_external" }]),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    }) as unknown as typeof fetch;

    renderPage();

    expect(await screen.findByLabelText("Permissions")).toBeInTheDocument();
    expect(await screen.findByText("email.send")).toBeInTheDocument();
  });

  it("loads the active bot's real routines into the Routines tab through ChatPage", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/auth/login")) return new Response(JSON.stringify({ authenticated: true }), { status: 200 });
      if (url.endsWith("/roles")) return new Response(JSON.stringify([]), { status: 200 });
      if (url.endsWith("/threads")) return new Response(JSON.stringify([THREAD]), { status: 200 });
      if (url.endsWith("/roles/role-1/routines")) {
        return new Response(JSON.stringify([{ routineId: "routine-1", name: "Daily briefing", schedule: "0 8 * * *" }]), { status: 200 });
      }
      if (url.endsWith("/roles/role-1/grants")) return new Response(JSON.stringify([]), { status: 200 });
      if (url.includes("/threads/thread-1/stream")) {
        return new Response(new ReadableStream({ start() {} }), { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      if (url.includes("/threads/thread-1/messages")) return new Response(JSON.stringify([]), { status: 200 });
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    }) as unknown as typeof fetch;

    const user = userEvent.setup({ delay: null });
    renderPage();
    await user.click(await screen.findByRole("tab", { name: "Routines" }));
    expect(await screen.findByText("Daily briefing")).toBeInTheDocument();
    expect(screen.getByText("0 8 * * *")).toBeInTheDocument();
  });
});
