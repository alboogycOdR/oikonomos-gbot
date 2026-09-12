import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, Socket, type Server } from "node:net";
import { fileURLToPath } from "node:url";

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRole, upsertRoleSandbox, type DatabaseOptions } from "@oikonomos/db";
import type { FetchLike } from "@oikonomos/sandbox-client";

import {
  FrameReader,
  encodeFrame,
  defaultDialUpstream,
  relay,
  relayTakeover,
  registerLiveAgentRoutes,
  type LiveAgentInputDiscardedEvent,
  type LiveAgentInputForwardedEvent,
  type LiveAgentPort,
  type LiveAgentSandboxRef,
  type UpstreamConnection,
} from "./liveAgent.routes.js";
import { createDatabaseBackedLiveAgent } from "./ports.js";

const TOKEN = "task-171-fixture-token";
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const OPCODE_TEXT = 0x1;
const OPCODE_BINARY = 0x2;

function authHeaders(): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}` };
}

// ---------------------------------------------------------------------------
// Frame codec round-trip
// ---------------------------------------------------------------------------

describe("encodeFrame / FrameReader", () => {
  it("round-trips an unmasked (server->client) text frame", () => {
    const payload = Buffer.from("hello from execd");
    const encoded = encodeFrame(OPCODE_TEXT, payload, false);
    const reader = new FrameReader();
    const frames = reader.push(encoded);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.opcode).toBe(OPCODE_TEXT);
    expect(frames[0]!.payload.toString()).toBe("hello from execd");
  });

  it("round-trips a masked (client->server) binary frame", () => {
    const payload = Buffer.from([1, 2, 3, 4, 250, 251, 252]);
    const encoded = encodeFrame(OPCODE_BINARY, payload, true);
    // The mask bit must actually be set — otherwise this "round-trip" would
    // pass even if masking were silently broken.
    expect(encoded[1]! & 0x80).toBe(0x80);
    const reader = new FrameReader();
    const frames = reader.push(encoded);
    expect(frames).toHaveLength(1);
    expect(Buffer.compare(frames[0]!.payload, payload)).toBe(0);
  });

  it("handles a frame split across multiple chunks", () => {
    const payload = Buffer.from("x".repeat(500));
    const encoded = encodeFrame(OPCODE_TEXT, payload, false);
    const reader = new FrameReader();
    expect(reader.push(encoded.subarray(0, 3))).toHaveLength(0);
    expect(reader.push(encoded.subarray(3, 10))).toHaveLength(0);
    const frames = reader.push(encoded.subarray(10));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.payload.length).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// relay(): the AC1 security property, tested directly against fake sockets
// ---------------------------------------------------------------------------

class FakeSocket {
  readonly written: Buffer[] = [];
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  on(event: string, handler: (...args: unknown[]) => void): this {
    const list = this.listeners.get(event) ?? [];
    list.push(handler);
    this.listeners.set(event, list);
    return this;
  }
  write(chunk: Buffer | string): boolean {
    this.written.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return true;
  }
  end(): void {
    this.emit("close");
  }
  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.listeners.get(event) ?? []) handler(...args);
  }
}

function decodeAll(chunks: Buffer[]): ReturnType<FrameReader["push"]> {
  const reader = new FrameReader();
  const frames: ReturnType<FrameReader["push"]> = [];
  for (const chunk of chunks) frames.push(...reader.push(chunk));
  return frames;
}

describe("relay() — viewer-mode input cannot reach the sandbox", () => {
  it("never forwards a downstream (viewer) data frame upstream, and reports it via onInputDiscarded", () => {
    const downstream = new FakeSocket();
    const upstreamSocket = new FakeSocket();
    const discarded: LiveAgentInputDiscardedEvent[] = [];
    const upstream: UpstreamConnection = {
      socket: upstreamSocket as unknown as UpstreamConnection["socket"],
      initialBuffer: Buffer.alloc(0),
      close: vi.fn(),
    };

    relay("bot-1", "sandbox-1", downstream as unknown as Parameters<typeof relay>[2], upstream, (event) => discarded.push(event));

    // The viewer attempts to type a command into the "terminal".
    const injectionAttempt = encodeFrame(OPCODE_TEXT, Buffer.from("rm -rf /"), true);
    downstream.emit("data", injectionAttempt);

    expect(upstreamSocket.written).toHaveLength(0);
    expect(discarded).toHaveLength(1);
    expect(discarded[0]).toMatchObject({ roleId: "bot-1", sandboxId: "sandbox-1", opcode: OPCODE_TEXT, byteLength: 8 });
  });

  it("still forwards genuine execd output downstream to the viewer", () => {
    const downstream = new FakeSocket();
    const upstreamSocket = new FakeSocket();
    const upstream: UpstreamConnection = {
      socket: upstreamSocket as unknown as UpstreamConnection["socket"],
      initialBuffer: Buffer.alloc(0),
      close: vi.fn(),
    };

    relay("bot-1", "sandbox-1", downstream as unknown as Parameters<typeof relay>[2], upstream, undefined);

    const execdOutput = encodeFrame(OPCODE_TEXT, Buffer.from("$ ls\nfile.txt\n"), false);
    upstreamSocket.emit("data", execdOutput);

    const frames = decodeAll(downstream.written);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.payload.toString()).toBe("$ ls\nfile.txt\n");
  });

  it("closes both sides when the viewer sends a close frame", () => {
    const downstream = new FakeSocket();
    const upstreamSocket = new FakeSocket();
    const upstream: UpstreamConnection = {
      socket: upstreamSocket as unknown as UpstreamConnection["socket"],
      initialBuffer: Buffer.alloc(0),
      close: vi.fn(),
    };
    relay("bot-1", "sandbox-1", downstream as unknown as Parameters<typeof relay>[2], upstream, undefined);
    downstream.emit("data", encodeFrame(0x8, Buffer.alloc(0), true));
    expect(upstream.close).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// relayTakeover(): TASK-228's write-capable mirror image of relay() above.
// ---------------------------------------------------------------------------

describe("relayTakeover() — genuinely interactive take-over, and only within one connection's lifetime", () => {
  it("genuinely forwards a downstream (human) data frame upstream to execd, and reports it via onInputForwarded", () => {
    const downstream = new FakeSocket();
    const upstreamSocket = new FakeSocket();
    const forwarded: LiveAgentInputForwardedEvent[] = [];
    const upstream: UpstreamConnection = {
      socket: upstreamSocket as unknown as UpstreamConnection["socket"],
      initialBuffer: Buffer.alloc(0),
      close: vi.fn(),
    };

    relayTakeover("bot-1", "sandbox-1", downstream as unknown as Parameters<typeof relayTakeover>[2], upstream, (event) => forwarded.push(event));

    // The human types their 2FA code into the real terminal.
    const humanInput = encodeFrame(OPCODE_TEXT, Buffer.from("123456\n"), true);
    downstream.emit("data", humanInput);

    const upstreamFrames = decodeAll(upstreamSocket.written);
    expect(upstreamFrames).toHaveLength(1);
    expect(upstreamFrames[0]!.payload.toString()).toBe("123456\n");
    // Forwarded to execd MASKED, as a genuine client->server frame must be
    // (RFC 6455 §5.1) — not a byte-for-byte passthrough of the (also
    // masked, but with a different key) downstream frame.
    expect(upstreamSocket.written[0]![1]! & 0x80).toBe(0x80);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toMatchObject({ roleId: "bot-1", sandboxId: "sandbox-1", opcode: OPCODE_TEXT, byteLength: 7 });
  });

  it("still forwards genuine execd output downstream to the human, same as the viewer", () => {
    const downstream = new FakeSocket();
    const upstreamSocket = new FakeSocket();
    const upstream: UpstreamConnection = {
      socket: upstreamSocket as unknown as UpstreamConnection["socket"],
      initialBuffer: Buffer.alloc(0),
      close: vi.fn(),
    };

    relayTakeover("bot-1", "sandbox-1", downstream as unknown as Parameters<typeof relayTakeover>[2], upstream, undefined);

    const execdOutput = encodeFrame(OPCODE_TEXT, Buffer.from("Password: "), false);
    upstreamSocket.emit("data", execdOutput);

    const frames = decodeAll(downstream.written);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.payload.toString()).toBe("Password: ");
  });

  it("stops forwarding the instant either side closes — nothing reaches execd after teardown", () => {
    const downstream = new FakeSocket();
    const upstreamSocket = new FakeSocket();
    const forwarded: LiveAgentInputForwardedEvent[] = [];
    const upstream: UpstreamConnection = {
      socket: upstreamSocket as unknown as UpstreamConnection["socket"],
      initialBuffer: Buffer.alloc(0),
      close: vi.fn(),
    };

    relayTakeover("bot-1", "sandbox-1", downstream as unknown as Parameters<typeof relayTakeover>[2], upstream, (event) => forwarded.push(event));

    // The human closes the session (hands back).
    downstream.emit("data", encodeFrame(0x8, Buffer.alloc(0), true));
    expect(upstream.close).toHaveBeenCalledTimes(1);

    // A frame arriving on the now-torn-down downstream socket (a real
    // duplicate/delayed OS-level delivery is exactly the race this guards
    // against) must not be forwarded — teardown is a one-way door.
    downstream.emit("data", encodeFrame(OPCODE_TEXT, Buffer.from("too late"), true));
    expect(forwarded).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// GET /roles/:roleId/live-agent/status
// ---------------------------------------------------------------------------

describe("GET /roles/:roleId/live-agent/status", () => {
  function buildTestApp(liveAgent: LiveAgentPort | undefined): FastifyInstance {
    const app = Fastify({ logger: false });
    app.decorateRequest("tenantId", "");
    app.addHook("preHandler", async (request, reply) => {
      const auth = request.headers.authorization;
      if (auth !== `Bearer ${TOKEN}`) {
        await reply.code(401).send({ error: "unauthorized" });
        return;
      }
      request.tenantId = "basileia";
    });
    registerLiveAgentRoutes(app, { authToken: TOKEN, liveAgent });
    return app;
  }

  it("returns 501 when no LiveAgentPort is configured", async () => {
    const app = buildTestApp(undefined);
    const response = await app.inject({ method: "GET", url: "/roles/bot-1/live-agent/status", headers: authHeaders() });
    expect(response.statusCode).toBe(501);
  });

  it("returns available:false for a role with no active/recent sandbox (empty state)", async () => {
    const liveAgent: LiveAgentPort = {
      getActiveSandbox: vi.fn().mockResolvedValue(null),
      getPtyViewerEndpoint: vi.fn(),
    };
    const app = buildTestApp(liveAgent);
    const response = await app.inject({ method: "GET", url: "/roles/bot-1/live-agent/status", headers: authHeaders() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ available: false });
  });

  it("returns available:true + state for a role with a live sandbox", async () => {
    const sandbox: LiveAgentSandboxRef = { sandboxId: "sbx-1", state: "Running" };
    const liveAgent: LiveAgentPort = {
      getActiveSandbox: vi.fn().mockResolvedValue(sandbox),
      getPtyViewerEndpoint: vi.fn(),
    };
    const app = buildTestApp(liveAgent);
    const response = await app.inject({ method: "GET", url: "/roles/bot-1/live-agent/status", headers: authHeaders() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ available: true, state: "Running" });
  });

  it("401s an unauthenticated request", async () => {
    const app = buildTestApp({ getActiveSandbox: vi.fn(), getPtyViewerEndpoint: vi.fn() });
    const response = await app.inject({ method: "GET", url: "/roles/bot-1/live-agent/status" });
    expect(response.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /roles/:roleId/live-agent/pty — end-to-end over real loopback TCP
// ---------------------------------------------------------------------------

/** A minimal hand-rolled "execd" fake: accepts one WS upgrade, records every
 * byte received after the handshake (so the test can assert nothing ever
 * arrives), and can push frames to the connected client on demand. */
function startFakeExecd(): Promise<{
  port: number;
  receivedAfterHandshake: Buffer[];
  sendFrame(payload: Buffer): void;
  close(): void;
}> {
  return new Promise((resolve) => {
    const receivedAfterHandshake: Buffer[] = [];
    let clientSocket: Socket | undefined;
    const server: Server = createServer((socket) => {
      let handshakeBuffer = Buffer.alloc(0);
      let handshakeDone = false;
      socket.on("data", (chunk: Buffer) => {
        if (handshakeDone) {
          receivedAfterHandshake.push(chunk);
          return;
        }
        handshakeBuffer = Buffer.concat([handshakeBuffer, chunk]);
        const headerEnd = handshakeBuffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;
        const headerText = handshakeBuffer.subarray(0, headerEnd).toString("latin1");
        const keyMatch = /Sec-WebSocket-Key:\s*(.+)/i.exec(headerText);
        const key = keyMatch?.[1]?.trim() ?? "";
        const acceptKey = createHash("sha1").update(key + WEBSOCKET_GUID).digest("base64");
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
            `Sec-WebSocket-Accept: ${acceptKey}\r\n\r\n`,
        );
        handshakeDone = true;
        clientSocket = socket;
        const rest = handshakeBuffer.subarray(headerEnd + 4);
        if (rest.length > 0) receivedAfterHandshake.push(rest);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({
        port,
        receivedAfterHandshake,
        sendFrame(payload: Buffer): void {
          clientSocket?.write(encodeFrame(OPCODE_TEXT, payload, false));
        },
        close(): void {
          try {
            clientSocket?.destroy();
          } catch {
            // Already destroyed.
          }
          server.close();
        },
      });
    });
  });
}

/** A minimal hand-rolled "mobile viewer" test client: performs the WS
 * handshake over real loopback TCP against the app's own HTTP server. */
function connectViewerClient(port: number, path: string, headers: Record<string, string>): Promise<{
  socket: Socket;
  statusLine: string;
  reader: FrameReader;
  frames: ReturnType<FrameReader["push"]>;
}> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    const reader = new FrameReader();
    const frames: ReturnType<FrameReader["push"]> = [];
    let buffer = Buffer.alloc(0);
    let handshakeDone = false;
    let statusLine = "";
    socket.on("data", (chunk: Buffer) => {
      if (!handshakeDone) {
        buffer = Buffer.concat([buffer, chunk]);
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;
        statusLine = buffer.subarray(0, buffer.indexOf("\r\n")).toString("latin1");
        handshakeDone = true;
        const rest = buffer.subarray(headerEnd + 4);
        if (rest.length > 0) frames.push(...reader.push(rest));
        resolve({ socket, statusLine, reader, frames });
        return;
      }
      frames.push(...reader.push(chunk));
    });
    socket.on("error", reject);
    socket.connect(port, "127.0.0.1", () => {
      const fixtureKeyMaterial = `viewer-fixture-${Math.random().toString(16).slice(2)}`;
      const headerLines = Object.entries({
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": Buffer.from(fixtureKeyMaterial).toString("base64").slice(0, 24),
        ...headers,
      })
        .map(([k, v]) => `${k}: ${v}`)
        .join("\r\n");
      socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\n${headerLines}\r\n\r\n`);
    });
  });
}

