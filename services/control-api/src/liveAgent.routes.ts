/**
 * TASK-171 — mobile live-agent PTY viewer.
 *
 * Backend half of the Grok-Bot-reference "live agent monitor" view: a
 * role's chat header icon opens a read-only stream of whatever its most
 * recent/active OpenSandbox sandbox is doing, sourced from execd's PTY
 * viewer mode (`/pty/{id}/ws?mode=viewer&since=0` — see
 * `docs/research/opensandbox-exec-api-gap-2026-09-05.md` §Resolution).
 *
 * Two routes:
 *   - `GET /roles/:roleId/live-agent/status` — plain Fastify route (goes
 *     through the normal auth preHandler). Answers whether there is
 *     anything to view right now, so the mobile client can render the
 *     empty state without ever opening a socket.
 *   - `GET /roles/:roleId/live-agent/pty` — a raw WebSocket upgrade,
 *     hand-rolled against `node:http`/`node:net`/`node:crypto` only
 *     (RFC 6455 framing). No `ws` / `@fastify/websocket` dependency: both
 *     would require editing `services/control-api/package.json`, which is
 *     outside this task's `Owned_Paths` — see the dossier for the
 *     ownership-conflict note this avoided.
 *
 * Security property (AC1): the viewer connection can genuinely never
 * inject input into the sandbox. This is enforced *mechanically* here,
 * independent of whatever execd's own `mode=viewer` does server-side
 * (defense in depth against "view-only that secretly accepts input" per
 * the task's own skepticism): `relay()` below never forwards a single
 * byte of a downstream (mobile-client) DATA frame upstream to execd — it
 * decodes every downstream frame, and for anything that is not a
 * control frame (ping/pong/close) it calls `onInputDiscarded` and drops
 * the payload on the floor. `onInputDiscarded` is the CLAUDE.md-mandated
 * liveness assertion: a control that never fires is indistinguishable
 * from one that was never wired up, so the test suite asserts the
 * callback actually fires when a viewer sends data, not just that the
 * upstream never receives it.
 *
 * Real production wiring of `LiveAgentPort` (querying `role_sandboxes`
 * via `@oikonomos/db` and resolving the execd endpoint via
 * `@oikonomos/sandbox-client`) is deliberately left to a follow-up task:
 * `services/control-api/src/ports.ts` and `src/index.ts` are both outside
 * this task's `Owned_Paths` (mirrors TASK-179's `ThreadContextPort`
 * precedent in `app.ts` — route logic lands in-territory now, production
 * wiring is real, valuable follow-up work). Left `undefined` in
 * production until that task exists; both routes answer `501`/refuse the
 * upgrade rather than fabricating state when it is absent.
 *
 * TASK-228 (G-07 part 2) — a THIRD route added later, `GET
 * /roles/:roleId/live-agent/takeover`: the write-capable counterpart to
 * the viewer above, for genuinely interactive human take-over (typing a
 * password, a 2FA code, solving a CAPTCHA — ADR-010's enforced set,
 * never typed by the model). Deliberately a SEPARATE code path from
 * `relay()`/`handleUpgrade()` above rather than a mode flag threaded
 * through them: the viewer's entire reason to exist is that input is
 * mechanically, unconditionally impossible on it, and a shared function
 * with a "except when this flag is true" branch is exactly the shape of
 * bug that turns a hard guarantee into a soft one. Two independently
 * simple functions, each easy to audit for what it does and does not
 * forward, is safer than one function doing both jobs.
 *
 * Security property (the AC1 mirror image): `relayTakeover()` DOES
 * forward downstream DATA frames upstream — that is the entire point —
 * but only ever for the duration of one already-authenticated,
 * already-sandbox-resolved connection; there is no state that lets input
 * reach execd before this function is entered or after its socket is
 * torn down. `onInputForwarded` is this control's own CLAUDE.md-mandated
 * liveness assertion, proving forwarding genuinely happens rather than
 * merely being coded to.
 *
 * Execd contract (confirmed against upstream source,
 * `alibaba/OpenSandbox`'s `components/execd/pkg/web/controller/pty_ws.go`
 * — see TASK-188/TASK-228's own research trail in PLAN.md): the PTY
 * websocket defaults to an exclusive, write-capable "holder" mode; a new
 * connection passing `takeover=1` evicts the current holder and becomes
 * the new one. `getPtyTakeoverEndpoint` below requests exactly that
 * (`mode=holder&takeover=1`), never `mode=viewer`.
 */
