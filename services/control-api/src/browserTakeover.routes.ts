/**
 * TASK-235 (G-07 part 2b) — Steel/CDP interactive browser hand-off: the
 * browser-flavoured mirror of `liveAgent.routes.ts`'s `relayTakeover()`
 * (TASK-228, shell/PTY hand-off).
 *
 * One route: `GET /runs/:id/browser-takeover`, a raw WebSocket upgrade,
 * hand-rolled against `node:http`/`node:net`/`node:crypto` only — same
 * choice `liveAgent.routes.ts` made and the same reason (no `ws`/
 * `@fastify/websocket` dependency, which would touch
 * `services/control-api/package.json`, outside this task's `Owned_Paths`).
 *
 * Deliberately a SEPARATE module from `liveAgent.routes.ts` rather than an
 * import of its `FrameReader`/`encodeFrame`/relay internals, even though
 * the WS framing logic is byte-for-byte the same protocol (RFC 6455):
 * `liveAgent.routes.ts`'s own file header states its own reason for
 * keeping the viewer and takeover code paths separate functions rather
 * than a shared one with a flag — "a shared function with a 'except when
 * this flag is true' branch is exactly the shape of bug that turns a hard
 * guarantee into a soft one." The same principle extends across files
 * here: this route's authorization gate (a live, at-connect-time pending
 * check) is a different security property than either of
 * `liveAgent.routes.ts`'s two routes, resolved against a completely
 * different upstream (Steel's CDP socket, not execd's PTY), so keeping it
 * fully self-contained means the entire authorization+relay path for THIS
 * capability can be read and audited in one file, with no shared
 * incidental coupling to the PTY file's own future edits.
 *
 * Research this implementation rests on (full trail in
 * `dossiers/TASK-235.md`):
 *
 * 1. CDP session/target model (confirmed against Steel's real behavior,
 *    not docs alone — TASK-214/225's own live proof, re-confirmed here):
 *    Steel's REST session returns a BROWSER-level CDP WebSocket endpoint.
 *    `Page.*`/`Runtime.*`/`Input.*` commands are only valid within an
 *    ATTACHED page session — sent raw on the browser socket, CDP itself
 *    rejects them. The fix, used identically on both the model's own tool
 *    side (`geminiToolExecutors.ts`'s `runSteelCdp`) and the human side
 *    this file relays for: `Target.getTargets` → `Target.attachToTarget
 *    ({flatten: true})` → ride the returned `sessionId` on every command
 *    envelope thereafter. This file relays the RAW CDP byte stream
 *    end-to-end (the client — `browser_takeover_client.dart` — does the
 *    flatten-attach itself, exactly like `runSteelCdp` does); this route
 *    does not parse or rewrite CDP messages, only proxies them, same
 *    "genuinely a pipe" shape as `relayTakeover`'s forwarded direction.
 *
 * 2. The pause question: unlike execd's PTY (one live, exclusive,
 *    write-capable holder connection that genuinely must be EVICTED),
 *    `chatRunDriver.ts`'s catch block calls `parkTaskRun` and `return`s
 *    the instant a takeover signal is caught — there is no live
 *    CDP-issuing process left running once a run parks. `Target.
 *    attachToTarget` is additive (any number of sessions can attach to
 *    the same target concurrently; there is no CDP "evict a competing
 *    holder" primitive), so the shell case's eviction concept was never
 *    the right model here — this is a STRONGER guarantee (no live writer
 *    to race), not a weaker one.
 *
 *    Defense-in-depth ADDED here nonetheless (mirrors `relayTakeover`'s
 *    own precedent of not relying on just one guarantee): this route
 *    refuses to even dial Steel's CDP endpoint unless the run's takeover
 *    status is independently confirmed `pending: true` AT CONNECT TIME
 *    (`options.takeoverStatus`, checked before `browserTakeover.
 *    getCdpEndpoint` is even called) — the human's own relay is reachable
 *    only while the run is actually parked, checked twice: once by this
 *    gate, and again by whatever `BrowserTakeoverPort.getCdpEndpoint`
 *    itself does internally (a real implementation is expected to also
 *    refuse for a non-pending/non-owned run, same as `LiveAgentPort.
 *    getActiveSandbox`'s own null-for-not-found contract).
 *
 * Production wiring of `BrowserTakeoverPort` is left `undefined` here —
 * same accepted shape `LiveAgentPort`/`TakeoverPort`/`SecretRequestsPort`
 * all shipped in when first built (see `app.ts`'s own doc comments on
 * each): the routes 501 rather than fabricate state until that follow-up
 * task exists.
 */
