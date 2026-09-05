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
  notifyAfterChatRun,
} from "./ports.js";

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