import { randomBytes, createHash } from "node:crypto";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Socket } from "node:net";

import type { FastifyInstance } from "fastify";

import { authenticate } from "./auth.js";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const PTY_PATH_PATTERN = /^\/roles\/([^/]+)\/live-agent\/pty$/;
const TAKEOVER_PATH_PATTERN = /^\/roles\/([^/]+)\/live-agent\/takeover$/;

// WebSocket opcodes (RFC 6455 §5.2).
const OPCODE_CONTINUATION = 0x0;
const OPCODE_TEXT = 0x1;
const OPCODE_BINARY = 0x2;
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xa;

/** A role's currently-relevant sandbox, as far as the live-agent viewer cares. */
export interface LiveAgentSandboxRef {
  readonly sandboxId: string;
  readonly state: string;
}

/** A fully-resolved, fully-authenticated execd PTY-viewer WebSocket endpoint. */
export interface LiveAgentExecdEndpoint {
  /** Full `ws://` or `wss://` URL, already including `/pty/{id}/ws?mode=viewer&since=0` and routed via the lifecycle server's proxy (never the sandbox's directly-published port). */
  readonly url: string;
  /** Headers required to authenticate to execd/the lifecycle proxy — resolved by the port implementation; this file never reads or logs a secret. */
  readonly headers?: Readonly<Record<string, string>>;
}

/** Port this route depends on. Production wiring is a follow-up task (see file header). */
export interface LiveAgentPort {
  /** Resolve a role's active or most-recent sandbox, tenant-scoped. Null = nothing to show (empty state), never a thrown 404. */
  getActiveSandbox(roleId: string, tenantId: string): Promise<LiveAgentSandboxRef | null>;
  /** Resolve the execd PTY-viewer endpoint for a sandbox. */
  getPtyViewerEndpoint(sandboxId: string): Promise<LiveAgentExecdEndpoint>;
  /**
   * TASK-228 — resolve the execd PTY-HOLDER (write-capable, `takeover=1`)
   * endpoint for a sandbox. Optional: a `LiveAgentPort` implementation
   * that only ever supports the read-only viewer (e.g. an older port,
   * or a deliberately view-only deployment) simply omits this, and the
   * takeover route 501s exactly like the viewer route does when
   * `liveAgent` itself is absent.
   */
  getPtyTakeoverEndpoint?(sandboxId: string): Promise<LiveAgentExecdEndpoint>;
}

/** Fired every time a viewer-mode connection attempts to send data — the AC1 liveness assertion. */
export interface LiveAgentInputDiscardedEvent {
  readonly roleId: string;
  readonly sandboxId: string;
  readonly opcode: number;
  readonly byteLength: number;
}

/** TASK-228 — fired every time a takeover-mode connection's input is genuinely forwarded upstream to execd. The mirror-image liveness assertion to {@link LiveAgentInputDiscardedEvent}. */
export interface LiveAgentInputForwardedEvent {
  readonly roleId: string;
  readonly sandboxId: string;
  readonly opcode: number;
  readonly byteLength: number;
}

/** The upstream (execd) side of a relay, already past the WS handshake. */
export interface UpstreamConnection {
  readonly socket: Socket;
  /** Any bytes execd sent immediately after the 101 response, before we attached a 'data' listener. */
  readonly initialBuffer: Buffer;
  close(): void;
}

