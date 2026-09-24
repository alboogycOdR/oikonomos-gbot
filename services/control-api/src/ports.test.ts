import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createRole,
  createSecretRequest,
  createSecretVault,
  defaultPoolConfig,
  getAuditEventsForRun,
  getSecretRequest,
  getRun,
  type Approval,
  type DeviceToken,
  type Run,
  type Task,
} from "@oikonomos/db";

import { CollectingPushTransport, type PushTransportPort } from "./pushTransport.js";
import { buildApp } from "./app.js";
import {
  AttachmentStoreError,
  buildChatGoal,
  createDatabaseBackedDeps,
  createDatabaseBackedSecretRequests,
  createFilesystemAttachmentStore,
  createGatedChatRunTask,
  routeGroupMessageWithFallback,
  runGatedGroupFanout,
  notifyAfterChatRun,
  UnparsedGroupRoutingScoreError,
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
    const gate = createRunGate({ maxConcurrent: 2, onQueued: (event) => { queued.push(event); } });
    const runChatTask = createGatedChatRunTask(driver, {
      recordQueuedRun: async (event) => { audits.push(event); },
    }, gate);
    const input = (id: string) => ({ task: { ...task, taskId: id, roleId: `role-${id}` }, threadId: "thread-1" });
    const first = runChatTask(input("11111111-1111-1111-1111-111111111111"));
    const second = runChatTask(input("22222222-2222-2222-2222-222222222222"));
    const third = runChatTask(input("33333333-3333-3333-3333-333333333333"));
    expect(queued).toEqual([{ roleId: "role-33333333-3333-3333-3333-333333333333", position: 1, reason: "concurrency.cap" }]);
    await vi.waitFor(() => expect(audits).toEqual([expect.objectContaining({
      runId: null,
      taskId: "33333333-3333-3333-3333-333333333333",
      reason: "concurrency.cap",
    })]));
    releases.shift()!();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    for (const release of releases.splice(0)) release();
    await Promise.all([first, second, third]);
    expect(audits).toHaveLength(1);
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

describe("group routing fallback evidence and system holders (TASK-335)", () => {
  const members = [
    { roleId: "alpha", name: "Alpha", title: "Alpha", description: "First" },
    { roleId: "beta", name: "Beta", title: "Beta", description: "Second" },
  ];

  async function routeWith(
    overrides: Partial<Parameters<typeof routeGroupMessageWithFallback>[0]> = {},
  ) {
    const audits: string[] = [];
    const scorer = vi.fn(async (): Promise<number> => 0.8);
    const result = await routeGroupMessageWithFallback({
      message: "Please help",
      members,
      mostRecentResponderRoleId: null,
      grantsByRoleId: new Map(),
      scorer,
      recordFallback: async (reason) => { audits.push(reason); },
      ...overrides,
    });
    return { result, audits, scorer };
  }

  const fallbackCases: ReadonlyArray<[
    string,
    Partial<Pick<Parameters<typeof routeGroupMessageWithFallback>[0], "message" | "members" | "scorer">>,
  ]> = [
    ["unreachable", { scorer: async (): Promise<number> => { throw new Error("network unavailable"); } }],
    ["unparsed", { scorer: async (): Promise<number> => { throw new UnparsedGroupRoutingScoreError("not JSON"); } }],
    ["off_roster", { message: "@outside please help" }],
    ["unconfident", { scorer: async () => 0 }],
    ["single_candidate", { members: [members[0]!] }],
  ];

  it.each(fallbackCases)("audits the %s default-route category", async (reason, overrides) => {
    const { result, audits } = await routeWith(overrides);
    expect(result).toMatchObject({ recipients: [members[0]] });
    expect(audits).toEqual([reason]);
  });

  it("routes a named granted system to its only holder without scoring", async () => {
    const { result, audits, scorer } = await routeWith({
      message: "Can you check Gmail?",
      grantsByRoleId: new Map([["beta", [{ roleId: "beta", capabilityId: "gmail.send", maxTier: "T1_draft", constraints: {} }]]]),
    });
    expect(result).toMatchObject({ recipients: [members[1]] });
    expect(scorer).not.toHaveBeenCalled();
    expect(audits).toEqual([]);
  });

  it("lets an explicit roster mention beat the only-holder shortcut", async () => {
    const { result, audits, scorer } = await routeWith({
      message: "@Alpha please check Gmail",
      grantsByRoleId: new Map([["beta", [{ roleId: "beta", capabilityId: "gmail.send", maxTier: "T1_draft", constraints: {} }]]]),
    });
    expect(result).toMatchObject({ recipients: [members[0]], reason: "mentioned" });
    expect(scorer).not.toHaveBeenCalled();
    expect(audits).toEqual([]);
  });

  it("lets @everyone beat the only-holder shortcut", async () => {
    const { result, audits, scorer } = await routeWith({
      message: "@everyone please check Gmail",
      grantsByRoleId: new Map([["beta", [{ roleId: "beta", capabilityId: "gmail.send", maxTier: "T1_draft", constraints: {} }]]]),
    });
    expect(result).toMatchObject({ recipients: members, reason: "everyone" });
    expect(scorer).not.toHaveBeenCalled();
    expect(audits).toEqual([]);
  });

  it("routes an on-roster mention despite a simultaneous off-roster mention", async () => {
    const { result, audits, scorer } = await routeWith({ message: "@Alpha @Mallory please help" });
    expect(result).toMatchObject({ recipients: [members[0]], reason: "mentioned" });
    expect(scorer).not.toHaveBeenCalled();
    expect(audits).toEqual([]);
  });

  it("does not interpret an email address as an off-roster mention", async () => {
    const { result, audits, scorer } = await routeWith({ message: "Send it to jane@example.com" });
    expect(result).toMatchObject({ recipients: [members[0]], reason: "scored" });
    expect(scorer).toHaveBeenCalledTimes(2);
    expect(audits).toEqual([]);
  });

  it("audits a single-candidate fallback exactly once", async () => {
    const { audits } = await routeWith({ members: [members[0]!] });
    expect(audits).toEqual(["single_candidate"]);
  });

  it("does not apply the system-holder shortcut when two members hold the grant", async () => {
    const grant = { capabilityId: "gmail.send", maxTier: "T1_draft" as const, constraints: {} };
    const { result, audits, scorer } = await routeWith({
      message: "Can you check Gmail?",
      grantsByRoleId: new Map([
        ["alpha", [{ ...grant, roleId: "alpha" }]],
        ["beta", [{ ...grant, roleId: "beta" }]],
      ]),
    });
    expect(result).toMatchObject({ recipients: [members[0]] });
    expect(scorer).toHaveBeenCalledTimes(2);
    expect(audits).toEqual([]);
  });
});

const connectionString = process.env.DATABASE_URL;
const vaultIntegration = connectionString === undefined ? describe.skip : describe;

vaultIntegration("secret-vault production composition (TASK-250)", () => {
  const tenantId = "task-250-control-vault";
  const roleId = "task-250-control-vault-role";
  const runId = "25000000-0000-4000-8000-000000000250";
  const options = { connectionString: connectionString! };
  let pool: Pool;

  async function cleanup(): Promise<void> {
    await pool.query("DELETE FROM secret_values WHERE role_id = $1", [roleId]);
    await pool.query("DELETE FROM secret_requests WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM audit_events WHERE run_id = $1", [runId]);
    await pool.query("DELETE FROM runs WHERE run_id = $1", [runId]);
    await pool.query("DELETE FROM tasks WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM roles WHERE role_id = $1", [roleId]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString!, ...defaultPoolConfig });
    await cleanup();
    await createRole(options, { tenantId, roleId, name: "Vault control", title: "Vault control" });
    const taskRow = await pool.query<{ task_id: string }>(
      "INSERT INTO tasks (tenant_id, role_id, title, goal, requested_by) VALUES ($1, $2, 'vault', 'vault', 'test') RETURNING task_id",
      [tenantId, roleId],
    );
    await pool.query(
      "INSERT INTO runs (run_id, task_id, tenant_id, provider, status) VALUES ($1, $2, $3, 'test', 'waiting_approval')",
      [runId, taskRow.rows[0]!.task_id, tenantId],
    );
  });

  afterAll(async () => { await cleanup(); await pool.end(); });

  it("stores the submitted value, persists only its ref, and emits secret_vault.write", async () => {
    const vault = await createSecretVault({
      resolveKey: async () => Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32))),
    });
    const port = createDatabaseBackedSecretRequests(options, vault);
    const request = await createSecretRequest(options, {
      tenantId, roleId, runId, label: "Deploy key", purpose: "deploy a release",
    });
    const value = "task-250-plaintext-must-not-be-audit";
    const result = await port.fulfil(request.requestId, tenantId, value);

    expect(result).toEqual({ found: true, ref: expect.any(String) });
    if (!result.found) throw new Error("fulfilment unexpectedly failed");
    const persisted = await getSecretRequest(options, request.requestId);
    expect(persisted).toMatchObject({ status: "fulfilled", secretRef: `secret://${result.ref}` });
    const stored = await pool.query<{ ciphertext: Buffer }>("SELECT ciphertext FROM secret_values WHERE ref = $1", [result.ref]);
    expect(stored.rows[0]?.ciphertext.toString("utf8")).not.toContain(value);
    const events = await getAuditEventsForRun(options, runId);
    expect(events).toContainEqual(expect.objectContaining({
      eventType: "secret_vault.write",
      payload: { ref: result.ref, role_id: roleId },
    }));
    expect(JSON.stringify(events)).not.toContain(value);
    expect(await getRun(options, runId)).toMatchObject({ status: "resumed" });
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
