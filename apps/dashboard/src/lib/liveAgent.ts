/**
 * TASK-248 — dashboard-side counterpart to `services/control-api/src/
 * liveAgent.routes.ts`'s read-only PTY viewer (TASK-171), mirroring the
 * mobile app's own `apps/mobile/lib/api/live_agent_client.dart`
 * `LiveAgentClient` for the web client. Read-only only: this module has
 * no `send`/`write` of any kind, on purpose — the AC1 guarantee ("the
 * viewer connection genuinely cannot inject input") is enforced
 * server-side (`liveAgent.routes.ts`'s `relay()`), and this client
 * reinforces it structurally, same reasoning as the Dart client's own
 * `LiveAgentSubscription` (no send method exists to call). Interactive
 * take-over is explicitly out of scope here — it waits on TASK-235 (CDP
 * hand-off + exclusivity proof); the Computer view built on top of this
 * client (`components/workspace/computer/ComputerView.tsx`) says so
 * explicitly rather than showing a disabled control (spec §10).
 *
 * WebSocket auth: unlike `lib/api.ts`'s `fetch` calls, a browser
 * `WebSocket` handshake cannot carry a custom `Authorization` header — the
 * dashboard's httpOnly session cookie rides along automatically because
 * the connection is same-origin (TASK-240's single-origin proxy). That is
 * exactly the property `liveAgent.routes.ts`'s own new Origin check
 * (TASK-248, same file) is meant to protect: a foreign page cannot open
 * this socket and ride the visitor's cookie, because the server now
 * refuses any WS upgrade whose `Origin` header doesn't match its own
 * `Host`.
 */

import { UnauthorizedError } from "./api";

const BASE_URL: string = (import.meta.env.VITE_CONTROL_API_BASE_URL as string | undefined) ?? "";

/** Wire shape of `GET /roles/:roleId/live-agent/status`'s response — mirrors the Dart client's `LiveAgentStatus` exactly. */
export interface LiveAgentStatus {
  available: boolean;
  state?: string;
}

/**
 * `GET /roles/:roleId/live-agent/status`. A `501` (no `LiveAgentPort`
 * configured on this server) is treated the same as "nothing to show",
 * never surfaced as an error — from the caller's perspective both mean
 * there is no live session to display, same convention the Dart client
 * already established.
 */
