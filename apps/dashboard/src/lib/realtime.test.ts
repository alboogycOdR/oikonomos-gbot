import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { subscribeToThreadMessages, type RealtimeMessage } from "./realtime";

/** Builds a `ReadableStream<Uint8Array>` that emits the given raw SSE text in one chunk. */
function streamOf(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

/** A stream that never closes on its own — held open until the test aborts it. */
function neverEndingStream(): { stream: ReadableStream<Uint8Array>; push: (text: string) => void } {
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
    },
    cancel() {
      // client hung up (subscription.close()) — nothing further to do.
    },
  });
  return {
    stream,
    push: (text: string) => controllerRef?.enqueue(encoder.encode(text)),
  };
}

function frame(id: string, message: RealtimeMessage): string {
  return `id: ${id}\ndata: ${JSON.stringify(message)}\n\n`;
}

function makeMessage(overrides: Partial<RealtimeMessage> = {}): RealtimeMessage {
  return {
    id: "m1",
    threadId: "t1",
    role: "bot",
    body: "hi",
    runId: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("subscribeToThreadMessages (TASK-129 RT-01)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("delivers a message frame to onMessage", async () => {
    const message = makeMessage();
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: streamOf(frame(message.id, message)),
    });
    const onMessage = vi.fn();
    const sub = subscribeToThreadMessages("t1", onMessage, undefined, { fetchImpl: fetchImpl as unknown as typeof fetch });

    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledTimes(1));
    expect(onMessage).toHaveBeenCalledWith(message);
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining("/threads/t1/stream"),
      expect.objectContaining({ credentials: "same-origin" }),
    );
    sub.close();
  });

  it("ignores heartbeat/comment frames", async () => {
    const message = makeMessage({ id: "m2" });
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: streamOf(`:hb\n\n${frame(message.id, message)}`),
    });
    const onMessage = vi.fn();
    const sub = subscribeToThreadMessages("t1", onMessage, undefined, { fetchImpl: fetchImpl as unknown as typeof fetch });

    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledTimes(1));
    expect(onMessage).toHaveBeenCalledWith(message);
    sub.close();
  });

  it("reconnects with Last-Event-ID after the stream ends, and does not duplicate or lose messages", async () => {
    const first = makeMessage({ id: "m1", body: "first" });
    const second = makeMessage({ id: "m2", body: "second" });
    const { stream: secondStream, push: pushSecond } = neverEndingStream();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, body: streamOf(frame(first.id, first)) })
      .mockResolvedValueOnce({ ok: true, status: 200, body: secondStream });
    const onMessage = vi.fn();
    const sub = subscribeToThreadMessages("t1", onMessage, undefined, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      reconnectDelayMs: 100,
    });

    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledTimes(1));
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      expect.objectContaining({ headers: {} }),
    );

    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.objectContaining({ headers: { "last-event-id": "m1" } }),
    );

    pushSecond(frame(second.id, second));
    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledTimes(2));
    expect(onMessage).toHaveBeenNthCalledWith(1, first);
    expect(onMessage).toHaveBeenNthCalledWith(2, second);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    sub.close();
  });

  it("stops reconnecting once close() is called", async () => {
    const { stream, push } = neverEndingStream();
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, body: stream });
    const onMessage = vi.fn();
    const sub = subscribeToThreadMessages("t1", onMessage, undefined, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      reconnectDelayMs: 100,
    });

    push(frame("m1", makeMessage({ id: "m1" })));
    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledTimes(1));

    sub.close();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("surfaces a non-ok response via onError and reconnects", async () => {
    const { stream, push } = neverEndingStream();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500, body: null })
      .mockResolvedValueOnce({ ok: true, status: 200, body: stream });
    const onError = vi.fn();
    const onMessage = vi.fn();
    const sub = subscribeToThreadMessages("t1", onMessage, onError, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      reconnectDelayMs: 50,
    });

    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(50);
    push(frame("m1", makeMessage()));
    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledTimes(1));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    sub.close();
  });
});