describe("GET /roles/:roleId/live-agent/pty — real upgrade + relay over loopback TCP", () => {
  let app: FastifyInstance | undefined;
  let fakeExecd: Awaited<ReturnType<typeof startFakeExecd>> | undefined;
  let acceptedSockets: Socket[] = [];

  /**
   * WS-upgraded sockets are handed off by Node's HTTP layer and fall
   * outside its own connection bookkeeping — `server.closeAllConnections()`
   * silently does not reach them (verified empirically against Node 22;
   * `relay()`'s own `.destroy()` calls handle this for a real client
   * disconnect, but a test needs a deterministic, race-free teardown that
   * doesn't depend on that propagation timing). Track every accepted
   * socket directly and destroy it ourselves before closing the server.
   */
  function trackAcceptedSockets(target: FastifyInstance): void {
    target.server.on("connection", (socket: Socket) => acceptedSockets.push(socket));
  }

  afterEach(async () => {
    for (const socket of acceptedSockets) {
      try {
        socket.destroy();
      } catch {
        // Already destroyed.
      }
    }
    acceptedSockets = [];
    if (app !== undefined) {
      await app.close();
    }
    fakeExecd?.close();
    app = undefined;
    fakeExecd = undefined;
  });

  it("proxies real execd output to the viewer and never forwards viewer input upstream", async () => {
    fakeExecd = await startFakeExecd();
    const sandbox: LiveAgentSandboxRef = { sandboxId: "sbx-1", state: "Running" };
    const liveAgent: LiveAgentPort = {
      getActiveSandbox: vi.fn().mockResolvedValue(sandbox),
      getPtyViewerEndpoint: vi.fn().mockResolvedValue({ url: `ws://127.0.0.1:${fakeExecd.port}/pty/sbx-1/ws?mode=viewer&since=0` }),
    };
    const discarded: LiveAgentInputDiscardedEvent[] = [];

    app = Fastify({ logger: false });
    trackAcceptedSockets(app);
    app.decorateRequest("tenantId", "");
    app.addHook("preHandler", async (request, reply) => {
      if (request.headers.authorization !== `Bearer ${TOKEN}`) {
        await reply.code(401).send({ error: "unauthorized" });
        return;
      }
      request.tenantId = "basileia";
    });
    registerLiveAgentRoutes(app, {
      authToken: TOKEN,
      liveAgent,
      dialUpstream: defaultDialUpstream,
      onInputDiscarded: (event) => discarded.push(event),
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;

    const viewer = await connectViewerClient(port, "/roles/bot-1/live-agent/pty", authHeaders());
    expect(viewer.statusLine).toContain("101");

    // Real execd output must reach the viewer.
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (viewer.frames.length > 0) {
          clearInterval(check);
          resolve();
        }
      }, 5);
      fakeExecd!.sendFrame(Buffer.from("live sandbox output"));
    });
    expect(viewer.frames[0]!.payload.toString()).toBe("live sandbox output");

    // AC1: the viewer attempts to inject input — it must never reach execd.
    viewer.socket.write(encodeFrame(OPCODE_TEXT, Buffer.from("malicious input"), true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fakeExecd.receivedAfterHandshake).toHaveLength(0);
    expect(discarded).toHaveLength(1);
    expect(discarded[0]).toMatchObject({ roleId: "bot-1", sandboxId: "sbx-1" });

    viewer.socket.destroy();
    // Give the relay's teardown (triggered by the server-side socket
    // observing the viewer's disconnect) a moment to run before this test
    // returns — WS-upgraded sockets fall outside Node's own HTTP
    // connection bookkeeping (`server.closeAllConnections()` does not
    // reach them), so `afterEach`'s `app.close()` only completes once the
    // relay itself has destroyed the accepted socket.
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  it("refuses the upgrade (no 101) for a role with no active sandbox — empty state, not a hang", async () => {
    const liveAgent: LiveAgentPort = {
      getActiveSandbox: vi.fn().mockResolvedValue(null),
      getPtyViewerEndpoint: vi.fn(),
    };
    app = Fastify({ logger: false });
    trackAcceptedSockets(app);
    app.decorateRequest("tenantId", "");
    app.addHook("preHandler", async (request, reply) => {
      if (request.headers.authorization !== `Bearer ${TOKEN}`) {
        await reply.code(401).send({ error: "unauthorized" });
        return;
      }
      request.tenantId = "basileia";
    });
    registerLiveAgentRoutes(app, { authToken: TOKEN, liveAgent });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;

    const viewer = await connectViewerClient(port, "/roles/bot-1/live-agent/pty", authHeaders());
    expect(viewer.statusLine).not.toContain("101");
    expect(viewer.statusLine).toContain("404");
  });

  it("refuses the upgrade for an unauthenticated request", async () => {
    const liveAgent: LiveAgentPort = { getActiveSandbox: vi.fn(), getPtyViewerEndpoint: vi.fn() };
    app = Fastify({ logger: false });
    trackAcceptedSockets(app);
    app.decorateRequest("tenantId", "");
    app.addHook("preHandler", async (request, reply) => {
      if (request.headers.authorization !== `Bearer ${TOKEN}`) {
        await reply.code(401).send({ error: "unauthorized" });
        return;
      }
      request.tenantId = "basileia";
    });
    registerLiveAgentRoutes(app, { authToken: TOKEN, liveAgent });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;

    const viewer = await connectViewerClient(port, "/roles/bot-1/live-agent/pty", {});
    expect(viewer.statusLine).toContain("401");
  });
});

// ---------------------------------------------------------------------------
// GET /roles/:roleId/live-agent/takeover — TASK-228, real upgrade + relay
// over loopback TCP, same rig as the viewer's own tests above.
// ---------------------------------------------------------------------------

describe("GET /roles/:roleId/live-agent/takeover — real upgrade + relay over loopback TCP", () => {
  let app: FastifyInstance | undefined;
  let fakeExecd: Awaited<ReturnType<typeof startFakeExecd>> | undefined;
  let acceptedSockets: Socket[] = [];

  function trackAcceptedSockets(target: FastifyInstance): void {
    target.server.on("connection", (socket: Socket) => acceptedSockets.push(socket));
  }

  afterEach(async () => {
    for (const socket of acceptedSockets) {
      try {
        socket.destroy();
      } catch {
        // Already destroyed.
      }
    }
    acceptedSockets = [];
    if (app !== undefined) {
      await app.close();
    }
    fakeExecd?.close();
    app = undefined;
    fakeExecd = undefined;
  });

  it("genuinely relays real human input to execd, and real execd output back to the human", async () => {
    fakeExecd = await startFakeExecd();
    const sandbox: LiveAgentSandboxRef = { sandboxId: "sbx-1", state: "waiting_approval" };
    const liveAgent: LiveAgentPort = {
      getActiveSandbox: vi.fn().mockResolvedValue(sandbox),
      getPtyViewerEndpoint: vi.fn(),
      getPtyTakeoverEndpoint: vi.fn().mockResolvedValue({ url: `ws://127.0.0.1:${fakeExecd.port}/pty/sbx-1/ws?mode=holder&takeover=1` }),
    };
    const forwarded: LiveAgentInputForwardedEvent[] = [];

    app = Fastify({ logger: false });
    trackAcceptedSockets(app);
    app.decorateRequest("tenantId", "");
    app.addHook("preHandler", async (request, reply) => {
      if (request.headers.authorization !== `Bearer ${TOKEN}`) {
        await reply.code(401).send({ error: "unauthorized" });
        return;
      }
      request.tenantId = "basileia";
    });
    registerLiveAgentRoutes(app, {
      authToken: TOKEN,
      liveAgent,
      dialUpstream: defaultDialUpstream,
      onInputForwarded: (event) => forwarded.push(event),
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;

    const human = await connectViewerClient(port, "/roles/bot-1/live-agent/takeover", authHeaders());
    expect(human.statusLine).toContain("101");

    // Real execd output (e.g. a login prompt) must still reach the human.
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (human.frames.length > 0) {
          clearInterval(check);
          resolve();
        }
      }, 5);
      fakeExecd!.sendFrame(Buffer.from("Password: "));
    });
    expect(human.frames[0]!.payload.toString()).toBe("Password: ");

    // The entire point of this route: the human's real keystrokes DO
    // reach execd.
    human.socket.write(encodeFrame(OPCODE_TEXT, Buffer.from("hunter2\n"), true));
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (fakeExecd!.receivedAfterHandshake.length > 0) {
          clearInterval(check);
          resolve();
        }
      }, 5);
    });
    const upstreamFrames = decodeAll(fakeExecd.receivedAfterHandshake);
    expect(upstreamFrames).toHaveLength(1);
    expect(upstreamFrames[0]!.payload.toString()).toBe("hunter2\n");
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toMatchObject({ roleId: "bot-1", sandboxId: "sbx-1" });

    human.socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  it("requests execd's holder+takeover mode, never viewer mode", async () => {
    fakeExecd = await startFakeExecd();
    const sandbox: LiveAgentSandboxRef = { sandboxId: "sbx-1", state: "waiting_approval" };
    const getPtyTakeoverEndpoint = vi.fn().mockResolvedValue({ url: `ws://127.0.0.1:${fakeExecd.port}/pty/sbx-1/ws?mode=holder&takeover=1` });
    const liveAgent: LiveAgentPort = {
      getActiveSandbox: vi.fn().mockResolvedValue(sandbox),
      getPtyViewerEndpoint: vi.fn(),
      getPtyTakeoverEndpoint,
    };
    app = Fastify({ logger: false });
    trackAcceptedSockets(app);
    app.decorateRequest("tenantId", "");
    app.addHook("preHandler", async (request, reply) => {
      request.tenantId = "basileia";
    });
    registerLiveAgentRoutes(app, { authToken: TOKEN, liveAgent, dialUpstream: defaultDialUpstream });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;

    const human = await connectViewerClient(port, "/roles/bot-1/live-agent/takeover", authHeaders());
    expect(human.statusLine).toContain("101");
    expect(getPtyTakeoverEndpoint).toHaveBeenCalledWith("sbx-1");
    // The viewer endpoint must never even be consulted for a takeover request.
    expect(liveAgent.getPtyViewerEndpoint).not.toHaveBeenCalled();

    human.socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  it("501s when the configured LiveAgentPort supports the viewer but not takeover", async () => {
    const sandbox: LiveAgentSandboxRef = { sandboxId: "sbx-1", state: "Running" };
    const liveAgent: LiveAgentPort = {
      getActiveSandbox: vi.fn().mockResolvedValue(sandbox),
      getPtyViewerEndpoint: vi.fn(),
      // getPtyTakeoverEndpoint deliberately omitted.
    };
    app = Fastify({ logger: false });
    trackAcceptedSockets(app);
    app.decorateRequest("tenantId", "");
    app.addHook("preHandler", async (request, reply) => {
      request.tenantId = "basileia";
    });
    registerLiveAgentRoutes(app, { authToken: TOKEN, liveAgent });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;

    const human = await connectViewerClient(port, "/roles/bot-1/live-agent/takeover", authHeaders());
    expect(human.statusLine).not.toContain("101");
    expect(human.statusLine).toContain("501");
  });

  it("refuses the upgrade for an unauthenticated request", async () => {
    const liveAgent: LiveAgentPort = { getActiveSandbox: vi.fn(), getPtyViewerEndpoint: vi.fn(), getPtyTakeoverEndpoint: vi.fn() };
    app = Fastify({ logger: false });
    trackAcceptedSockets(app);
    app.decorateRequest("tenantId", "");
    app.addHook("preHandler", async (request, reply) => {
      if (request.headers.authorization !== `Bearer ${TOKEN}`) {
        await reply.code(401).send({ error: "unauthorized" });
        return;
      }
      request.tenantId = "basileia";
    });
    registerLiveAgentRoutes(app, { authToken: TOKEN, liveAgent });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;

    const human = await connectViewerClient(port, "/roles/bot-1/live-agent/takeover", {});
    expect(human.statusLine).toContain("401");
  });
});