import { randomBytes, createHash } from "node:crypto";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Socket } from "node:net";

import type { FastifyInstance } from "fastify";

import { authenticate, parseCookieHeader, verifySessionPrincipal, SESSION_COOKIE_NAME } from "./auth.js";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const BROWSER_TAKEOVER_PATH_PATTERN = /^\/runs\/([^/]+)\/browser-takeover$/;

// WebSocket opcodes (RFC 6455 §5.2).
const OPCODE_CONTINUATION = 0x0;
const OPCODE_TEXT = 0x1;
const OPCODE_BINARY = 0x2;
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xa;

/** A fully-resolved Steel CDP WebSocket endpoint for a run's parked browser session. */
export interface BrowserTakeoverEndpoint {
  /** Full `ws://` or `wss://` URL to Steel's BROWSER-level CDP socket (not a page target — the client performs its own flatten-attach, mirroring `runSteelCdp`'s own model-side sequence). */
  readonly url: string;
  /** Headers required to authenticate to Steel/the lifecycle proxy — resolved by the port implementation; this file never reads or logs a secret. */
  readonly headers?: Readonly<Record<string, string>>;
}

/** Port this route depends on. Production wiring is deferred follow-up work — see file header. */
export interface BrowserTakeoverPort {
  /**
   * Resolves the CDP endpoint for `runId`'s parked Steel session,
   * tenant-scoped. `null` when the run doesn't exist, isn't owned by
   * `tenantId`, or the run is not CURRENTLY a pending browser-kind
   * takeover (checked live — never cached — since a stale "yes" here
   * would let a stray connection reach a browser after hand-back).
   */
  getCdpEndpoint(runId: string, tenantId: string): Promise<BrowserTakeoverEndpoint | null>;
}

/**
 * Minimal, duck-typed subset of `app.ts`'s `TakeoverPort` used only for
 * this route's defense-in-depth connect-time gate (see file header,
 * point 2). Deliberately NOT imported from `app.ts`: `app.ts` imports
 * THIS file (to register the route), so an import the other way would be
 * circular. Structural typing means the real `TakeoverPort` (or its
 * `getStatus` method) satisfies this without any adapter.
 */
export interface TakeoverStatusPort {
  getStatus(runId: string): Promise<{ readonly pending: boolean } | null>;
}

/** Fired every time a browser-takeover connection's input genuinely reaches Steel — the CLAUDE.md-mandated liveness assertion for this control, mirroring `LiveAgentInputForwardedEvent`. */
export interface BrowserTakeoverInputForwardedEvent {
  readonly runId: string;
  readonly opcode: number;
  readonly byteLength: number;
}

/** The upstream (Steel) side of a relay, already past the WS handshake. */
export interface UpstreamConnection {
  readonly socket: Socket;
  /** Any bytes Steel sent immediately after the 101 response, before we attached a 'data' listener. */
  readonly initialBuffer: Buffer;
  close(): void;
}

