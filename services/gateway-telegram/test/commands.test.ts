import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createControlApiHttpClient,
  registerTelegramCommands,
  type ApprovalSummary,
  type ControlApiClient,
  type RunSummary,
  type TelegramClient,
  type TelegramCommandMessage,
} from "../src/index.js";

class FakeTelegramClient implements TelegramClient {
  handler: ((message: TelegramCommandMessage) => Promise<void>) | undefined;
  readonly sent: Array<{ chatId: number; text: string }> = [];

  onMessage(handler: (message: TelegramCommandMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async sendMessage(chatId: number, text: string): Promise<void> {
    this.sent.push({ chatId, text });
  }

  async receive(chatId: number, text: string): Promise<void> {
    await this.handler?.({ chatId, text });
  }
}

function fakeControlApi(): ControlApiClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async createTask(input) {
      calls.push(`task:${input.requestedBy}`);
      return { taskId: "task-1", title: input.title, status: "draft" };
    },
    async listRuns(): Promise<readonly RunSummary[]> {
      calls.push("runs");
      return [{ runId: "run-1", taskId: "task-1", status: "started", provider: "claude" }];
    },
    async listPendingApprovals(): Promise<readonly ApprovalSummary[]> {
      calls.push("approvals");
      return [{ approvalId: "approval-1", capabilityId: "email.send", actionRender: "Send the draft", destination: null }];
    },
  };
}

function setup() {
  const telegram = new FakeTelegramClient();
  const controlApi = fakeControlApi();
  registerTelegramCommands({
    telegram,
    controlApi,
    allowedChatIds: new Set([42]),
    intakeRoleId: "telegram-intake",
  });
  return { telegram, controlApi };
}

describe("Telegram OIK-085 commands", () => {
  it("creates a task through the injected control-api client", async () => {
    const { telegram, controlApi } = setup();
    await telegram.receive(42, "/task Prepare a launch checklist");
    expect(controlApi.calls).toEqual(["task:telegram:chat:42"]);
    expect(telegram.sent).toEqual([{ chatId: 42, text: "Task created: Prepare a launch checklist (draft)" }]);
  });

  it("lists runs and pending approvals through the injected control-api client", async () => {
    const { telegram, controlApi } = setup();
    await telegram.receive(42, "/runs");
    await telegram.receive(42, "/approvals");
    expect(controlApi.calls).toEqual(["runs", "approvals"]);
    expect(telegram.sent.map((message) => message.text)).toEqual([
      "started: run\\-1 (claude)",
      "Pending: email\\.send — Send the draft",
    ]);
  });

  it("reuses MarkdownV2 escaping for control-api supplied text", async () => {
    const telegram = new FakeTelegramClient();
    const controlApi = fakeControlApi();
    controlApi.listRuns = async () => [{ runId: "run-1", taskId: "task-1", status: "needs_review", provider: "claude-code" }];
    registerTelegramCommands({ telegram, controlApi, allowedChatIds: new Set([42]), intakeRoleId: "telegram-intake" });
    await telegram.receive(42, "/runs");
    expect(telegram.sent[0]?.text).toBe("needs\\_review: run\\-1 (claude\\-code)");
  });

  it("refuses unauthorized chat IDs before they reach the control-api client", async () => {
    const { telegram, controlApi } = setup();
    await telegram.receive(7, "/runs");
    expect(controlApi.calls).toEqual([]);
    expect(telegram.sent).toEqual([{ chatId: 7, text: "Unauthorized chat." }]);
  });

  it("requires a task description", async () => {
    const { telegram, controlApi } = setup();
    await telegram.receive(42, "/task");
    expect(controlApi.calls).toEqual([]);
    expect(telegram.sent[0]?.text).toBe("Usage: /task <description>");
  });
});

describe("control-api HTTP adapter", () => {
  it("uses HTTP endpoints without a credential-bearing Telegram fixture", async () => {
    const requests: Array<{ url: string; method: string | undefined; body: string | undefined }> = [];
    const client = createControlApiHttpClient("https://control.example.test/", async (url, init) => {
      requests.push({ url, method: init?.method, body: init?.body });
      const body = url.endsWith("/runs") ? { runs: [] } : url.endsWith("/approvals") ? [] : { taskId: "task-1", title: "T", status: "draft" };
      return { ok: true, status: 200, json: async () => body };
    });
    await client.createTask({ roleId: "role", title: "T", goal: "G", requestedBy: "telegram:chat:42" });
    await client.listRuns();
    await client.listPendingApprovals();
    expect(requests).toEqual([
      expect.objectContaining({ url: "https://control.example.test/tasks", method: "POST" }),
      expect.objectContaining({ url: "https://control.example.test/runs" }),
      expect.objectContaining({ url: "https://control.example.test/approvals" }),
    ]);
  });
});

describe("OIK-084 persistence boundary", () => {
  it("contains no @oikonomos/db import in the gateway source surface", async () => {
    const sourceDirectory = fileURLToPath(new URL("../src/", import.meta.url));
    const sourceFiles = await readdir(sourceDirectory, { recursive: true });
    const typeScriptFiles = sourceFiles.filter((file) => typeof file === "string" && file.endsWith(".ts"));
    const contents = await Promise.all(typeScriptFiles.map((file) => readFile(path.join(sourceDirectory, file), "utf8")));
    expect(contents.join("\n")).not.toMatch(/from\s+["']@oikonomos\/db["']/);
  });
});