// ---------------------------------------------------------------------------
// TASK-203 — production LiveAgentPort (role_sandboxes + sandbox-client)
// ---------------------------------------------------------------------------

const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;
const FAKE_API_KEY = "test-api-key-not-a-real-secret";
const FAKE_EXECD_TOKEN = "test-execd-token-not-a-real-secret";
const LIFECYCLE_BASE = "http://100.78.70.2:8080";
const PROXY_ENDPOINT = `${LIFECYCLE_BASE}/v1/sandboxes/sbx-live/proxy/44772`;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function cleanupRole(roleId: string): Promise<void> {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: connectionString!, max: 1 });
  try {
    await pool.query("DELETE FROM role_sandboxes WHERE role_id = $1", [roleId]);
    await pool.query("DELETE FROM roles WHERE role_id = $1", [roleId]);
  } finally {
    await pool.end();
  }
}

describe("TASK-203 production LiveAgentPort wiring", () => {
  it("start() constructs the production port (liveness: the factory is not dead code)", () => {
    const source = readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8");
    expect(source).toMatch(/liveAgent:\s*createDatabaseBackedLiveAgent\(dbOptions\)/);
  });

  it("resolves the PTY-viewer URL through the lifecycle proxy and never a published sandbox port", async () => {
    const getEndpoint = vi.fn(async (sandboxId: string, port?: number, useServerProxy?: boolean) => {
      expect(sandboxId).toBe("sbx-live");
      expect(port).toBe(44_772);
      expect(useServerProxy).toBe(true);
      return { endpoint: PROXY_ENDPOINT, headers: { "x-proxy-token": "route-token" } };
    });
    const liveAgent = createDatabaseBackedLiveAgent({
      connectionString: "postgresql://unused.invalid/test",
      sandboxClient: { getEndpoint },
      resolveExecdAccessToken: async () => FAKE_EXECD_TOKEN,
    });

    const endpoint = await liveAgent.getPtyViewerEndpoint("sbx-live");
    expect(getEndpoint).toHaveBeenCalledWith("sbx-live", 44_772, true);
    expect(endpoint.url).toBe(`ws://100.78.70.2:8080/v1/sandboxes/sbx-live/proxy/44772/pty/sbx-live/ws?mode=viewer&since=0`);
    expect(endpoint.url).toContain("/proxy/");
    expect(endpoint.url).not.toMatch(/:30\d{3}\b/);
    expect(endpoint.headers).toEqual({
      "x-proxy-token": "route-token",
      "X-EXECD-ACCESS-TOKEN": FAKE_EXECD_TOKEN,
    });
  });

  it("TASK-228 — resolves the PTY-takeover URL with holder+takeover mode, through the same lifecycle proxy", async () => {
    const getEndpoint = vi.fn(async (sandboxId: string, port?: number, useServerProxy?: boolean) => {
      expect(sandboxId).toBe("sbx-live");
      expect(port).toBe(44_772);
      expect(useServerProxy).toBe(true);
      return { endpoint: PROXY_ENDPOINT, headers: { "x-proxy-token": "route-token" } };
    });
    const liveAgent = createDatabaseBackedLiveAgent({
      connectionString: "postgresql://unused.invalid/test",
      sandboxClient: { getEndpoint },
      resolveExecdAccessToken: async () => FAKE_EXECD_TOKEN,
    });

    const endpoint = await liveAgent.getPtyTakeoverEndpoint!("sbx-live");
    expect(endpoint.url).toBe(`ws://100.78.70.2:8080/v1/sandboxes/sbx-live/proxy/44772/pty/sbx-live/ws?mode=holder&takeover=1`);
    expect(endpoint.url).not.toContain("mode=viewer");
    expect(endpoint.url).toContain("/proxy/");
    expect(endpoint.headers).toEqual({
      "x-proxy-token": "route-token",
      "X-EXECD-ACCESS-TOKEN": FAKE_EXECD_TOKEN,
    });
  });

  it("refuses a directly-published sandbox port even if getEndpoint returns one", async () => {
    const getEndpoint = vi.fn(async () => ({ endpoint: "http://10.0.0.8:30017" }));
    const liveAgent = createDatabaseBackedLiveAgent({
      connectionString: "postgresql://unused.invalid/test",
      sandboxClient: { getEndpoint },
      resolveExecdAccessToken: async () => FAKE_EXECD_TOKEN,
    });
    await expect(liveAgent.getPtyViewerEndpoint("sbx-direct")).rejects.toThrow(/lifecycle server proxy/);
    expect(getEndpoint).toHaveBeenCalledWith("sbx-direct", 44_772, true);
  });

  it("the real sandbox-client request asks for use_server_proxy=true on execd port 44772", async () => {
    const seen: string[] = [];
    const fetchImpl: FetchLike = async (input) => {
      seen.push(String(input));
      return jsonResponse({ endpoint: PROXY_ENDPOINT, headers: { "x-proxy-token": "route-token" } });
    };
    const liveAgent = createDatabaseBackedLiveAgent({
      connectionString: "postgresql://unused.invalid/test",
      sandboxBaseUrl: LIFECYCLE_BASE,
      fetchImpl,
      resolveApiKey: async () => FAKE_API_KEY,
      resolveExecdAccessToken: async () => FAKE_EXECD_TOKEN,
    });

    const endpoint = await liveAgent.getPtyViewerEndpoint("sbx-live");
    expect(seen).toEqual([`${LIFECYCLE_BASE}/v1/sandboxes/sbx-live/endpoints/44772?use_server_proxy=true`]);
    expect(endpoint.url).toBe(`ws://100.78.70.2:8080/v1/sandboxes/sbx-live/proxy/44772/pty/sbx-live/ws?mode=viewer&since=0`);
  });
});

