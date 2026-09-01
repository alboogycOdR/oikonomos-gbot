import { randomUUID } from "node:crypto";

import type {
  ApprovalDecision,
  ApprovalSummary,
  ControlApiClient,
  EditedApprovalRequest,
  ReplacementApproval,
} from "../index.js";
import { renderApprovalEvidence } from "../evidence/index.js";

export type ApprovalCallbackAction = "approve" | "edit" | "reject";

export interface TelegramApprovalCallback {
  readonly callbackId: string;
  readonly chatId: number;
  readonly userId: string;
  readonly data: string;
}

export interface InlineKeyboardButton {
  readonly text: string;
  readonly callbackData: string;
}

export interface TelegramApprovalPort {
  /**
   * Sends the approval as plain text with no parse_mode, because actionRender
   * includes agent-controlled canonical JSON and ADR-004 requires operators
   * to see exactly what will happen rather than interpreted Markdown or HTML.
   */
  sendApprovalMessage(
    chatId: number,
    text: string,
    keyboard: readonly (readonly InlineKeyboardButton[])[],
  ): Promise<void>;
  onApprovalCallback(handler: (callback: TelegramApprovalCallback) => Promise<void>): void;
  answerApprovalCallback(callbackId: string, text: string): Promise<void>;
  /** Runtime-owned interaction that gathers the replacement payload from the operator. */
  requestApprovalEdit(
    callback: TelegramApprovalCallback,
    approval: ApprovalSummary | ReplacementApproval,
  ): Promise<EditedApprovalRequest | null>;
}

export interface TelegramApprovalOptions {
  readonly telegram: TelegramApprovalPort;
  readonly controlApi: ControlApiClient;
  readonly allowedChatIds: ReadonlySet<number>;
}

interface ApprovalHandle {
  readonly chatId: number;
  readonly nonce: string;
  readonly approval: ApprovalSummary | ReplacementApproval;
  readonly runId: string | undefined;
}

const CALLBACK_PREFIX = "approval";

/**
 * Sends each pending approval using its persisted action render and installs
 * callback handling. Callback data contains a random opaque handle only; the
 * nonce stays in this process until it is sent to control-api over HTTP.
 */
export function registerTelegramApprovals(options: TelegramApprovalOptions): {
  publishPendingApprovals(chatId: number): Promise<void>;
} {
  // TODO(TASK-???): Bound handle retention and invalidate stale keyboards after an edit or decision.
  const handles = new Map<string, ApprovalHandle>();

  options.telegram.onApprovalCallback(async (callback) => {
    // TODO(TASK-???): Bind approvals to an authorized Telegram user, not only an allowed chat.
    if (!options.allowedChatIds.has(callback.chatId)) {
      await options.telegram.answerApprovalCallback(callback.callbackId, "Unauthorized chat.");
      return;
    }

    const parsed = parseCallbackData(callback.data);
    if (parsed === undefined) {
      await options.telegram.answerApprovalCallback(callback.callbackId, "Unknown approval action.");
      return;
    }

    const handle = handles.get(parsed.handle);
    if (handle === undefined || handle.chatId !== callback.chatId) {
      await options.telegram.answerApprovalCallback(callback.callbackId, "This approval request is no longer available.");
      return;
    }

    try {
      if (parsed.action === "edit") {
        await handleEdit(options, callback, handle, handles);
        return;
      }

      const decision: ApprovalDecision = parsed.action === "approve" ? "granted" : "rejected";
      const result = await options.controlApi.decideApproval(handle.nonce, decision, `telegram:user:${callback.userId}`);
      // TODO(TASK-???): Remove or disable the inline keyboard once its decision is resolved.
      await options.telegram.answerApprovalCallback(
        callback.callbackId,
        result.decided ? (decision === "granted" ? "Approved." : "Rejected.") : "Already decided or no longer valid.",
      );
    } catch (error) {
      // TODO(TASK-???): Redact approval nonces from callback-failure logs.
      console.error("[gateway-telegram] approval callback failed", error);
      await options.telegram.answerApprovalCallback(callback.callbackId, "Approval action failed. Please try again.");
    }
  });

  return {
    async publishPendingApprovals(chatId) {
      if (!options.allowedChatIds.has(chatId)) {
        throw new Error("Unauthorized chat.");
      }
      const approvals = await options.controlApi.listPendingApprovals();
      // TODO(TASK-???): Isolate per-approval failures so one bad handle does not abort this publish loop.
      for (const approval of approvals) {
        const nonce = requireNonce(approval);
        const handle = randomUUID();
        handles.set(handle, { chatId, nonce, approval, runId: approval.runId });
        await options.telegram.sendApprovalMessage(
          chatId,
          await renderApprovalWithEvidence(options.controlApi, approval.actionRender, approval.runId),
          approvalKeyboard(handle),
        );
      }
    },
  };
}

async function handleEdit(
  options: TelegramApprovalOptions,
  callback: TelegramApprovalCallback,
  handle: ApprovalHandle,
  handles: Map<string, ApprovalHandle>,
): Promise<void> {
  const editedRequest = await options.telegram.requestApprovalEdit(callback, handle.approval);
  if (editedRequest === null) {
    await options.telegram.answerApprovalCallback(callback.callbackId, "Edit cancelled.");
    return;
  }

  const result = await options.controlApi.editApproval(handle.nonce, editedRequest);
  if (!result.edited || result.replacement === undefined) {
    await options.telegram.answerApprovalCallback(callback.callbackId, "Already decided or no longer valid.");
    return;
  }

  const replacementNonce = requireNonce(result.replacement);
  const replacementHandle = randomUUID();
  handles.set(replacementHandle, {
    chatId: callback.chatId,
    nonce: replacementNonce,
    approval: result.replacement,
    runId: handle.runId,
  });
  await options.telegram.sendApprovalMessage(
    callback.chatId,
    await renderApprovalWithEvidence(options.controlApi, result.replacement.actionRender, handle.runId),
    approvalKeyboard(replacementHandle),
  );
  await options.telegram.answerApprovalCallback(callback.callbackId, "Previous approval invalidated; replacement sent.");
}

async function renderApprovalWithEvidence(
  controlApi: ControlApiClient,
  actionRender: string,
  runId: string | undefined,
): Promise<string> {
  // Legacy/malformed test doubles may lack a run ID. The live control-api
  // contract always supplies one for an approval, and that path must fetch.
  if (runId === undefined) return renderApprovalEvidence(actionRender, []);
  return renderApprovalEvidence(actionRender, await controlApi.getRunEvidence(runId));
}

function approvalKeyboard(handle: string): readonly (readonly InlineKeyboardButton[])[] {
  return [[
    { text: "Approve", callbackData: `${CALLBACK_PREFIX}:${handle}:approve` },
    { text: "Edit", callbackData: `${CALLBACK_PREFIX}:${handle}:edit` },
    { text: "Reject", callbackData: `${CALLBACK_PREFIX}:${handle}:reject` },
  ]];
}

function parseCallbackData(data: string): { handle: string; action: ApprovalCallbackAction } | undefined {
  const [prefix, handle, action, extra] = data.split(":");
  if (
    prefix !== CALLBACK_PREFIX
    || handle === undefined
    || !/^[0-9a-f-]{36}$/i.test(handle)
    || extra !== undefined
    || (action !== "approve" && action !== "edit" && action !== "reject")
  ) {
    return undefined;
  }
  return { handle, action };
}

function requireNonce(approval: { readonly nonce?: string }): string {
  if (approval.nonce === undefined || approval.nonce.trim().length === 0) {
    throw new Error("control-api returned a pending approval without a nonce.");
  }
  return approval.nonce;
}