export interface RegisterBrowserTakeoverRoutesOptions {
  readonly authToken: string;
  readonly browserTakeover?: BrowserTakeoverPort;
  /** The connect-time defense-in-depth gate — see file header, point 2. Omitting it does not disable the gate `browserTakeover.getCdpEndpoint` is itself expected to enforce; it only removes this route's OWN independent check. */
  readonly takeoverStatus?: TakeoverStatusPort;
  /** Injectable so tests never dial a real socket. Defaults to a real HTTP Upgrade dial against `endpoint.url`. */
  readonly dialUpstream?: (endpoint: BrowserTakeoverEndpoint) => Promise<UpstreamConnection>;
  /** Test-only: observes the liveness assertion (fires whenever input is genuinely forwarded to Steel). */
  readonly onInputForwarded?: (event: BrowserTakeoverInputForwardedEvent) => void;
  /**
   * TASK-286 — how often an open browser-takeover connection re-checks
   * that its originating session is still valid (signature + not
   * expired). Defaults to 15s, the same bound `app.ts`'s SSE heartbeat
   * uses (TASK-259). Test-injectable so a test can observe a force-close
   * within a real, bounded wait rather than the production interval.
   */
  readonly sessionRevalidationIntervalMs?: number;
}

function acceptKeyFor(key: string): string {
  return createHash("sha1").update(key + WEBSOCKET_GUID).digest("base64");
}

/** Encodes one unfragmented WS frame. `mask` must be true for client->server frames (RFC 6455 §5.1), false for server->client. */
export function encodeFrame(opcode: number, payload: Buffer, mask: boolean): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  if (!mask) return Buffer.concat([header, payload]);
  header[1] |= 0x80;
  const maskKey = randomBytes(4);
  const masked = Buffer.alloc(length);
  for (let i = 0; i < length; i += 1) masked[i] = payload[i]! ^ maskKey[i % 4]!;
  return Buffer.concat([header, maskKey, masked]);
}

export interface DecodedFrame {
  readonly opcode: number;
  readonly payload: Buffer;
  readonly fin: boolean;
}

