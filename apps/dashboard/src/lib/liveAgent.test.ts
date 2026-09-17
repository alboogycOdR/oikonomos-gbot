import { afterEach, describe, expect, it, vi } from "vitest";

import { UnauthorizedError } from "./api";
import { getLiveAgentStatus, watchLiveAgent, type WebSocketLike } from "./liveAgent";

/** A fake `WebSocketLike` a test can drive directly, without a real socket. */
class FakeSocket implements WebSocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;

  close(): void {
    this.closed = true;
  }

  emitOpen(): void {
    this.onopen?.();
  }

  emitMessage(data: unknown): void {
    this.onmessage?.({ data });
  }

  emitError(error: unknown): void {
    this.onerror?.(error);
  }

  emitClose(): void {
    this.onclose?.();
  }
}

describe("getLiveAgentStatus (TASK-248)", () => {
  it("returns the parsed status on 200", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({ available: true, state: "Running" }),
    });
    const status = await getLiveAgentStatus("bot-1", fetchImpl as unknown as typeof fetch);
    expect(status).toEqual({ available: true, state: "Running" });
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining("/roles/bot-1/live-agent/status"),
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("treats 501 (no LiveAgentPort configured) as an empty state, not an error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ status: 501, ok: false });
    const status = await getLiveAgentStatus("bot-1", fetchImpl as unknown as typeof fetch);
    expect(status).toEqual({ available: false });
  });

  it("throws UnauthorizedError on 401", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ status: 401, ok: false });
    await expect(getLiveAgentStatus("bot-1", fetchImpl as unknown as typeof fetch)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  it("throws a generic error on any other non-2xx status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ status: 500, ok: false });
    await expect(getLiveAgentStatus("bot-1", fetchImpl as unknown as typeof fetch)).rejects.toThrow(/500/);
  });
});

describe("watchLiveAgent (TASK-248) — read-only viewer stream", () => {
  let sub: ReturnType<typeof watchLiveAgent> | undefined;

  afterEach(() => {
    sub?.close();
    sub = undefined;
  });

  it("has no send/write method of any kind — structurally reinforces AC1 the same way the server does", () => {
    // The entire return shape is just `{ close }` — there is no code path
    // that could ever transmit a byte upstream, mirroring the Dart
    // client's LiveAgentSubscription (no `send` exists to call).
    const fake = new FakeSocket();
    sub = watchLiveAgent("bot-1", vi.fn(), undefined, undefined, undefined, { connector: () => fake });
    expect(Object.keys(sub)).toEqual(["close"]);
  });

  it("delivers real text output chunks to onOutput, in arrival order", () => {
    const fake = new FakeSocket();
    const chunks: string[] = [];
    sub = watchLiveAgent("bot-1", (chunk) => chunks.push(chunk), undefined, undefined, undefined, {
      connector: () => fake,
    });
    fake.emitMessage("$ ls\n");
    fake.emitMessage("file.txt\n");
    expect(chunks).toEqual(["$ ls\n", "file.txt\n"]);
  });

  it("decodes a binary (ArrayBuffer) chunk as UTF-8 text", () => {
    const fake = new FakeSocket();
    const chunks: string[] = [];
    sub = watchLiveAgent("bot-1", (chunk) => chunks.push(chunk), undefined, undefined, undefined, {
      connector: () => fake,
    });
    const encoded = new TextEncoder().encode("live sandbox output");
    fake.emitMessage(encoded.buffer);
    expect(chunks).toEqual(["live sandbox output"]);
  });

  it("fires onOpen once the socket connects", () => {
    const fake = new FakeSocket();
    const onOpen = vi.fn();
    sub = watchLiveAgent("bot-1", vi.fn(), onOpen, undefined, undefined, { connector: () => fake });
    expect(onOpen).not.toHaveBeenCalled();
    fake.emitOpen();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("fires onDone when the socket closes (session ended, or server refused — same handling either way)", () => {
    const fake = new FakeSocket();
    const onDone = vi.fn();
    sub = watchLiveAgent("bot-1", vi.fn(), undefined, onDone, undefined, { connector: () => fake });
    fake.emitClose();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("fires onError on a socket error", () => {
    const fake = new FakeSocket();
    const onError = vi.fn();
    sub = watchLiveAgent("bot-1", vi.fn(), undefined, undefined, onError, { connector: () => fake });
    const err = new Error("boom");
    fake.emitError(err);
    expect(onError).toHaveBeenCalledWith(err);
  });

  it("close() is idempotent and suppresses further callbacks", () => {
    const fake = new FakeSocket();
    const onOutput = vi.fn();
    const onDone = vi.fn();
    sub = watchLiveAgent("bot-1", onOutput, undefined, onDone, undefined, { connector: () => fake });
    sub.close();
    sub.close(); // second close must not throw
    expect(fake.closed).toBe(true);
    fake.emitMessage("too late");
    fake.emitClose();
    expect(onOutput).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("dials the pty path with the role id encoded", () => {
    const fake = new FakeSocket();
    const connector = vi.fn().mockReturnValue(fake);
    sub = watchLiveAgent("bot with spaces", vi.fn(), undefined, undefined, undefined, { connector });
    expect(connector).toHaveBeenCalledWith(expect.stringContaining("/roles/bot%20with%20spaces/live-agent/pty"));
  });
});
