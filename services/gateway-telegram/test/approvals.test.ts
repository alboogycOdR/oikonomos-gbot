import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  registerTelegramApprovals,
  type TelegramApprovalCallback,
  type TelegramApprovalPort,
} from "../src/approvals/index.js";
import type {
  ApprovalSummary,
  ControlApiClient,
  EditedApprovalRequest,
  ReplacementApproval,
} from "../src/index.js";
import { createControlApiHttpClient } from "../src/index.js";

const OLD_NONCE = "11111111-1111-4111-8111-111111111111";
const NEW_NONCE = "22222222-2222-4222-8222-222222222222";

class FakeTelegram implements TelegramApprovalPort {
  handler: ((callback: TelegramApprovalCallback) => Promise<void>) | undefined;
  readonly sent: Array<{ chatId: number; text: string; keyboard: readonly (readonly { text: string; callbackData: string }[])[] }> = [];
  readonly answers: string[] = [];
  editRequest: EditedApprovalRequest | null = null;

  onApprovalCallback(handler: (callback: TelegramApprovalCallback) => Promise<void>): void {
    this.handler = handler;
  }

  async sendApprovalMessage(chatId: number, text: string, keyboard: readonly (readonly { text: string; callbackData: string }[])[]): Promise<void> {
    this.sent.push({ chatId, text, keyboard });
  }

  async answerApprovalCallback(_callbackId: string, text: string): Promise<void> {
    this.answers.push(text);
  }

  async requestApprovalEdit(_callback: TelegramApprovalCallback, _approval: ApprovalSummary | ReplacementApproval): Promise<EditedApprovalRequest | null> {
    return this.editRequest;
  }

  async tap(data: string, userId = "42"): Promise<void> {
    await this.handler?.({ callbackId: "callback-1", chatId: 7, userId, data });
  }
}

function approval(nonce = OLD_NONCE, actionRender = "STORED render: send exactly this draft"): ApprovalSummary {
  return {
    approvalId: "approval-1",
    capabilityId: "email.send",
    actionRender,
    destination: "ops@example.test",
    nonce,
  };
}

function fakeControlApi(): ControlApiClient & { readonly calls: string[]; invalidated: boolean } {
  const client = {
    calls: [] as string[],
    invalidated: false,
    decided: false,
    async createTask() { throw new Error("not used"); },
    async listRuns() { return []; },
    async listPendingApprovals() { return [approval()]; },
    async decideApproval(nonce: string, decision: "granted" | "rejected") {
      client.calls.push(`decide:${nonce}:${decision}`);
      if (nonce !== OLD_NONCE || client.invalidated || client.decided) return { decided: false };
      client.decided = true;
      return { decided: true };
    },
    async editApproval(nonce: string, request: EditedApprovalRequest) {
      client.calls.push(`edit:${nonce}:${request.destination}`);
      if (nonce !== OLD_NONCE || client.invalidated) return { edited: false };
      client.invalidated = true;
      return {
        edited: true,
        replacement: {
          approvalId: "approval-2",
          nonce: NEW_NONCE,
          actionRender: "STORED replacement render",
          destination: "revised@example.test",
          status: "pending",
        },
      };
    },
  } satisfies ControlApiClient & { readonly calls: string[]; invalidated: boolean };
  return client;
}

function callbackData(telegram: FakeTelegram, button: "Approve" | "Edit" | "Reject"): string {
  return telegram.sent[0]?.keyboard[0]?.find((candidate) => candidate.text === button)?.callbackData ?? "";
}

