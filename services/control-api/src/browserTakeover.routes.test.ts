import { createHash } from "node:crypto";
import { createServer, Socket, type Server } from "node:net";

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FrameReader,
  encodeFrame,
  defaultDialUpstream,
  relayBrowserTakeover,
  registerBrowserTakeoverRoutes,
  type BrowserTakeoverEndpoint,
  type BrowserTakeoverInputForwardedEvent,
  type BrowserTakeoverPort,
  type TakeoverStatusPort,
  type UpstreamConnection,
} from "./browserTakeover.routes.js";

const TOKEN = "task-235-fixture-token";
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const OPCODE_TEXT = 0x1;
const OPCODE_BINARY = 0x2;
const OPCODE_CLOSE = 0x8;

function authHeaders(): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}` };
}

// ---------------------------------------------------------------------------
// Frame codec round-trip — same RFC 6455 codec as liveAgent.routes.ts, this
// file's own copy (see file header for why it is genuinely separate).
// ---------------------------------------------------------------------------

describe("encodeFrame / FrameReader", () => {
  it("round-trips an unmasked (server->client) text frame", () => {
    const payload = Buffer.from("hello from steel");
    const encoded = encodeFrame(OPCODE_TEXT, payload, false);
    const reader = new FrameReader();
    const frames = reader.push(encoded);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.opcode).toBe(OPCODE_TEXT);
    expect(frames[0]!.payload.toString()).toBe("hello from steel");
  });

  it("round-trips a masked (client->server) binary frame", () => {
    const payload = Buffer.from([1, 2, 3, 4, 250, 251, 252]);
    const encoded = encodeFrame(OPCODE_BINARY, payload, true);
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
// relayBrowserTakeover(): the AC3 "mirror-image liveness proof" — genuinely
// bidirectional, tested directly against fake sockets first.
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

describe("relayBrowserTakeover() — genuinely bidirectional, and only within one connection's lifetime", () => {
  it("genuinely forwards a downstream (human) CDP command frame upstream to Steel, and reports it via onInputForwarded", () => {
    const downstream = new FakeSocket();
    const upstreamSocket = new FakeSocket();
    const forwarded: BrowserTakeoverInputForwardedEvent[] = [];
    const upstream: UpstreamConnection = {
      socket: upstreamSocket as unknown as UpstreamConnection["socket"],
      initialBuffer: Buffer.alloc(0),
      close: vi.fn(),
    };

    relayBrowserTakeover("run-1", downstream as unknown as Parameters<typeof relayBrowserTakeover>[1], upstream, (event) => forwarded.push(event));

    const clickCommand = encodeFrame(OPCODE_TEXT, Buffer.from(JSON.stringify({ id: 1, method: "Input.dispatchMouseEvent" })), true);
    downstream.emit("data", clickCommand);

    const upstreamFrames = decodeAll(upstreamSocket.written);
    expect(upstreamFrames).toHaveLength(1);
    expect(JSON.parse(upstreamFrames[0]!.payload.toString())).toMatchObject({ method: "Input.dispatchMouseEvent" });
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toMatchObject({ runId: "run-1", opcode: OPCODE_TEXT });
  });

  it("genuinely forwards real Steel output (e.g. a screencast frame) back to the human", () => {
    const downstream = new FakeSocket();
    const upstreamSocket = new FakeSocket();
    const upstream: UpstreamConnection = {
      socket: upstreamSocket as unknown as UpstreamConnection["socket"],
      initialBuffer: Buffer.alloc(0),
      close: vi.fn(),
    };

    relayBrowserTakeover("run-1", downstream as unknown as Parameters<typeof relayBrowserTakeover>[1], upstream, undefined);

    const steelEvent = encodeFrame(OPCODE_TEXT, Buffer.from(JSON.stringify({ method: "Page.screencastFrame", params: { data: "base64==" } })), false);
    upstreamSocket.emit("data", steelEvent);

    const frames = decodeAll(downstream.written);
    expect(frames).toHaveLength(1);
    expect(JSON.parse(frames[0]!.payload.toString())).toMatchObject({ method: "Page.screencastFrame" });
  });

  it("closes both sides when either side sends a close frame", () => {
    const downstream = new FakeSocket();
    const upstreamSocket = new FakeSocket();
    const upstream: UpstreamConnection = {
      socket: upstreamSocket as unknown as UpstreamConnection["socket"],
      initialBuffer: Buffer.alloc(0),
      close: vi.fn(),
    };
    relayBrowserTakeover("run-1", downstream as unknown as Parameters<typeof relayBrowserTakeover>[1], upstream, undefined);
    downstream.emit("data", encodeFrame(OPCODE_CLOSE, Buffer.alloc(0), true));
    expect(upstream.close).toHaveBeenCalledTimes(1);
  });

  it("TASK-228-lesson defense-in-depth: stops forwarding the instant teardown runs — nothing reaches Steel after hand-back, even from a data event queued before close", () => {
    const downstream = new FakeSocket();
    const upstreamSocket = new FakeSocket();
    const forwarded: BrowserTakeoverInputForwardedEvent[] = [];
    const upstream: UpstreamConnection = {
      socket: upstreamSocket as unknown as UpstreamConnection["socket"],
      initialBuffer: Buffer.alloc(0),
      close: vi.fn(),
    };
    relayBrowserTakeover("run-1", downstream as unknown as Parameters<typeof relayBrowserTakeover>[1], upstream, (event) => forwarded.push(event));

    // Simulate teardown already having run (e.g. the close frame arrived
    // first in the same tick a queued data event is then delivered).
    downstream.emit("data", encodeFrame(OPCODE_CLOSE, Buffer.alloc(0), true));
    const staleInput = encodeFrame(OPCODE_TEXT, Buffer.from(JSON.stringify({ method: "Input.dispatchKeyEvent" })), true);
    downstream.emit("data", staleInput);

    expect(forwarded).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// GET /runs/:id/browser-takeover — real upgrade + relay over loopback TCP,
// mirroring liveAgent.routes.test.ts's own rig for its takeover route.
// ---------------------------------------------------------------------------

function startFakeSteel(): Promise<{
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

/** A minimal hand-rolled "mobile client" test rig: performs the WS handshake over real loopback TCP against the app's own HTTP server. */
function connectHumanClient(port: number, path: string, headers: Record<string, string>): Promise<{
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
      const fixtureKeyMaterial = `human-fixture-${Math.random().toString(16).slice(2)}`;
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

describe("GET /runs/:id/browser-takeover — real upgrade + relay over loopback TCP", () => {
  let app: FastifyInstance | undefined;
  let fakeSteel: Awaited<ReturnType<typeof startFakeSteel>> | undefined;
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
    fakeSteel?.close();
    app = undefined;
    fakeSteel = undefined;
  });

  async function listen(options: Parameters<typeof registerBrowserTakeoverRoutes>[1]): Promise<number> {
    app = Fastify({ logger: false });
    trackAcceptedSockets(app);
    registerBrowserTakeoverRoutes(app, options);
    await app!.listen({ port: 0, host: "127.0.0.1" });
    const address = app!.server.address();
    return typeof address === "object" && address !== null ? address.port : 0;
  }

  it("genuinely relays real human CDP input to Steel, and real Steel output back to the human", async () => {
    fakeSteel = await startFakeSteel();
    const browserTakeover: BrowserTakeoverPort = {
      getCdpEndpoint: vi.fn().mockResolvedValue({ url: `ws://127.0.0.1:${fakeSteel.port}/` }),
    };
    const takeoverStatus: TakeoverStatusPort = { getStatus: vi.fn().mockResolvedValue({ pending: true }) };
    const forwarded: BrowserTakeoverInputForwardedEvent[] = [];

    const port = await listen({
      authToken: TOKEN,
      browserTakeover,
      takeoverStatus,
      dialUpstream: defaultDialUpstream,
      onInputForwarded: (event) => forwarded.push(event),
    });

    const human = await connectHumanClient(port, "/runs/run-1/browser-takeover", authHeaders());
    expect(human.statusLine).toContain("101");

    // Real Steel output (e.g. a screencast frame) must reach the human.
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (human.frames.length > 0) {
          clearInterval(check);
          resolve();
        }
      }, 5);
      fakeSteel!.sendFrame(Buffer.from(JSON.stringify({ method: "Page.screencastFrame" })));
    });
    expect(JSON.parse(human.frames[0]!.payload.toString())).toMatchObject({ method: "Page.screencastFrame" });

    // The human genuinely controls the browser: real input must reach Steel.
    human.socket.write(encodeFrame(OPCODE_TEXT, Buffer.from(JSON.stringify({ id: 1, method: "Input.dispatchMouseEvent" })), true));
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (fakeSteel!.receivedAfterHandshake.length > 0) {
          clearInterval(check);
          resolve();
        }
      }, 5);
    });
    expect(browserTakeover.getCdpEndpoint).toHaveBeenCalledWith("run-1", expect.any(String));
    expect(takeoverStatus.getStatus).toHaveBeenCalledWith("run-1");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toMatchObject({ runId: "run-1", opcode: OPCODE_TEXT });

    human.socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  it("returns 501 when no BrowserTakeoverPort is configured", async () => {
    const port = await listen({ authToken: TOKEN });
    const human = await connectHumanClient(port, "/runs/run-1/browser-takeover", authHeaders());
    expect(human.statusLine).toContain("501");
  });

  it("refuses the upgrade for an unauthenticated request", async () => {
    const browserTakeover: BrowserTakeoverPort = { getCdpEndpoint: vi.fn() };
    const port = await listen({ authToken: TOKEN, browserTakeover });
    const human = await connectHumanClient(port, "/runs/run-1/browser-takeover", {});
    expect(human.statusLine).toContain("401");
  });

  it("404s when the run does not exist (takeoverStatus.getStatus returns null)", async () => {
    const browserTakeover: BrowserTakeoverPort = { getCdpEndpoint: vi.fn() };
    const takeoverStatus: TakeoverStatusPort = { getStatus: vi.fn().mockResolvedValue(null) };
    const port = await listen({ authToken: TOKEN, browserTakeover, takeoverStatus });
    const human = await connectHumanClient(port, "/runs/run-1/browser-takeover", authHeaders());
    expect(human.statusLine).toContain("404");
    expect(browserTakeover.getCdpEndpoint).not.toHaveBeenCalled();
  });

  it("409s (connect-time defense-in-depth gate) when the run exists but is no longer pending — e.g. already handed back", async () => {
    const browserTakeover: BrowserTakeoverPort = { getCdpEndpoint: vi.fn() };
    const takeoverStatus: TakeoverStatusPort = { getStatus: vi.fn().mockResolvedValue({ pending: false }) };
    const port = await listen({ authToken: TOKEN, browserTakeover, takeoverStatus });
    const human = await connectHumanClient(port, "/runs/run-1/browser-takeover", authHeaders());
    expect(human.statusLine).toContain("409");
    // The defense-in-depth gate refuses to even ASK the port for an
    // endpoint once the independent pending check has already failed.
    expect(browserTakeover.getCdpEndpoint).not.toHaveBeenCalled();
  });

  it("404s when the port itself declines (not owned by this tenant, or no longer pending)", async () => {
    const browserTakeover: BrowserTakeoverPort = { getCdpEndpoint: vi.fn().mockResolvedValue(null) };
    const takeoverStatus: TakeoverStatusPort = { getStatus: vi.fn().mockResolvedValue({ pending: true }) };
    const port = await listen({ authToken: TOKEN, browserTakeover, takeoverStatus });
    const human = await connectHumanClient(port, "/runs/run-1/browser-takeover", authHeaders());
    expect(human.statusLine).toContain("404");
  });

  it("works without the takeoverStatus gate configured (relies on the port's own contract alone)", async () => {
    fakeSteel = await startFakeSteel();
    const browserTakeover: BrowserTakeoverPort = {
      getCdpEndpoint: vi.fn().mockResolvedValue({ url: `ws://127.0.0.1:${fakeSteel.port}/` }),
    };
    const port = await listen({ authToken: TOKEN, browserTakeover, dialUpstream: defaultDialUpstream });
    const human = await connectHumanClient(port, "/runs/run-1/browser-takeover", authHeaders());
    expect(human.statusLine).toContain("101");
    human.socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  it("does not intercept an unrelated upgrade path", async () => {
    const browserTakeover: BrowserTakeoverPort = { getCdpEndpoint: vi.fn() };
    app = Fastify({ logger: false });
    trackAcceptedSockets(app);
    registerBrowserTakeoverRoutes(app, { authToken: TOKEN, browserTakeover });
    // No other handler registered on 'upgrade' in this fixture app, so an
    // unrelated path is simply left alone by this route (never destroyed
    // by it) — asserted by confirming this route's own port resolver is
    // never invoked for it.
    await app!.listen({ port: 0, host: "127.0.0.1" });
    const address = app!.server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const socket = new Socket();
    const connected = new Promise<void>((resolve) => socket.connect(port, "127.0.0.1", resolve));
    await connected;
    socket.write("GET /roles/bot-1/live-agent/pty HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(browserTakeover.getCdpEndpoint).not.toHaveBeenCalled();
    socket.destroy();
  });
});