/** Incremental RFC 6455 frame decoder. Handles both masked (client->server) and unmasked (server->client) input; no compression extensions (never negotiated in the 101 response below). */
export class FrameReader {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): DecodedFrame[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const frames: DecodedFrame[] = [];
    for (;;) {
      if (this.buffer.length < 2) break;
      const first = this.buffer[0]!;
      const second = this.buffer[1]!;
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let payloadLength = second & 0x7f;
      let offset = 2;
      if (payloadLength === 126) {
        if (this.buffer.length < offset + 2) break;
        payloadLength = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (payloadLength === 127) {
        if (this.buffer.length < offset + 8) break;
        const big = this.buffer.readBigUInt64BE(offset);
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("browser-takeover CDP frame exceeds safe length");
        payloadLength = Number(big);
        offset += 8;
      }
      let maskKey: Buffer | undefined;
      if (masked) {
        if (this.buffer.length < offset + 4) break;
        maskKey = this.buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (this.buffer.length < offset + payloadLength) break;
      const raw = this.buffer.subarray(offset, offset + payloadLength);
      let payload: Buffer;
      if (maskKey !== undefined) {
        payload = Buffer.alloc(payloadLength);
        for (let i = 0; i < payloadLength; i += 1) payload[i] = raw[i]! ^ maskKey[i % 4]!;
      } else {
        payload = Buffer.from(raw);
      }
      frames.push({ opcode, payload, fin });
      this.buffer = this.buffer.subarray(offset + payloadLength);
    }
    return frames;
  }
}

function writeRawResponseAndDestroy(socket: Socket, status: number, message: string): void {
  try {
    socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch {
    // Socket may already be half-closed; nothing more to do.
  }
  try {
    socket.destroy();
  } catch {
    // Already destroyed.
  }
}

function acceptUpgrade(req: IncomingMessage, socket: Socket): boolean {
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string" || key.trim().length === 0) return false;
  try {
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${acceptKeyFor(key)}\r\n\r\n`,
    );
    return true;
  } catch {
    return false;
  }
}

/** Real dial: an HTTP Upgrade request to Steel's CDP endpoint, carrying whatever auth headers the port resolved. No `ws` dependency — `node:http`'s client supports the Upgrade handshake natively via the `'upgrade'` event. */
export function defaultDialUpstream(endpoint: BrowserTakeoverEndpoint): Promise<UpstreamConnection> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(endpoint.url);
    } catch {
      reject(new Error("browser-takeover CDP endpoint was not a valid URL"));
      return;
    }
    if (url.protocol !== "ws:" && url.protocol !== "wss:") {
      reject(new Error("browser-takeover CDP endpoint must be ws:// or wss://"));
      return;
    }
    const requester = url.protocol === "wss:" ? httpsRequest : httpRequest;
    const req = requester({
      protocol: url.protocol === "wss:" ? "https:" : "http:",
      hostname: url.hostname,
      port: url.port === "" ? undefined : url.port,
      path: `${url.pathname}${url.search}`,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
        ...endpoint.headers,
      },
    });
    req.on("upgrade", (res, socket, head) => {
      if (res.statusCode !== 101) {
        socket.destroy();
        reject(new Error(`Steel CDP upgrade returned unexpected status ${String(res.statusCode)}`));
        return;
      }
      resolve({
        socket: socket as Socket,
        initialBuffer: head instanceof Buffer ? head : Buffer.alloc(0),
        close(): void {
          try {
            socket.destroy();
          } catch {
            // Already closed.
          }
        },
      });
    });
    req.on("response", (res) => {
      reject(new Error(`Steel did not upgrade the CDP connection (status ${String(res.statusCode)})`));
    });
    req.on("error", (error) => reject(error instanceof Error ? error : new Error(String(error))));
    req.end();
  });
}

/**
 * Bidirectional CDP relay between the human's mobile client and Steel:
 * unlike `liveAgent.routes.ts`'s read-only `relay()`, BOTH directions
 * genuinely forward here — that is the entire point of an interactive
 * hand-off. Structurally this is the mirror of `relayTakeover()`, not
 * `relay()`; see this file's header for why it is its own copy rather
 * than an import of that one.
 *
 * `closed` is checked explicitly at the top of the downstream handler —
 * deliberately NOT relying only on a destroyed `Socket`'s `.write()`
 * throwing as the sole backstop, for the same reason `relayTakeover`'s own
 * doc comment gives: a data event already queued before `.destroy()` ran
 * can still be delivered afterward on a real event loop, and "input must
 * not reach Steel after hand-back" should not depend on that ordering
 * accident.
 */
export function relayBrowserTakeover(
  runId: string,
  downstream: Socket,
  upstream: UpstreamConnection,
  onInputForwarded: ((event: BrowserTakeoverInputForwardedEvent) => void) | undefined,
): void {
  let closed = false;
  function teardown(): void {
    if (closed) return;
    closed = true;
    // `.destroy()`, not `.end()`: once relayed, WS-upgraded sockets fall
    // outside the HTTP server's own connection bookkeeping (mirrors
    // `liveAgent.routes.ts`'s own documented reasoning), so this relay
    // owns the socket's full lifecycle from here on.
    try {
      downstream.destroy();
    } catch {
      // Already closed.
    }
    upstream.close();
  }

  const downstreamReader = new FrameReader();
  downstream.on("data", (chunk: Buffer) => {
    if (closed) return;
    let frames: DecodedFrame[];
    try {
      frames = downstreamReader.push(chunk);
    } catch {
      teardown();
      return;
    }
    for (const frame of frames) {
      if (closed) return;
      if (frame.opcode === OPCODE_CLOSE) {
        teardown();
        return;
      }
      if (frame.opcode === OPCODE_PING) {
        try {
          downstream.write(encodeFrame(OPCODE_PONG, frame.payload, false));
        } catch {
          teardown();
          return;
        }
        continue;
      }
      if (frame.opcode === OPCODE_PONG) continue;
      // The entire point of this function: a genuine CDP command/input
      // frame is forwarded upstream to Steel, masked as a real
      // client->server WS frame requires, and the liveness event fires
      // only once the write itself has been issued — never speculatively
      // before it.
      try {
        upstream.socket.write(encodeFrame(frame.opcode === OPCODE_CONTINUATION ? OPCODE_BINARY : frame.opcode, frame.payload, true));
        onInputForwarded?.({ runId, opcode: frame.opcode, byteLength: frame.payload.length });
      } catch {
        teardown();
        return;
      }
    }
  });
  downstream.on("error", teardown);
  downstream.on("close", teardown);

  const upstreamReader = new FrameReader();
  function handleUpstreamChunk(chunk: Buffer): void {
    let frames: DecodedFrame[];
    try {
      frames = upstreamReader.push(chunk);
    } catch {
      teardown();
      return;
    }
    for (const frame of frames) {
      if (frame.opcode === OPCODE_CLOSE) {
        teardown();
        return;
      }
      if (frame.opcode === OPCODE_PING) {
        try {
          upstream.socket.write(encodeFrame(OPCODE_PONG, frame.payload, true));
        } catch {
          teardown();
          return;
        }
        continue;
      }
      if (frame.opcode === OPCODE_PONG) continue;
      try {
        downstream.write(encodeFrame(frame.opcode === OPCODE_CONTINUATION ? OPCODE_BINARY : frame.opcode, frame.payload, false));
      } catch {
        teardown();
        return;
      }
    }
  }
  if (upstream.initialBuffer.length > 0) handleUpstreamChunk(upstream.initialBuffer);
  upstream.socket.on("data", handleUpstreamChunk);
  upstream.socket.on("error", teardown);
  upstream.socket.on("close", teardown);
}

/**
 * TASK-286 — periodic re-validation of the session that authenticated this
 * WebSocket connection, mirroring `app.ts`'s own `sessionStillValid`
 * pattern (TASK-259, SSE) and `liveAgent.routes.ts`'s identical fix for
 * its own two WS routes. A WS upgrade has no existing periodic timer of
 * its own to piggyback re-validation on, so this starts a dedicated one
 * once the connection is live, and force-closes both legs of the relay
 * (`.destroy()`, not `.end()` — mirrors `relayBrowserTakeover`'s own
 * reasoning: a WS-upgraded socket falls outside Node's HTTP connection
 * bookkeeping) the moment the originating session is no longer valid. A
 * bearer-token connection has no session to expire — `sessionToken` is
 * `undefined` in that case and this is a no-op.
 *
 * Deliberately does NOT check the server's session-REVOCATION store
 * (explicit logout): that store (`revokedSessionTokens`, created once in
 * `app.ts`) is not threaded through `RegisterBrowserTakeoverRoutesOptions`
 * today, and wiring it would mean editing `app.ts`'s call site — outside
 * this task's `Owned_Paths`. Flagged in the dossier for ORCH, same as
 * `liveAgent.routes.ts`'s identical note.
 */
function startSessionRevalidation(
  sessionToken: string | undefined,
  authToken: string,
  socket: Socket,
  upstream: UpstreamConnection,
  intervalMs: number,
): void {
  if (sessionToken === undefined) return;
  const timer: ReturnType<typeof setInterval> = setInterval(() => {
    if (verifySessionPrincipal(authToken, sessionToken) !== undefined) return;
    clearInterval(timer);
    try {
      socket.destroy();
    } catch {
      // Already closed.
    }
    upstream.close();
  }, intervalMs);
  socket.on("close", () => clearInterval(timer));
}

/**
 * Handles one `GET /runs/:id/browser-takeover` upgrade attempt: auth,
 * the connect-time pending gate (file header point 2), CDP endpoint
 * resolution, upstream dial, then hands off to {@link relayBrowserTakeover}.
 */
async function handleBrowserTakeoverUpgrade(
  req: IncomingMessage,
  socket: Socket,
  authToken: string,
  browserTakeover: BrowserTakeoverPort | undefined,
  takeoverStatus: TakeoverStatusPort | undefined,
  dialUpstream: (endpoint: BrowserTakeoverEndpoint) => Promise<UpstreamConnection>,
  onInputForwarded: ((event: BrowserTakeoverInputForwardedEvent) => void) | undefined,
  sessionRevalidationIntervalMs: number,
): Promise<void> {
  const url = new URL(req.url ?? "", "http://browser-takeover.internal");
  const match = BROWSER_TAKEOVER_PATH_PATTERN.exec(url.pathname);
  if (match === null) {
    // Not our route: nothing else in this app handles 'upgrade' at this
    // path, so this mirrors Fastify's own unhandled-route behaviour
    // (destroy, no leak).
    socket.destroy();
    return;
  }
  if ((req.headers.upgrade ?? "").toLowerCase() !== "websocket") {
    writeRawResponseAndDestroy(socket, 400, "Bad Request");
    return;
  }
  const runId = decodeURIComponent(match[1]!);

  const principal = authenticate({ authorization: req.headers.authorization, cookie: req.headers.cookie }, authToken);
  if (principal === undefined) {
    writeRawResponseAndDestroy(socket, 401, "Unauthorized");
    return;
  }

  if (browserTakeover === undefined) {
    writeRawResponseAndDestroy(socket, 501, "Not Implemented");
    return;
  }

  if (takeoverStatus !== undefined) {
    let status: { readonly pending: boolean } | null;
    try {
      status = await takeoverStatus.getStatus(runId);
    } catch {
      writeRawResponseAndDestroy(socket, 502, "Bad Gateway");
      return;
    }
    if (status === null) {
      writeRawResponseAndDestroy(socket, 404, "Not Found");
      return;
    }
    if (!status.pending) {
      writeRawResponseAndDestroy(socket, 409, "Conflict");
      return;
    }
  }

  let endpoint: BrowserTakeoverEndpoint | null;
  try {
    endpoint = await browserTakeover.getCdpEndpoint(runId, principal.tenantId);
  } catch {
    writeRawResponseAndDestroy(socket, 502, "Bad Gateway");
    return;
  }
  if (endpoint === null) {
    writeRawResponseAndDestroy(socket, 404, "Not Found");
    return;
  }

  let upstream: UpstreamConnection;
  try {
    upstream = await dialUpstream(endpoint);
  } catch {
    writeRawResponseAndDestroy(socket, 502, "Bad Gateway");
    return;
  }

  if (!acceptUpgrade(req, socket)) {
    upstream.close();
    socket.destroy();
    return;
  }

  relayBrowserTakeover(runId, socket, upstream, onInputForwarded);
  const sessionToken = parseCookieHeader(req.headers.cookie)[SESSION_COOKIE_NAME];
  startSessionRevalidation(sessionToken, authToken, socket, upstream, sessionRevalidationIntervalMs);
}

/** Registers the raw browser-takeover WS upgrade handler onto `app`. */
export function registerBrowserTakeoverRoutes(app: FastifyInstance, options: RegisterBrowserTakeoverRoutesOptions): void {
  const {
    authToken,
    browserTakeover,
    takeoverStatus,
    dialUpstream = defaultDialUpstream,
    onInputForwarded,
    sessionRevalidationIntervalMs = 15000,
  } = options;

  app.server.on("upgrade", (req: IncomingMessage, socket: Socket, _head: Buffer) => {
    const pathname = new URL(req.url ?? "", "http://browser-takeover.internal").pathname;
    if (!BROWSER_TAKEOVER_PATH_PATTERN.test(pathname)) return;
    const onSocketError = (): void => {
      try {
        socket.destroy();
      } catch {
        // Already destroyed.
      }
    };
    handleBrowserTakeoverUpgrade(
      req,
      socket,
      authToken,
      browserTakeover,
      takeoverStatus,
      dialUpstream,
      onInputForwarded,
      sessionRevalidationIntervalMs,
    ).catch(onSocketError);
  });
}