export async function getLiveAgentStatus(
  roleId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LiveAgentStatus> {
  const response = await fetchImpl(
    `${BASE_URL}/roles/${encodeURIComponent(roleId)}/live-agent/status`,
    { credentials: "same-origin" },
  );
  if (response.status === 401) {
    throw new UnauthorizedError();
  }
  if (response.status === 501) {
    return { available: false };
  }
  if (!response.ok) {
    throw new Error(`live-agent status request failed with ${response.status}`);
  }
  return (await response.json()) as LiveAgentStatus;
}

/** The subset of the browser's `WebSocket` this client depends on, so a fake can implement it in tests without opening a real socket. */
export interface WebSocketLike {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: (() => void) | null;
  close(): void;
}

/** Injectable so tests never dial a real socket — same shape as the global `WebSocket` constructor. */
export type WebSocketConnector = (url: string) => WebSocketLike;

/**
 * Wraps a real browser `WebSocket` so its handler signatures match
 * `WebSocketLike` exactly (the DOM's `WebSocket` event handlers take an
 * `Event`/`MessageEvent`/`CloseEvent` argument `WebSocketLike` doesn't
 * need) — mirrors the Dart client's own `_RealWebSocket` wrapper.
 * `wrapper`'s `onX` fields are plain mutable properties `watchLiveAgent`
 * assigns directly; the `addEventListener` closures below read whichever
 * handler is current at the moment the real socket fires, same as the
 * DOM's own `onX =` assignment semantics.
 */
function defaultConnector(url: string): WebSocketLike {
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  const wrapper: WebSocketLike = {
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    close(): void {
      socket.close();
    },
  };
  socket.addEventListener("open", () => wrapper.onopen?.());
  socket.addEventListener("message", (event) => wrapper.onmessage?.({ data: event.data }));
  socket.addEventListener("error", (event) => wrapper.onerror?.(event));
  socket.addEventListener("close", () => wrapper.onclose?.());
  return wrapper;
}

/** Resolves the `ws(s)://` base to dial against, mirroring `lib/api.ts`/`lib/realtime.ts`'s same-origin-by-default convention: an explicit `VITE_CONTROL_API_BASE_URL` override wins, otherwise the page's own origin (via `window.location`). */
function resolveWsBase(): string {
  if (BASE_URL.length > 0) {
    return BASE_URL.replace(/^http/, "ws");
  }
  const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${wsProtocol}//${window.location.host}`;
}

export interface LiveAgentSubscription {
  /** Tears down the socket and any pending connect. Idempotent. */
  close(): void;
}

export interface WatchOptions {
  /** Injectable for tests; defaults to a real browser `WebSocket`. */
  connector?: WebSocketConnector;
}

const decoder = new TextDecoder();

/** Normalizes a WS message event's `data` (string, ArrayBuffer, or Blob) into a UTF-8 string chunk. Blob is handled async via a callback since `FileReader`/`Blob.text()` cannot be resolved synchronously; the real browser WebSocket with `binaryType = "arraybuffer"` never actually produces a Blob, but a caller-supplied fake connector could, so this stays defensive rather than assuming. */
function decodeChunk(data: unknown, onText: (text: string) => void): void {
  if (typeof data === "string") {
    onText(data);
    return;
  }
  // `instanceof ArrayBuffer` can false-negative across realms (e.g. a test
  // environment's `TextEncoder` producing a buffer from a different global
  // than the one `ArrayBuffer` resolves to here) — `Object.prototype.
  // toString` is realm-independent and the reliable check for this.
  if (Object.prototype.toString.call(data) === "[object ArrayBuffer]") {
    onText(decoder.decode(data as ArrayBuffer));
    return;
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    data
      .text()
      .then(onText)
      .catch(() => {
        // Malformed/unreadable binary chunk — drop it rather than crash
        // the subscription; the next real output chunk still arrives.
      });
    return;
  }
  // Unknown shape (e.g. a Node Buffer if this ever ran outside a browser
  // fake) — best-effort stringify rather than silently dropping it.
  onText(String(data));
}

/**
 * Opens the read-only PTY viewer stream (execd's `mode=viewer&since=0` —
 * replay of everything so far, then live, via `liveAgent.routes.ts`'s
 * `relay()`). `onOutput` fires once per chunk of real sandbox output, in
 * arrival order — never mocked/placeholder content. `onDone` fires once
 * the sandbox session ends or the server closes the stream (e.g. no
 * active/recent session — the caller should check `getLiveAgentStatus`
 * first, but a race is handled gracefully here, not as an error).
 */
export function watchLiveAgent(
  roleId: string,
  onOutput: (chunk: string) => void,
  onOpen?: () => void,
  onDone?: () => void,
  onError?: (error: unknown) => void,
  options: WatchOptions = {},
): LiveAgentSubscription {
  const connector = options.connector ?? defaultConnector;
  const url = `${resolveWsBase()}/roles/${encodeURIComponent(roleId)}/live-agent/pty`;

  let closed = false;
  const socket = connector(url);

  socket.onopen = () => {
    if (closed) return;
    onOpen?.();
  };
  socket.onmessage = (event) => {
    if (closed) return;
    decodeChunk(event.data, onOutput);
  };
  socket.onerror = (error) => {
    if (closed) return;
    onError?.(error);
  };
  socket.onclose = () => {
    if (closed) return;
    onDone?.();
  };

  return {
    close(): void {
      if (closed) return;
      closed = true;
      try {
        socket.close();
      } catch {
        // Already closed.
      }
    },
  };
}