export interface RegisterLiveAgentRoutesOptions {
  readonly authToken: string;
  readonly liveAgent?: LiveAgentPort;
  /** Injectable so tests never dial a real socket. Defaults to a real HTTP Upgrade dial against `endpoint.url`. */
  readonly dialUpstream?: (endpoint: LiveAgentExecdEndpoint) => Promise<UpstreamConnection>;
  readonly onInputDiscarded?: (event: LiveAgentInputDiscardedEvent) => void;
  /** TASK-228 — fires when a takeover connection's input genuinely reaches execd. */
  readonly onInputForwarded?: (event: LiveAgentInputForwardedEvent) => void;
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
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("live-agent PTY frame exceeds safe length");
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

/** Real dial: an HTTP Upgrade request to execd's PTY-viewer endpoint, carrying whatever auth headers the port resolved. No `ws` dependency — `node:http`'s client supports the Upgrade handshake natively via the `'upgrade'` event. */
export function defaultDialUpstream(endpoint: LiveAgentExecdEndpoint): Promise<UpstreamConnection> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(endpoint.url);
    } catch {
      reject(new Error("live-agent execd endpoint was not a valid URL"));
      return;
    }
    if (url.protocol !== "ws:" && url.protocol !== "wss:") {
      reject(new Error("live-agent execd endpoint must be ws:// or wss://"));
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
        reject(new Error(`execd PTY viewer upgrade returned unexpected status ${String(res.statusCode)}`));
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
      reject(new Error(`execd did not upgrade the PTY viewer connection (status ${String(res.statusCode)})`));
    });
    req.on("error", (error) => reject(error instanceof Error ? error : new Error(String(error))));
    req.end();
  });
}

/**
 * Bidirectionally relays frames between the mobile viewer and execd, with
 * one direction mechanically disabled: downstream (viewer) DATA frames
 * are never forwarded upstream — see file header. Control frames
 * (ping/pong/close) are answered locally rather than forwarded, since
 * the viewer and execd are logically independent WS peers, not a
 * transparent pipe.
 */
