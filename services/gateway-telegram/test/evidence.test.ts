import { describe, expect, it } from "vitest";

import { redactPayload } from "@oikonomos/audit";
import { registerTelegramApprovals, type TelegramApprovalPort } from "../src/approvals/index.js";
import { renderApprovalEvidence, truncateForTelegram } from "../src/evidence/index.js";
import type { ApprovalSummary, ControlApiClient, EditedApprovalRequest, ReplacementApproval, RunEvidence } from "../src/index.js";

const fakeApiKey = ["sk", "-PLACEHOLDER_FAKE_NOT_A_REAL_SECRET_KEY"].join("");

function evidence(overrides: Partial<RunEvidence> = {}): RunEvidence {
  return {
    eventId: "event-1",
    eventType: "tool.result",
    payload: {
      recipient: "operator@example.test",
      body: "Draft body for review.",
      artifactUris: ["evidence://run/diff", "evidence://run/screenshot"],
    },
    evidenceUri: "evidence://run/audit-event",
    ...overrides,
  };
}

describe("Telegram approval evidence (OIK-087)", () => {
  it("fetches run evidence through control-api before delivering the approval", async () => {
    const sent: string[] = [];
    const telegram: TelegramApprovalPort = {
      async sendApprovalMessage(_chatId, text) { sent.push(text); },
      onApprovalCallback() {},
      async answerApprovalCallback() {},
      async requestApprovalEdit(): Promise<EditedApprovalRequest | null> { return null; },
    };
    const pending: ApprovalSummary = {
      approvalId: "approval-1", runId: "run-1", capabilityId: "email.create_draft",
      actionRender: "Create draft to operator@example.test: Draft body for review.", destination: "operator@example.test", nonce: "11111111-1111-4111-8111-111111111111",
    };
    const calls: string[] = [];
    const controlApi: ControlApiClient = {
      async createTask() { throw new Error("not used"); },
      async listRuns() { return []; },
      async listPendingApprovals() { return [pending]; },
      async getRunEvidence(runId) { calls.push(runId); return [evidence()]; },
      async decideApproval() { return { decided: false }; },
      async editApproval(): Promise<{ edited: boolean; replacement?: ReplacementApproval }> { return { edited: false }; },
    };

    await registerTelegramApprovals({ telegram, controlApi, allowedChatIds: new Set([7]) }).publishPendingApprovals(7);

    expect(calls).toEqual(["run-1"]);
    expect(sent[0]).toContain("evidence://run/screenshot");
  });

  it("shows the draft render, recipient/body evidence, and PostToolUse artifact URIs", () => {
    const message = renderApprovalEvidence("Create draft to operator@example.test: Draft body for review.", [evidence()]);

    expect(message).toContain("Create draft to operator@example.test: Draft body for review.");
    expect(message).toContain("recipient");
    expect(message).toContain("Draft body for review.");
    expect(message).toContain("evidence://run/diff");
    expect(message).toContain("evidence://run/screenshot");
    expect(message).toContain("evidence://run/audit-event");
  });

  it("uses the public packages/audit redactor before rendering", () => {
    const message = renderApprovalEvidence("Create a draft", [evidence({ payload: { apiKey: fakeApiKey } })]);

    expect(redactPayload({ apiKey: fakeApiKey })).toEqual({ apiKey: "[REDACTED]" });
    expect(message).toContain("[REDACTED]");
    expect(message).not.toContain(fakeApiKey);
  });

  it("marks Telegram-limit truncation explicitly instead of silently", () => {
    const message = truncateForTelegram("x".repeat(5000));

    expect(message.length).toBeLessThanOrEqual(4096);
    expect(message).toContain("[TRUNCATED");
    expect(message).toContain("full evidence remains available from control-api");
  });
});