integration("TASK-203 — live Postgres LiveAgentPort", () => {
  const options: DatabaseOptions = { connectionString: connectionString!, poolConfig: { max: 1 } };

  it("resolves a real role_sandboxes row through the production port and the status route", async () => {
    const roleId = `task-203-live-${randomUUID()}`;
    const sandboxId = `sbx-task-203-${randomUUID()}`;
    await createRole(options, {
      roleId,
      name: "TASK-203 live fixture",
      title: "Live agent fixture",
      description: "DATABASE_URL-gated LiveAgentPort fixture.",
    });
    try {
      const liveAgent = createDatabaseBackedLiveAgent(options);
      await expect(liveAgent.getActiveSandbox(roleId, "basileia")).resolves.toBeNull();

      await upsertRoleSandbox(options, {
        roleId,
        sandboxId,
        state: "Running",
        execdTokenRef: "secret://opensandbox/execd_access_token",
      });

      await expect(liveAgent.getActiveSandbox(roleId, "basileia")).resolves.toEqual({
        sandboxId,
        state: "Running",
      });
      await expect(liveAgent.getActiveSandbox(roleId, "other-tenant")).resolves.toBeNull();

      const app = Fastify({ logger: false });
      app.decorateRequest("tenantId", "");
      app.addHook("preHandler", async (request, reply) => {
        if (request.headers.authorization !== `Bearer ${TOKEN}`) {
          await reply.code(401).send({ error: "unauthorized" });
          return;
        }
        request.tenantId = "basileia";
      });
      registerLiveAgentRoutes(app, { authToken: TOKEN, liveAgent });
      try {
        const response = await app.inject({
          method: "GET",
          url: `/roles/${roleId}/live-agent/status`,
          headers: authHeaders(),
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ available: true, state: "Running" });
      } finally {
        await app.close();
      }
    } finally {
      await cleanupRole(roleId);
    }
  });

  it("does not leak another tenant's sandbox as available", async () => {
    const roleId = `task-203-other-${randomUUID()}`;
    await createRole(options, {
      roleId,
      tenantId: "other-tenant",
      name: "TASK-203 other-tenant fixture",
      title: "Other tenant",
      description: "Must never appear as this tenant's live agent.",
    });
    try {
      await upsertRoleSandbox(options, {
        roleId,
        sandboxId: `sbx-other-${randomUUID()}`,
        state: "Running",
        execdTokenRef: "secret://opensandbox/execd_access_token",
      });
      const liveAgent = createDatabaseBackedLiveAgent(options);
      await expect(liveAgent.getActiveSandbox(roleId, "basileia")).resolves.toBeNull();
    } finally {
      await cleanupRole(roleId);
    }
  });
});
