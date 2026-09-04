import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";
import type { Message, Thread } from "@oikonomos/db";

import { buildApp } from "./app.js";
import type { ControlApiDeps } from "./ports.js";

// Real listen()/fetch() round trips over 127.0.0.1; the default 5000ms
// budget is occasionally too tight for the first test in the file while
// the module graph is still warming up (observed in the full `pnpm -r
// test` run, not in isolation).
const TEST_TIMEOUT_MS = 15000;

const TOKEN = "task-129-fixture-token";
const threadId = "33333333-3333-3333-3333-333333333333";

function authHeaders(): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}` };
}

function makeThread(): Thread {
  return { id: threadId, roleId: "bot", title: null, createdAt: new Date(), updatedAt: new Date() };
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: randomUUID(),
    threadId,
    role: "bot",
    body: "hi",
    runId: null,
    createdAt: new Date(),
    ...overrides,
  };
}

/** Minimal `ControlApiDeps` fake — only `listMessages`/`listAllThreadsWithMembers` matter for this route. */
function createDeps(overrides: Partial<ControlApiDeps> = {}): ControlApiDeps {
  return {
    createTask: async () => {
      throw new Error("unused in this test");
    },
    createRole: async () => {
      throw new Error("unused in this test");
    },
    listCapabilities: async () => [],
    upsertRoleGrant: async (input) => input,
    listRoleGrants: async () => [],
    revokeRoleGrant: async () => {},
    listRoles: async () => [],
    getOrCreateThreadForRole: async () => makeThread(),
    listThreads: async () => [makeThread()],
    createGroupThread: async () => {
      throw new Error("unused in this test");
    },
    listAllThreadsWithMembers: async () => [makeThread()],
    insertMessage: async (input) => makeMessage(input),
    listMessages: async () => [],
    listTasks: async () => ({ tasks: [], nextCursor: null }),
    listRuns: async () => ({ runs: [], nextCursor: null }),
    getRun: async () => null,
    listPendingApprovals: async () => [],
    decideApproval: async () => ({ decided: false, rowCount: 0 }),
    editApproval: async () => ({ edited: false, rowCount: 0 }),
    getAuditEventsForRun: async () => [],
    runChatTask: async () => {},
    requestGroupFanout: async () => ({ runId: randomUUID() }),
    ...overrides,
  };
}

async function startServer(deps: ControlApiDeps, sseIntervalMs = 15) {
  const app = buildApp(deps, { authToken: TOKEN, logger: false, sseIntervalMs });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a bound TCP address");
  }
  return { app, baseUrl: `http://127.0.0.1:${address.port}` };
}

/** Reads and returns the next complete `id:`/`data:` SSE frame from a stream reader. */
async function readNextFrame(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  buffer: { text: string },
): Promise<{ id?: string; data?: string } | null> {
  const decoder = new TextDecoder();
  while (true) {
    const separatorIndex = buffer.text.indexOf("\n\n");
    if (separatorIndex !== -1) {
      const raw = buffer.text.slice(0, separatorIndex);
      buffer.text = buffer.text.slice(separatorIndex + 2);
      if (raw.startsWith(":")) continue; // comment/heartbeat frame, skip
      const frame: { id?: string; data?: string } = {};
      for (const line of raw.split("\n")) {
        if (line.startsWith("id:")) frame.id = line.slice(3).trim();
        else if (line.startsWith("data:")) frame.data = line.slice(5).trim();
      }
      return frame;
    }
    const { value, done } = await reader.read();
    if (done) return null;
    buffer.text += decoder.decode(value, { stream: true });
  }
}

describe("GET /threads/:id/stream (TASK-129 RT-01)", () => {
  const openStreams: Array<{ app: Awaited<ReturnType<typeof startServer>>["app"]; controller: AbortController }> = [];

  afterEach(async () => {
    for (const { app, controller } of openStreams.splice(0)) {
      controller.abort();
      await app.close();
    }
  });

  it("rejects an unauthenticated stream request", async () => {
    const { app, baseUrl } = await startServer(createDeps());
    const response = await fetch(`${baseUrl}/threads/${threadId}/stream`);
    expect(response.status).toBe(401);
    await response.body?.cancel();
    await app.close();
  }, TEST_TIMEOUT_MS);

  it("404s for a thread that does not exist", async () => {
    const { app, baseUrl } = await startServer(createDeps({ listAllThreadsWithMembers: async () => [] }));
    const response = await fetch(`${baseUrl}/threads/${threadId}/stream`, { headers: authHeaders() });
    expect(response.status).toBe(404);
    await app.close();
  }, TEST_TIMEOUT_MS);

  it("streams a message that appears after the connection opens, without a 2s delay", async () => {
    const messages: Message[] = [];
    const deps = createDeps({
      listMessages: async (_threadId, options) => {
        const cursor = options?.after;
        if (cursor === undefined) return [...messages];
        const idx = messages.findIndex((m) => m.id === cursor);
        return idx === -1 ? [...messages] : messages.slice(idx + 1);
      },
    });
    const { app, baseUrl } = await startServer(deps, 15);
    const controller = new AbortController();
    openStreams.push({ app, controller });

    const response = await fetch(`${baseUrl}/threads/${threadId}/stream`, {
      headers: authHeaders(),
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const buffer = { text: "" };

    // No message yet: pushing one now, well under 2000ms, must appear.
    const started = Date.now();
    const pushed = makeMessage({ body: "arrived via push" });
    messages.push(pushed);

    const frame = await readNextFrame(reader, buffer);
    const elapsedMs = Date.now() - started;
    expect(elapsedMs).toBeLessThan(2000);
    expect(frame?.id).toBe(pushed.id);
    expect(JSON.parse(frame!.data!)).toMatchObject({ id: pushed.id, body: "arrived via push" });
  }, TEST_TIMEOUT_MS);

  it("resumes from Last-Event-ID with no duplicate and no missed messages", async () => {
    const first = makeMessage({ body: "first" });
    const second = makeMessage({ body: "second" });
    const all = [first, second];
    const deps = createDeps({
      listMessages: async (_threadId, options) => {
        const cursor = options?.after;
        if (cursor === undefined) return [...all];
        const idx = all.findIndex((m) => m.id === cursor);
        return idx === -1 ? [...all] : all.slice(idx + 1);
      },
    });
    const { app, baseUrl } = await startServer(deps, 15);
    const controller = new AbortController();
    openStreams.push({ app, controller });

    // Simulates a reconnect after having already seen `first` (e.g. the
    // original connection dropped right after it was delivered).
    const response = await fetch(`${baseUrl}/threads/${threadId}/stream`, {
      headers: { ...authHeaders(), "last-event-id": first.id },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const buffer = { text: "" };
    const frame = await readNextFrame(reader, buffer);
    expect(frame?.id).toBe(second.id);
    expect(frame?.id).not.toBe(first.id);
  }, TEST_TIMEOUT_MS);
});
