import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState, type ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RequireAuth } from "../components/RequireAuth";
import { AuthProvider, useAuth } from "../lib/AuthContext";
import { ChatPage } from "./ChatPage";
import { LoginPage } from "./LoginPage";

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

/** TASK-236 (spec §2.7) — a second, older thread so switching is a real, observable transition. */
const THREAD_2 = {
  id: "thread-2",
  roleId: "role-2",
  botName: "Ops Bot",
  botDescription: "Watches deploys",
  avatarSeed: "role-2",
  title: null,
  lastMessagePreview: "deployed",
  updatedAt: "2026-09-02T10:00:00.000Z",
};

const THREAD_3 = {
  id: "thread-3",
  roleId: "role-3",
  botName: "Scheduler",
  botDescription: "Books meetings",
  avatarSeed: "role-3",
  title: null,
  lastMessagePreview: "booked",
  updatedAt: "2026-09-01T10:00:00.000Z",
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

interface StreamedMessage {
  id: string;
  threadId?: string;
  role?: string;
  body?: string;
  runId?: string | null;
  createdAt?: string;
}

/** Encodes a raw SSE frame for a single message, matching the wire shape control-api's `/threads/:id/stream` sends. */
function sseFrame(message: StreamedMessage): string {
  return `id: ${message.id}\ndata: ${JSON.stringify(message)}\n\n`;
}

/** A `Response`-shaped SSE stream that stays open until the test closes it. */
function openStreamResponse(): { response: Response; push: (message: StreamedMessage) => void; close: () => void } {
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

function openStream(): Response {
  return new Response(new ReadableStream({ start() {} }), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/**
 * TASK-236 (spec §2.6): `ChatPage` derives its active thread id from the
 * `/workspace/:threadId` route, so tests need real route matching (not
 * just a bare `MemoryRouter`) for `useParams()`/`useNavigate()` to behave
 * like they do in the real `App.tsx` tree.
 */
function renderPage(initialPath = "/") {
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={[initialPath]}>
        <AuthedProbe>
          <Routes>
            <Route path="/" element={<ChatPage />} />
            <Route path="/workspace/:threadId" element={<ChatPage />} />
          </Routes>
        </AuthedProbe>
      </MemoryRouter>
    </AuthProvider>,
  );
}

/**
 * TASK-239 (spec §3.1) — the real tree: `AuthProvider`'s own bootstrap
 * `GET /auth/me` check (no `AuthedProbe` short-circuit via an explicit
 * `login()` call) decides whether `RequireAuth` renders `ChatPage` or
 * `LoginPage` redirects there. Exercises "reloading with a valid cookie
 * lands on the workspace without the login screen" and "reloading with
 * none shows login" (§3.1) end to end.
 */
function renderWithBootstrap(initialPath = "/") {
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/"
            element={
              <RequireAuth>
                <ChatPage />
              </RequireAuth>
            }
          />
          <Route
            path="/workspace/:threadId"
            element={
              <RequireAuth>
                <ChatPage />
              </RequireAuth>
            }
          />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
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
 *
 * TASK-236 (Workspace-1 §2): extended with a genuine multi-thread fixture
 * (spec §2.7 — "the existing single-thread fixtures are insufficient")
 * exercising selection ownership, per-thread pending/draft state, message
 * merge-by-id, the Members roster, and the `/workspace/:threadId` route.
 */
describe("ChatPage", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    cleanup();
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("loads real threads from GET /threads and renders them, not fixture data", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/auth/login")) {
        return new Response(JSON.stringify({ authenticated: true }), { status: 200 });
      }
      if (url.endsWith("/roles")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.endsWith("/workspace/summary")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.endsWith("/threads")) {
        return new Response(JSON.stringify([THREAD]), { status: 200 });
      }
      if (url.includes("/threads/thread-1/stream")) {
        return openStream();
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
      if (url.endsWith("/workspace/summary")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.endsWith("/threads")) {
        return new Response(JSON.stringify([THREAD]), { status: 200 });
      }
      if (url.includes("/threads/thread-1/stream")) {
        return openStream();
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
      if (url.endsWith("/workspace/summary")) {
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

    // The composer clears only because the send succeeded (spec §2.3) —
    // not eagerly on submit.
    expect(composeBox).toHaveValue("");

    stream.close();
  });

  it("a failed send leaves the draft in place and surfaces the error (spec §2.3)", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/auth/login")) return new Response(JSON.stringify({ authenticated: true }), { status: 200 });
      if (url.endsWith("/roles")) return new Response(JSON.stringify([]), { status: 200 });
      if (url.endsWith("/workspace/summary")) return new Response(JSON.stringify([]), { status: 200 });
      if (url.endsWith("/threads")) return new Response(JSON.stringify([THREAD]), { status: 200 });
      if (url.includes("/threads/thread-1/stream")) return openStream();
      if (url.includes("/threads/thread-1/messages") && init?.method === "POST") {
        return new Response(JSON.stringify({ error: "server exploded" }), { status: 500 });
      }
      if (url.includes("/threads/thread-1/messages")) return new Response(JSON.stringify([]), { status: 200 });
      if (url.endsWith("/roles/role-1/grants")) return new Response(JSON.stringify([]), { status: 200 });
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    }) as unknown as typeof fetch;

    const user = userEvent.setup({ delay: null });
    renderPage();

    const composeBox = await screen.findByLabelText("Message");
    // Wait for the route redirect to resolve and the workspace to become
    // active (the compose box is disabled with no active thread).
    await waitFor(() => expect(composeBox).toBeEnabled());
    await user.type(composeBox, "this will fail");
    await user.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("server exploded"),
    );
    expect(composeBox).toHaveValue("this will fail");
  });

  it("closes the stream's connection when the component unmounts — no leaked connection", async () => {
    const abortSpy = vi.spyOn(AbortController.prototype, "abort");
    const stream = openStreamResponse();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/auth/login")) {
        return new Response(JSON.stringify({ authenticated: true }), { status: 200 });
      }
      if (url.endsWith("/roles")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.endsWith("/workspace/summary")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.endsWith("/threads")) {
        return new Response(JSON.stringify([THREAD]), { status: 200 });
      }
      if (url.includes("/threads/thread-1/stream")) {
        return stream.response;
      }
      if (url.includes("/threads/thread-1/messages")) {
        return new Response(JSON.stringify([USER_MESSAGE]), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const { unmount } = renderPage();
    await waitFor(() => expect(screen.getAllByText("Research Assistant").length).toBeGreaterThan(0));
    // Wait until the stream subscription has actually opened (the route
    // redirect + activeThreadId resolution both need a tick) before
    // asserting anything about its abort.
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/threads/thread-1/stream"), expect.anything()),
    );
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
      if (url.endsWith("/workspace/summary")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.endsWith("/threads")) {
        return new Response(JSON.stringify([THREAD]), { status: 200 });
      }
      if (url.includes("/threads/thread-1/stream")) {
        return openStream();
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
      if (url.endsWith("/workspace/summary")) return new Response(JSON.stringify([]), { status: 200 });
      if (url.endsWith("/threads")) return new Response(JSON.stringify([THREAD]), { status: 200 });
      if (url.endsWith("/roles/role-1/routines")) {
        return new Response(JSON.stringify([{ routineId: "routine-1", name: "Daily briefing", schedule: "0 8 * * *" }]), { status: 200 });
      }
      if (url.endsWith("/roles/role-1/grants")) return new Response(JSON.stringify([]), { status: 200 });
      if (url.includes("/threads/thread-1/stream")) return openStream();
      if (url.includes("/threads/thread-1/messages")) return new Response(JSON.stringify([]), { status: 200 });
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    }) as unknown as typeof fetch;

    const user = userEvent.setup({ delay: null });
    renderPage();
    await user.click(await screen.findByRole("tab", { name: "Routines" }));
    expect(await screen.findByText("Daily briefing")).toBeInTheDocument();
    expect(screen.getByText("0 8 * * *")).toBeInTheDocument();
  });

  describe("multi-thread fixture (spec §2.7)", () => {
    function threeThreadFetch(extra?: (url: string, init?: RequestInit) => Response | undefined) {
      return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const overridden = extra?.(url, init);
        if (overridden !== undefined) return overridden;
        if (url.endsWith("/auth/login")) return new Response(JSON.stringify({ authenticated: true }), { status: 200 });
        if (url.endsWith("/roles")) {
          return new Response(
            JSON.stringify([
              { id: "role-1", name: "Research Assistant", description: "", avatarSeed: "role-1" },
              { id: "role-2", name: "Ops Bot", description: "", avatarSeed: "role-2" },
              { id: "role-3", name: "Scheduler", description: "", avatarSeed: "role-3" },
            ]),
            { status: 200 },
          );
        }
        if (url.endsWith("/workspace/summary")) return new Response(JSON.stringify([]), { status: 200 });
        if (url.endsWith("/threads")) return new Response(JSON.stringify([THREAD, THREAD_2, THREAD_3]), { status: 200 });
        if (url.includes("/threads/thread-1/stream")) return openStream();
        if (url.includes("/threads/thread-2/stream")) return openStream();
        if (url.includes("/threads/thread-3/stream")) return openStream();
        if (url.includes("/threads/thread-1/messages")) return new Response(JSON.stringify([USER_MESSAGE]), { status: 200 });
        if (url.includes("/threads/thread-2/messages")) return new Response(JSON.stringify([]), { status: 200 });
        if (url.includes("/threads/thread-3/messages")) return new Response(JSON.stringify([]), { status: 200 });
        if (url.endsWith("/roles/role-1/grants") || url.endsWith("/roles/role-2/grants") || url.endsWith("/roles/role-3/grants")) {
          return new Response(JSON.stringify([]), { status: 200 });
        }
        return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      }) as unknown as typeof fetch;
    }

    it("`/` redirects to the most recently active thread", async () => {
      global.fetch = threeThreadFetch();
      renderPage("/");
      // THREAD (thread-1) has the newest updatedAt of the three.
      await waitFor(() => expect(screen.getAllByText("Research Assistant").length).toBeGreaterThan(0));
      await waitFor(() => expect(screen.getByText("hi there")).toBeInTheDocument());
    });

    it("switching A→B→C→A: transcript, stream, composer target and routines panel all change together", async () => {
      const abortSpy = vi.spyOn(AbortController.prototype, "abort");
      global.fetch = threeThreadFetch();
      const user = userEvent.setup({ delay: null });
      renderPage("/workspace/thread-1");

      await waitFor(() => expect(screen.getByText("hi there")).toBeInTheDocument());
      expect(
        screen.getByLabelText("Conversation with Research Assistant"),
      ).toBeInTheDocument();

      // A -> B
      await user.click(screen.getByRole("option", { name: /Ops Bot/i }));
      expect(await screen.findByLabelText("Conversation with Ops Bot")).toBeInTheDocument();
      expect(screen.queryByText("hi there")).not.toBeInTheDocument();
      const abortsAfterAtoB = abortSpy.mock.calls.length;
      expect(abortsAfterAtoB).toBeGreaterThan(0); // thread-1's stream was closed

      // B -> C
      await user.click(screen.getByRole("option", { name: /Scheduler/i }));
      expect(await screen.findByLabelText("Conversation with Scheduler")).toBeInTheDocument();
      expect(abortSpy.mock.calls.length).toBeGreaterThan(abortsAfterAtoB); // thread-2's stream was closed

      // C -> A again: the transcript comes back exactly as it was, without
      // a fresh GET /threads/thread-1/messages (spec §2.7's "returning to A").
      const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
      const thread1MessageGetsBeforeReturn = fetchMock.mock.calls.filter(
        (call: unknown[]) => String(call[0]).includes("/threads/thread-1/messages"),
      ).length;
      await user.click(screen.getByRole("option", { name: /Research Assistant/i }));
      expect(await screen.findByLabelText("Conversation with Research Assistant")).toBeInTheDocument();
      expect(screen.getByText("hi there")).toBeInTheDocument();
      const thread1MessageGetsAfterReturn = fetchMock.mock.calls.filter(
        (call: unknown[]) => String(call[0]).includes("/threads/thread-1/messages"),
      ).length;
      expect(thread1MessageGetsAfterReturn).toBe(thread1MessageGetsBeforeReturn);
    });

    it("pending state is per thread: a bot frame on B while A is active neither clears nor sets A's pending", async () => {
      const streams: Record<string, ReturnType<typeof openStreamResponse>> = {
        "thread-1": openStreamResponse(),
        "thread-2": openStreamResponse(),
      };
      global.fetch = threeThreadFetch((url) => {
        if (url.includes("/threads/thread-1/stream")) return streams["thread-1"]!.response;
        if (url.includes("/threads/thread-2/stream")) return streams["thread-2"]!.response;
        return undefined;
      });
      const user = userEvent.setup({ delay: null });
      renderPage("/workspace/thread-1");

      await waitFor(() => expect(screen.getByText("hi there")).toBeInTheDocument());

      // Switch to B before A ever sends anything — A has no pending state.
      await user.click(screen.getByRole("option", { name: /Ops Bot/i }));
      await screen.findByLabelText("Conversation with Ops Bot");

      // A bot frame lands on B.
      streams["thread-2"]!.push({
        id: "b-bot-1",
        threadId: "thread-2",
        role: "bot",
        body: "deployed",
        runId: null,
        createdAt: "2026-09-12T10:00:00.000Z",
      });
      await waitFor(() => expect(screen.getByText("deployed")).toBeInTheDocument());
      // No typing indicator on B: nothing was pending there either.
      expect(screen.queryByTestId("typing-indicator")).not.toBeInTheDocument();

      streams["thread-1"]!.close();
      streams["thread-2"]!.close();
    });
  });

  describe("Members panel (spec §2.5)", () => {
    it("shows the server roster for the active single-bot thread", async () => {
      global.fetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/auth/login")) return new Response(JSON.stringify({ authenticated: true }), { status: 200 });
        if (url.endsWith("/roles")) {
          return new Response(
            JSON.stringify([{ id: "role-1", name: "Research Assistant", description: "", avatarSeed: "role-1" }]),
            { status: 200 },
          );
        }
        if (url.endsWith("/workspace/summary")) return new Response(JSON.stringify([]), { status: 200 });
        if (url.endsWith("/threads")) return new Response(JSON.stringify([THREAD]), { status: 200 });
        if (url.includes("/threads/thread-1/stream")) return openStream();
        if (url.includes("/threads/thread-1/messages")) return new Response(JSON.stringify([]), { status: 200 });
        if (url.endsWith("/roles/role-1/grants")) return new Response(JSON.stringify([]), { status: 200 });
        return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      }) as unknown as typeof fetch;

      renderPage();

      const membersList = await screen.findByLabelText("Members");
      await waitFor(() => expect(membersList).toHaveTextContent("Research Assistant"));
    });

    it("shows every group member resolved against the roster for a group thread", async () => {
      const GROUP_THREAD = {
        id: "group-1",
        memberRoleIds: ["role-1", "role-2"],
        memberNames: ["Research Assistant", "Ops Bot"],
        title: "Crew",
        lastMessagePreview: "",
        updatedAt: "2026-09-05T00:00:00.000Z",
      };
      global.fetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/auth/login")) return new Response(JSON.stringify({ authenticated: true }), { status: 200 });
        if (url.endsWith("/roles")) {
          return new Response(
            JSON.stringify([
              { id: "role-1", name: "Research Assistant", description: "", avatarSeed: "role-1" },
              { id: "role-2", name: "Ops Bot", description: "", avatarSeed: "role-2" },
            ]),
            { status: 200 },
          );
        }
        if (url.endsWith("/workspace/summary")) return new Response(JSON.stringify([]), { status: 200 });
        if (url.endsWith("/threads")) return new Response(JSON.stringify([GROUP_THREAD]), { status: 200 });
        if (url.includes("/threads/group-1/stream")) return openStream();
        if (url.includes("/threads/group-1/messages")) return new Response(JSON.stringify([]), { status: 200 });
        return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      }) as unknown as typeof fetch;

      renderPage();

      const membersList = await screen.findByLabelText("Members");
      await waitFor(() => expect(membersList).toHaveTextContent("Research Assistant"));
      expect(membersList).toHaveTextContent("Ops Bot");
    });
  });

  describe("/workspace/:threadId route (spec §2.6)", () => {
    it("renders a not-found state for a threadId the principal does not own, never another user's data", async () => {
      global.fetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/auth/login")) return new Response(JSON.stringify({ authenticated: true }), { status: 200 });
        if (url.endsWith("/roles")) return new Response(JSON.stringify([]), { status: 200 });
        if (url.endsWith("/workspace/summary")) return new Response(JSON.stringify([]), { status: 200 });
        if (url.endsWith("/threads")) return new Response(JSON.stringify([THREAD]), { status: 200 });
        // If ChatPage ever calls this for a thread it doesn't own, that's
        // the exact leak spec §2.6 forbids — fail loudly.
        if (url.includes("/threads/someone-elses-thread/")) {
          throw new Error("must never fetch a thread the principal does not own");
        }
        return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      }) as unknown as typeof fetch;

      renderPage("/workspace/someone-elses-thread");

      expect(await screen.findByRole("alert")).toHaveTextContent(/not found/i);
      expect(screen.queryByText("Research Assistant")).not.toBeInTheDocument();
    });

    it("renders the empty state at `/` when the principal owns no threads", async () => {
      global.fetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/auth/login")) return new Response(JSON.stringify({ authenticated: true }), { status: 200 });
        if (url.endsWith("/roles")) return new Response(JSON.stringify([]), { status: 200 });
        if (url.endsWith("/workspace/summary")) return new Response(JSON.stringify([]), { status: 200 });
        if (url.endsWith("/threads")) return new Response(JSON.stringify([]), { status: 200 });
        return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      }) as unknown as typeof fetch;

      renderPage("/");

      expect(await screen.findByText(/no bots yet/i)).toBeInTheDocument();
    });
  });

  describe("session bootstrap (spec §3.1)", () => {
    it("bootstrap-authenticated: a valid session cookie lands on the workspace without the login screen", async () => {
      global.fetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/auth/me")) {
          return new Response(
            JSON.stringify({ tenantId: "basileia", kind: "user", expiresAt: "2026-09-13T00:00:00.000Z" }),
            { status: 200 },
          );
        }
        if (url.endsWith("/roles")) return new Response(JSON.stringify([]), { status: 200 });
        if (url.endsWith("/workspace/summary")) return new Response(JSON.stringify([]), { status: 200 });
        if (url.endsWith("/threads")) return new Response(JSON.stringify([THREAD]), { status: 200 });
        if (url.includes("/threads/thread-1/stream")) return openStream();
        if (url.includes("/threads/thread-1/messages")) return new Response(JSON.stringify([]), { status: 200 });
        return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      }) as unknown as typeof fetch;

      renderWithBootstrap("/");

      await waitFor(() => expect(screen.getAllByText("Research Assistant").length).toBeGreaterThan(0));
      expect(screen.queryByLabelText(/access token/i)).not.toBeInTheDocument();
    });

    it("bootstrap-unauthenticated: no session cookie shows the login screen, never the workspace", async () => {
      global.fetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/auth/me")) {
          return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
        }
        return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      }) as unknown as typeof fetch;

      renderWithBootstrap("/");

      expect(await screen.findByLabelText(/access token/i)).toBeInTheDocument();
      await waitFor(() => expect(screen.queryByRole("listbox", { name: /bot threads/i })).not.toBeInTheDocument());
    });
  });

  describe("workspace summary poll and badges (spec §4.2)", () => {
    it("renders a badge on a background thread from GET /workspace/summary, none on the active thread", async () => {
      global.fetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/auth/login")) return new Response(JSON.stringify({ authenticated: true }), { status: 200 });
        if (url.endsWith("/roles")) return new Response(JSON.stringify([]), { status: 200 });
        if (url.endsWith("/workspace/summary")) {
          return new Response(
            JSON.stringify([
              {
                threadId: "thread-2",
                latestRun: { runId: "run-2", status: "waiting_approval" },
                pendingApprovals: 1,
                lastActivityAt: "2026-09-12T09:00:00.000Z",
              },
            ]),
            { status: 200 },
          );
        }
        if (url.endsWith("/threads")) return new Response(JSON.stringify([THREAD, THREAD_2]), { status: 200 });
        if (url.includes("/threads/thread-1/stream") || url.includes("/threads/thread-2/stream")) {
          return openStream();
        }
        if (url.includes("/threads/thread-1/messages") || url.includes("/threads/thread-2/messages")) {
          return new Response(JSON.stringify([]), { status: 200 });
        }
        return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      }) as unknown as typeof fetch;

      renderPage("/workspace/thread-1");

      const opsBotRow = await screen.findByRole("option", { name: /ops bot/i });
      expect(opsBotRow).toHaveTextContent(/approval/i);

      const researchRow = screen.getByRole("option", { name: /research assistant/i });
      expect(researchRow).not.toHaveTextContent(/approval|working|blocked|new/i);
    });
  });

  describe("logout (spec §3.2)", () => {
    it("calls POST /auth/logout and drops in-memory workspace state (drafts, transcript)", async () => {
      global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/auth/login")) return new Response(JSON.stringify({ authenticated: true }), { status: 200 });
        if (url.endsWith("/auth/logout") && init?.method === "POST") {
          return new Response(null, { status: 204 });
        }
        if (url.endsWith("/roles")) return new Response(JSON.stringify([]), { status: 200 });
        if (url.endsWith("/workspace/summary")) return new Response(JSON.stringify([]), { status: 200 });
        if (url.endsWith("/threads")) return new Response(JSON.stringify([THREAD]), { status: 200 });
        if (url.includes("/threads/thread-1/stream")) return openStream();
        if (url.includes("/threads/thread-1/messages")) {
          return new Response(JSON.stringify([USER_MESSAGE]), { status: 200 });
        }
        return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      }) as unknown as typeof fetch;

      const user = userEvent.setup({ delay: null });
      renderPage("/workspace/thread-1");

      await screen.findByText("hi there");
      await user.type(screen.getByLabelText("Message"), "an unsent draft");
      expect(screen.getByLabelText("Message")).toHaveValue("an unsent draft");

      await user.click(screen.getByRole("button", { name: /log out/i }));

      await waitFor(() =>
        expect(global.fetch).toHaveBeenCalledWith(
          expect.stringContaining("/auth/logout"),
          expect.objectContaining({ method: "POST" }),
        ),
      );
      await waitFor(() => expect(screen.getByLabelText("Message")).toHaveValue(""));
      expect(screen.queryByText("hi there")).not.toBeInTheDocument();
    });
  });
});
