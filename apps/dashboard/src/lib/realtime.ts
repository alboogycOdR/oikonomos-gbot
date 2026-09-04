/**
 * TASK-129 (RT-01) — replaces `ChatPage`'s client-side 2s `setInterval`
 * polling loop against `GET /threads/:id/messages` with a held-open push
 * subscription to control-api's `GET /threads/:id/stream` SSE route
 * (`services/control-api/src/app.ts`).
 *
 * Implemented on `fetch` + a manual `ReadableStream` reader rather than
 * the browser's built-in `EventSource`, deliberately:
 *  - `EventSource` cannot send `credentials: "same-origin"` semantics
 *    plus a custom `Last-Event-ID` header the way this module needs for
 *    deterministic tests (jsdom has no native `EventSource` at all).
 *  - A hand-rolled reader is directly testable by mocking `fetch` to
 *    return a `ReadableStream` body, with no real network/timers.
 *
 * Resume semantics (AC3 "dropped connection reconnects, no
 * duplicate/missed messages"): every frame the server sends is `id:
 * <message id>\ndata: <json>\n\n`. This module remembers the last `id`
 * it processed and sends it back as the `Last-Event-ID` header on every
 * reconnect, matching the exclusive `after` cursor the server's
 * `listMessages` call already uses — so a resumed stream never repeats a
 * message already delivered and never skips one that arrived while
 * disconnected.
 */

import { UnauthorizedError } from "./api";

const BASE_URL: string =
  (import.meta.env.VITE_CONTROL_API_BASE_URL as string | undefined) ?? "";

/** Wire shape control-api's stream route sends — identical to `ThreadMessage` (`lib/api.ts`). */
export interface RealtimeMessage {
  id: string;
  threadId: string;
  role: string;
  body: string;
  runId: string | null;
  createdAt: string;
  senderRoleId?: string | null;
  senderName?: string | null;
  approval?: {
    nonce: string;
    action_render: string;
    status: string;
    capability_id: string;
    max_tier: string | null;
  };
}

export interface RealtimeSubscription {
  /** Tears down the stream and any pending reconnect timer. Idempotent. */
  close(): void;
}

export interface SubscribeOptions {
  /** Delay before reconnecting after a dropped/ended stream. Default 500ms. */
  reconnectDelayMs?: number;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_RECONNECT_DELAY_MS = 500;

/**
 * Opens (and, on drop, silently reconnects) a push subscription for one
 * thread's messages. `onMessage` fires once per message, in arrival
 * order, exactly once per message id. Call `close()` when the thread is
 * switched away from or the component unmounts — mirrors the existing
 * `clearIntervalSpy` cleanup discipline this codebase already expects of
 * `ChatPage`.
 */
export function subscribeToThreadMessages(
  threadId: string,
  onMessage: (message: RealtimeMessage) => void,
  onError?: (error: unknown) => void,
  options: SubscribeOptions = {},
): RealtimeSubscription {
  const fetchImpl = options.fetchImpl ?? fetch;
  const reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;

  let closed = false;
  let controller: AbortController | null = null;
  let lastEventId: string | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  function scheduleReconnect() {
    if (closed) return;
    reconnectTimer = setTimeout(() => {
      void connectOnce();
    }, reconnectDelayMs);
  }

  async function connectOnce(): Promise<void> {
    if (closed) return;
    controller = new AbortController();
    try {
      const response = await fetchImpl(
        `${BASE_URL}/threads/${encodeURIComponent(threadId)}/stream`,
        {
          credentials: "same-origin",
          signal: controller.signal,
          headers: lastEventId === undefined ? {} : { "last-event-id": lastEventId },
        },
      );
      if (closed) return;
      if (response.status === 401) {
        throw new UnauthorizedError();
      }
      if (!response.ok || response.body === null) {
        throw new Error(`stream request failed with ${response.status}`);
      }
      await readFrames(response.body);
    } catch (error) {
      if (closed) return;
      // AbortError is this module's own close()/reconnect churn, not a
      // real failure — never surface it to onError.
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }
      onError?.(error);
      if (error instanceof UnauthorizedError) {
        // No session can come back on its own — further reconnect
        // attempts would just keep hammering the endpoint with 401s
        // until the caller re-authenticates and opens a fresh
        // subscription. Matches the old polling loop's behavior of
        // stopping outright on an auth failure.
        return;
      }
    }
    // The stream ended (server closed it) or errored (non-auth):
    // reconnect unless close() has already been called.
    scheduleReconnect();
  }

  async function readFrames(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (!closed) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let separatorIndex: number;
        while ((separatorIndex = buffer.indexOf("\n\n")) !== -1) {
          const rawFrame = buffer.slice(0, separatorIndex);
          buffer = buffer.slice(separatorIndex + 2);
          processFrame(rawFrame);
        }
      }
    } finally {
      await reader.cancel().catch(() => {
        // Reader already closed/aborted — nothing further to clean up.
      });
    }
  }

  function processFrame(rawFrame: string): void {
    if (rawFrame.startsWith(":")) return; // comment/heartbeat, not a message
    let id: string | undefined;
    let data: string | undefined;
    for (const line of rawFrame.split("\n")) {
      if (line.startsWith("id:")) {
        id = line.slice(3).trim();
      } else if (line.startsWith("data:")) {
        data = (data ?? "") + line.slice(5).trim();
      }
    }
    if (id !== undefined) {
      lastEventId = id;
    }
    if (data === undefined || data.length === 0) return;
    try {
      onMessage(JSON.parse(data) as RealtimeMessage);
    } catch {
      // Malformed frame — drop it rather than crash the subscription;
      // the next poll tick on the server will still eventually deliver
      // any real message correctly framed.
    }
  }

  void connectOnce();

  return {
    close(): void {
      if (closed) return;
      closed = true;
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      controller?.abort();
    },
  };
}