export function relay(
  roleId: string,
  sandboxId: string,
  downstream: Socket,
  upstream: UpstreamConnection,
  onInputDiscarded: ((event: LiveAgentInputDiscardedEvent) => void) | undefined,
): void {
  let closed = false;
  function teardown(): void {
    if (closed) return;
    closed = true;
    // `.destroy()`, not `.end()`: once relayed, WS-upgraded sockets fall
    // outside the HTTP server's own connection bookkeeping (Node's
    // `server.closeAllConnections()` does not reach them), so a graceful
    // half-close can leave the socket lingering indefinitely. This relay
    // owns the socket's full lifecycle from here on, so destroying it
    // outright is correct, not just expedient.
    try {
      downstream.destroy();
    } catch {
      // Already closed.
    }
    upstream.close();
  }

  const downstreamReader = new FrameReader();
  downstream.on("data", (chunk: Buffer) => {
    let frames: DecodedFrame[];
    try {
      frames = downstreamReader.push(chunk);
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
          downstream.write(encodeFrame(OPCODE_PONG, frame.payload, false));
        } catch {
          teardown();
          return;
        }
        continue;
      }
      if (frame.opcode === OPCODE_PONG) continue;
      // OPCODE_TEXT / OPCODE_BINARY / OPCODE_CONTINUATION: a genuine
      // attempt to send input. Deliberately never forwarded upstream.
      onInputDiscarded?.({ roleId, sandboxId, opcode: frame.opcode, byteLength: frame.payload.length });
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
 * TASK-228 — the write-capable mirror of {@link relay}: downstream (the
 * human's mobile client) DATA frames genuinely go upstream to execd. See
 * this file's header for why this is a separate function from `relay`
 * rather than a mode flag on it.
 *
 * There is no window where input can reach execd outside this function's
 * own lifetime: `handleUpgrade`/`handleTakeoverUpgrade` only calls this
 * after authentication and the upstream dial both already succeeded.
 * `closed` is checked explicitly at the top of the downstream handler
 * below — deliberately NOT relying only on a destroyed `Socket`'s
 * `.write()` throwing as the sole backstop. That throw is real and does
 * still happen (the `try/catch` around the forward keeps it as a second,
 * independent line of defense), but a data event that was already queued
 * before `.destroy()` ran can still be delivered afterward on a real
 * event loop, and a security-relevant "input must not reach execd after
 * hand-back" guarantee should not depend on that ordering accident —
 * caught for real by this function's own test suite, which models a
 * fake socket that (correctly, per Node's real `net.Socket` semantics)
 * would otherwise let a post-close write silently "succeed" against it.
 */
export function relayTakeover(
  roleId: string,
  sandboxId: string,
  downstream: Socket,
  upstream: UpstreamConnection,
  onInputForwarded: ((event: LiveAgentInputForwardedEvent) => void) | undefined,
): void {
  let closed = false;
  function teardown(): void {
    if (closed) return;
    closed = true;
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
      // The entire point of this function: a genuine input frame is
      // forwarded upstream, masked as a real client->server WS frame
      // requires, and the liveness event fires only once the write
      // itself has been issued — never speculatively before it.
      try {
        upstream.socket.write(encodeFrame(frame.opcode === OPCODE_CONTINUATION ? OPCODE_BINARY : frame.opcode, frame.payload, true));
        onInputForwarded?.({ roleId, sandboxId, opcode: frame.opcode, byteLength: frame.payload.length });
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
 * Shared prefix for both the viewer and takeover upgrade paths: auth,
 * `liveAgent` presence, and sandbox resolution are identical for either
 * — only which execd endpoint gets resolved and which relay function
 * runs afterward differ. Returns `undefined` once it has already
 * responded (refused/errored) so the caller knows not to proceed.
 */
async function authenticateAndResolveSandbox(
  req: IncomingMessage,
  socket: Socket,
  authToken: string,
  liveAgent: LiveAgentPort | undefined,
  roleId: string,
): Promise<{ readonly sandbox: LiveAgentSandboxRef } | undefined> {
  const principal = authenticate({ authorization: req.headers.authorization, cookie: req.headers.cookie }, authToken);
  if (principal === undefined) {
    writeRawResponseAndDestroy(socket, 401, "Unauthorized");
    return undefined;
  }

  if (liveAgent === undefined) {
    writeRawResponseAndDestroy(socket, 501, "Not Implemented");
    return undefined;
  }

  let sandbox: LiveAgentSandboxRef | null;
  try {
    sandbox = await liveAgent.getActiveSandbox(roleId, principal.tenantId);
  } catch {
    writeRawResponseAndDestroy(socket, 502, "Bad Gateway");
    return undefined;
  }
  if (sandbox === null) {
    // Empty state: no active/recent sandboxed run. The mobile client is
    // expected to check GET /live-agent/status first and never open this
    // socket in that case, but refuse cleanly regardless.
    writeRawResponseAndDestroy(socket, 404, "Not Found");
    return undefined;
  }
  return { sandbox };
}

async function handleUpgrade(
  req: IncomingMessage,
  socket: Socket,
  authToken: string,
  liveAgent: LiveAgentPort | undefined,
  dialUpstream: (endpoint: LiveAgentExecdEndpoint) => Promise<UpstreamConnection>,
  onInputDiscarded: ((event: LiveAgentInputDiscardedEvent) => void) | undefined,
): Promise<void> {
  const url = new URL(req.url ?? "", "http://live-agent.internal");
  const match = PTY_PATH_PATTERN.exec(url.pathname);
  if (match === null) {
    // Not our route: nothing else in this app handles 'upgrade', so this
    // mirrors Fastify's own unhandled-route behaviour (destroy, no leak).
    socket.destroy();
    return;
  }
  if ((req.headers.upgrade ?? "").toLowerCase() !== "websocket") {
    writeRawResponseAndDestroy(socket, 400, "Bad Request");
    return;
  }
  const roleId = decodeURIComponent(match[1]!);

  const resolved = await authenticateAndResolveSandbox(req, socket, authToken, liveAgent, roleId);
  if (resolved === undefined) return;
  const { sandbox } = resolved;

  let endpoint: LiveAgentExecdEndpoint;
  try {
    endpoint = await liveAgent!.getPtyViewerEndpoint(sandbox.sandboxId);
  } catch {
    writeRawResponseAndDestroy(socket, 502, "Bad Gateway");
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

  relay(roleId, sandbox.sandboxId, socket, upstream, onInputDiscarded);
}

/**
 * TASK-228 — the write-capable counterpart to {@link handleUpgrade}.
 * Refuses (`501`) exactly like the viewer does when `liveAgent` itself
 * is absent, and additionally (also `501`) when the configured
 * `LiveAgentPort` supports the read-only viewer but not takeover —
 * `getPtyTakeoverEndpoint` is optional on the port precisely so an
 * older or deliberately view-only deployment can decline this without
 * throwing.
 */
async function handleTakeoverUpgrade(
  req: IncomingMessage,
  socket: Socket,
  authToken: string,
  liveAgent: LiveAgentPort | undefined,
  dialUpstream: (endpoint: LiveAgentExecdEndpoint) => Promise<UpstreamConnection>,
  onInputForwarded: ((event: LiveAgentInputForwardedEvent) => void) | undefined,
): Promise<void> {
  const url = new URL(req.url ?? "", "http://live-agent.internal");
  const match = TAKEOVER_PATH_PATTERN.exec(url.pathname);
  if (match === null) {
    socket.destroy();
    return;
  }
  if ((req.headers.upgrade ?? "").toLowerCase() !== "websocket") {
    writeRawResponseAndDestroy(socket, 400, "Bad Request");
    return;
  }
  const roleId = decodeURIComponent(match[1]!);

  const resolved = await authenticateAndResolveSandbox(req, socket, authToken, liveAgent, roleId);
  if (resolved === undefined) return;
  const { sandbox } = resolved;

  if (liveAgent!.getPtyTakeoverEndpoint === undefined) {
    writeRawResponseAndDestroy(socket, 501, "Not Implemented");
    return;
  }

  let endpoint: LiveAgentExecdEndpoint;
  try {
    endpoint = await liveAgent!.getPtyTakeoverEndpoint(sandbox.sandboxId);
  } catch {
    writeRawResponseAndDestroy(socket, 502, "Bad Gateway");
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

  relayTakeover(roleId, sandbox.sandboxId, socket, upstream, onInputForwarded);
}

/** Registers the live-agent status route and the raw PTY-viewer/takeover WS upgrade handlers onto `app`. */
export function registerLiveAgentRoutes(app: FastifyInstance, options: RegisterLiveAgentRoutesOptions): void {
  const { authToken, liveAgent, dialUpstream = defaultDialUpstream, onInputDiscarded, onInputForwarded } = options;

  app.get("/roles/:roleId/live-agent/status", async (request, reply) => {
    if (liveAgent === undefined) {
      await reply.code(501).send({ error: "live-agent viewer is not configured on this server" });
      return;
    }
    const { roleId } = request.params as { roleId: string };
    const sandbox = await liveAgent.getActiveSandbox(roleId, request.tenantId);
    if (sandbox === null) {
      await reply.send({ available: false });
      return;
    }
    await reply.send({ available: true, state: sandbox.state });
  });

  app.server.on("upgrade", (req: IncomingMessage, socket: Socket, _head: Buffer) => {
    const pathname = new URL(req.url ?? "", "http://live-agent.internal").pathname;
    const onSocketError = (): void => {
      try {
        socket.destroy();
      } catch {
        // Already destroyed.
      }
    };
    if (TAKEOVER_PATH_PATTERN.test(pathname)) {
      handleTakeoverUpgrade(req, socket, authToken, liveAgent, dialUpstream, onInputForwarded).catch(onSocketError);
      return;
    }
    handleUpgrade(req, socket, authToken, liveAgent, dialUpstream, onInputDiscarded).catch(onSocketError);
  });
}