describe("Telegram approval inline keyboard (OIK-086)", () => {
  it("renders the stored approval render and gives each action an opaque callback handle", async () => {
    const telegram = new FakeTelegram();
    const controlApi = fakeControlApi();
    const surface = registerTelegramApprovals({ telegram, controlApi, allowedChatIds: new Set([7]) });

    await surface.publishPendingApprovals(7);

    expect(telegram.sent[0]?.text).toBe("STORED render: send exactly this draft");
    const callbacks = telegram.sent[0]?.keyboard.flat().map((button) => button.callbackData) ?? [];
    expect(callbacks).toHaveLength(3);
    expect(callbacks.join(" ")).not.toContain(OLD_NONCE);
    expect(callbacks).toEqual(expect.arrayContaining([
      expect.stringMatching(/^approval:[0-9a-f-]{36}:approve$/),
      expect.stringMatching(/^approval:[0-9a-f-]{36}:edit$/),
      expect.stringMatching(/^approval:[0-9a-f-]{36}:reject$/),
    ]));
  });

  it("delegates approve and reject to control-api and leaves double-tap enforcement there", async () => {
    const telegram = new FakeTelegram();
    const controlApi = fakeControlApi();
    const surface = registerTelegramApprovals({ telegram, controlApi, allowedChatIds: new Set([7]) });
    await surface.publishPendingApprovals(7);

    await telegram.tap(callbackData(telegram, "Approve"));
    await telegram.tap(callbackData(telegram, "Approve"));
    await telegram.tap(callbackData(telegram, "Reject"));

    expect(controlApi.calls).toEqual([
      `decide:${OLD_NONCE}:granted`,
      `decide:${OLD_NONCE}:granted`,
      `decide:${OLD_NONCE}:rejected`,
    ]);
    expect(telegram.answers).toEqual(["Approved.", "Already decided or no longer valid.", "Already decided or no longer valid."]);
  });

  it("invalidates through control-api edit, sends the stored replacement render, and makes the old nonce unusable", async () => {
    const telegram = new FakeTelegram();
    telegram.editRequest = {
      runId: "run-1",
      capabilityId: "email.send",
      toolName: "send_email",
      input: { body: "revised" },
      destination: "revised@example.test",
    };
    const controlApi = fakeControlApi();
    const surface = registerTelegramApprovals({ telegram, controlApi, allowedChatIds: new Set([7]) });
    await surface.publishPendingApprovals(7);

    await telegram.tap(callbackData(telegram, "Edit"));
    await telegram.tap(callbackData(telegram, "Approve"));

    expect(controlApi.calls).toEqual([
      `edit:${OLD_NONCE}:revised@example.test`,
      `decide:${OLD_NONCE}:granted`,
    ]);
    expect(telegram.sent[1]?.text).toBe("STORED replacement render");
    expect(telegram.answers).toEqual([
      "Previous approval invalidated; replacement sent.",
      "Already decided or no longer valid.",
    ]);
  });

  it("fails if local nonce-consumption logic is added to the gateway", async () => {
    const sourcePath = fileURLToPath(new URL("../src/approvals/index.ts", import.meta.url));
    const source = await readFile(sourcePath, "utf8");
    expect(source).not.toMatch(/\b(?:consume|verifyAndConsume|consumeApproval)\b/);
    expect(source).not.toMatch(/@oikonomos\/(?:approvals|db)/);
  });

  it("delegates decision and edit HTTP calls without interpreting the nonce", async () => {
    const requests: Array<{ url: string; method: string | undefined; body: string | undefined }> = [];
    const client = createControlApiHttpClient("https://control.example.test", async (url, init) => {
      requests.push({ url, method: init?.method, body: init?.body });
      return { ok: true, status: 200, json: async () => ({ decided: true, edited: true }) };
    });

    await client.decideApproval("nonce/with reserved", "granted", "telegram:user:42");
    await client.editApproval("old-nonce", {
      runId: "run-1", capabilityId: "email.send", toolName: "send_email", input: { body: "edited" }, destination: "ops@example.test",
    });

    expect(requests).toEqual([
      expect.objectContaining({ url: "https://control.example.test/approvals/nonce%2Fwith%20reserved/decide", method: "POST", body: JSON.stringify({ decision: "granted", decidedBy: "telegram:user:42" }) }),
      expect.objectContaining({ url: "https://control.example.test/approvals/old-nonce/edit", method: "POST", body: JSON.stringify({ runId: "run-1", capabilityId: "email.send", toolName: "send_email", input: { body: "edited" }, destination: "ops@example.test" }) }),
    ]);
  });

  it("returns the control-api conflict response so duplicate taps are resolved there", async () => {
    const client = createControlApiHttpClient("https://control.example.test", async () => ({
      ok: false,
      status: 409,
      json: async () => ({ decided: false }),
    }));

    await expect(client.decideApproval("already-used", "granted", "telegram:user:42")).resolves.toEqual({ decided: false });
  });
});
