import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import type { Approval, DeviceToken, Run, Task } from "@oikonomos/db";

import { CollectingPushTransport, type PushTransportPort } from "./pushTransport.js";
import { buildApp } from "./app.js";
import {
  AttachmentStoreError,
  buildChatGoal,
  createDatabaseBackedDeps,
  createFilesystemAttachmentStore,
  createGatedChatRunTask,
  runGatedGroupFanout,
  notifyAfterChatRun,
} from "./ports.js";
import { createRunGate, type ChatRunDriver } from "@oikonomos/worker";

const task: Task = {
  taskId: "11111111-1111-1111-1111-111111111111",
  tenantId: "basileia",
  roleId: "chat-bot",
  title: "Chat",
  goal: "Hello",
  status: "draft",
  routineId: null,
  requestedBy: "chat:thread:thread-1",
  createdAt: new Date(),
  updatedAt: new Date(),
};
const run: Run = {
  runId: "22222222-2222-2222-2222-222222222222",
  taskId: task.taskId,
  tenantId: task.tenantId,
  provider: "claude",
  sessionRef: null,
  status: "completed",
  startedAt: new Date(),
  endedAt: new Date(),
  failureNote: null,
};
const devices: DeviceToken[] = [
  { token: "opaque-target-a", platform: "android", createdAt: new Date(), lastSeenAt: new Date() },
  { token: "opaque-target-b", platform: "ios", createdAt: new Date(), lastSeenAt: new Date() },
];

function pendingApproval(): Approval {
  return {
    approvalId: randomUUID(), tenantId: "basileia", runId: run.runId, capabilityId: "fs.write",
    actionDigest: Buffer.from("digest"), actionRender: "write", destination: "path", nonce: randomUUID(),
    status: "pending", requestedAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
    decidedBy: null, decidedAt: null, consumedAt: null,
  };
}

describe("notifyAfterChatRun (TASK-145)", () => {
  async function invoke(transport: PushTransportPort, approvals: Approval[] = []) {
    const runChatTask = vi.fn(async () => {});
    await notifyAfterChatRun({ task, threadId: "thread-1" }, {
      runChatTask,
      listRuns: async () => ({ runs: [run], nextCursor: null }),
      listPendingApprovals: async () => approvals,
      listDeviceTokens: async () => devices,
      pushTransport: transport,
    });
    expect(runChatTask).toHaveBeenCalledWith({ task, threadId: "thread-1" });
  }

  it("broadcasts approval-pending after a run with pending approvals", async () => {
    const transport = new CollectingPushTransport();
    await invoke(transport, [pendingApproval()]);
    expect(transport.sends).toEqual(devices.map((device) => ({
      deviceToken: device.token,
      notification: { type: "approval-pending", runId: run.runId },
    })));
  });

  it("broadcasts run-completed after a run without pending approvals", async () => {
    const transport = new CollectingPushTransport();
    await invoke(transport);
    expect(transport.sends).toEqual(devices.map((device) => ({
      deviceToken: device.token,
      notification: { type: "run-completed", runId: run.runId },
    })));
  });

  it("swallows a throwing transport after the underlying run succeeds", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(invoke({ send: async () => { throw new Error("provider failed"); } })).resolves.toBeUndefined();
      expect(error).toHaveBeenCalledWith("push notification delivery failed");
    } finally {
      error.mockRestore();
    }
  });

  it("boots normally with FCM configuration absent", async () => {
    vi.stubEnv("FCM_SERVICE_ACCOUNT_JSON", "");
    const app = buildApp(createDatabaseBackedDeps({ connectionString: "postgresql://unused.invalid/test" }), {
      authToken: "test-auth-token",
      logger: false,
    });
    try {
      await expect(app.inject({ method: "GET", url: "/roles" })).resolves.toMatchObject({ statusCode: 401 });
    } finally {
      vi.unstubAllEnvs();
      await app.close();
    }
  });
});

describe("run concurrency production composition (TASK-238)", () => {
  it("observes run.queued evidence through the production chat wrapper", async () => {
    const queued: unknown[] = [];
    const audits: unknown[] = [];
    const releases: Array<() => void> = [];
    const driver: ChatRunDriver = {
      run: async () => new Promise<void>((resolve) => { releases.push(resolve); }),
    };
    const gate = createRunGate({ maxConcurrent: 2, onQueued: (event) => queued.push(event) });
    const runChatTask = createGatedChatRunTask(driver, {
      listRuns: async ({ taskId }) => ({ runs: [{ ...run, runId: taskId!, taskId: taskId! }], nextCursor: null }),
      recordQueuedRun: async (event) => { audits.push(event); },
    }, gate);
    const input = (id: string) => ({ task: { ...task, taskId: id, roleId: `role-${id}` }, threadId: "thread-1" });
    const first = runChatTask(input("11111111-1111-1111-1111-111111111111"));
    const second = runChatTask(input("22222222-2222-2222-2222-222222222222"));
    const third = runChatTask(input("33333333-3333-3333-3333-333333333333"));
    expect(queued).toEqual([{ roleId: "role-33333333-3333-3333-3333-333333333333", position: 1, reason: "concurrency.cap" }]);
    releases.shift()!();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    for (const release of releases.splice(0)) release();
    await Promise.all([first, second, third]);
    expect(audits).toEqual([expect.objectContaining({ runId: "33333333-3333-3333-3333-333333333333", reason: "concurrency.cap" })]);
  });

  it("holds group fan-out behind the same gate as chat work", async () => {
    const release = new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    const started: string[] = [];
    const gate = createRunGate({ maxConcurrent: 1 });
    const chat = gate.run("chat-role", async () => { started.push("chat"); await release; });
    const fanout = runGatedGroupFanout(gate, "group-role", () => { started.push("fanout"); });
    expect(started).toEqual(["chat"]);
    await Promise.all([chat, fanout]);
    expect(started).toEqual(["chat", "fanout"]);
  });
});

describe("filesystem attachment store (TASK-166)", () => {
  it("persists bytes to disk and resolves them by id for the same thread only", async () => {
    const root = await mkdtemp(join(tmpdir(), "oik-store-"));
    const store = createFilesystemAttachmentStore(root);
    const threadId = randomUUID();
    const otherThread = randomUUID();
    try {
      const stored = await store.persist({
        threadId,
        filename: "notes.txt",
        contentType: "text/plain",
        bytes: Buffer.from("hello-from-disk", "utf8"),
      });
      expect(stored.filename).toBe("notes.txt");
      expect(await readFile(stored.absolutePath, "utf8")).toBe("hello-from-disk");

      const resolved = await store.resolve(threadId, [stored.id]);
      expect(resolved).toEqual([expect.objectContaining({ id: stored.id, sha256: stored.sha256 })]);

      await expect(store.resolve(otherThread, [stored.id])).rejects.toBeInstanceOf(AttachmentStoreError);

      const goal = buildChatGoal("Summarise this.", [{ ...stored, textContent: "hello-from-disk" }]);
      expect(goal).toContain("hello-from-disk");
      expect(goal).toContain(`Absolute path: ${stored.absolutePath}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
