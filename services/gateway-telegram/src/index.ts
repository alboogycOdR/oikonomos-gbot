import { escapeMarkdownV2 } from "./formatting.js";

/**
 * Telegram command surface for OIK-085.
 *
 * The gateway deliberately knows nothing about a Telegram SDK or the
 * persistence layer.  A runtime supplies a Telegram client port and this
 * module talks to the control API through the small HTTP client below.
 */
export const workspaceName = "gateway-telegram";

export function ping(): string {
  return workspaceName;
}

export interface TelegramCommandMessage {
  readonly chatId: number;
  readonly text: string;
}

/** Token-free port implemented by the Telegram runtime. */
export interface TelegramClient {
  onMessage(handler: (message: TelegramCommandMessage) => Promise<void>): void;
  sendMessage(chatId: number, text: string): Promise<void>;
}

export interface NewTaskInput {
  readonly roleId: string;
  readonly title: string;
  readonly goal: string;
  readonly requestedBy: string;
}

export interface TaskSummary {
  readonly taskId: string;
  readonly title: string;
  readonly status: string;
}

export interface RunSummary {
  readonly runId: string;
  readonly taskId: string;
  readonly status: string;
  readonly provider: string;
}

export interface ApprovalSummary {
  readonly approvalId: string;
  readonly capabilityId: string;
  readonly actionRender: string;
  readonly destination: string | null;
  /** Bearer secret returned by control-api; never place this in Telegram callback data. */
  readonly nonce?: string;
}

/**
 * The edit endpoint returns an issuance wait signal, rather than another
 * database-backed pending-approval summary. It still contains everything the
 * inline surface needs to show and act on the replacement safely.
 */
export interface ReplacementApproval {
  readonly approvalId: string;
  readonly actionRender: string;
  readonly destination: string;
  readonly nonce: string;
  readonly status: "pending";
}

export type ApprovalDecision = "granted" | "rejected";

export interface ApprovalDecisionResult {
  readonly decided: boolean;
}

/** Replacement action collected by the Telegram runtime's edit interaction. */
export interface EditedApprovalRequest {
  readonly runId: string;
  readonly capabilityId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly destination: string;
  readonly tenantId?: string;
  readonly expiresAt?: string;
}

export interface EditApprovalResult {
  readonly edited: boolean;
  readonly replacement?: ReplacementApproval;
}

/** A port for the OIK-084 HTTP boundary; it is never a database port. */
export interface ControlApiClient {
  createTask(input: NewTaskInput): Promise<TaskSummary>;
  listRuns(): Promise<readonly RunSummary[]>;
  listPendingApprovals(): Promise<readonly ApprovalSummary[]>;
  decideApproval(nonce: string, decision: ApprovalDecision, decidedBy: string): Promise<ApprovalDecisionResult>;
  editApproval(nonce: string, request: EditedApprovalRequest): Promise<EditApprovalResult>;
}

export interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export type FetchLike = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<FetchResponse>;

/**
 * Creates the production OIK-084 adapter. The caller supplies the base URL;
 * no bot credential or database connection is accepted here.
 */
export function createControlApiHttpClient(baseUrl: string, fetchImpl: FetchLike = fetch): ControlApiClient {
  const normalizedBaseUrl = baseUrl.replace(/\/$/, "");
  if (!/^https?:\/\//.test(normalizedBaseUrl)) {
    throw new Error("control API base URL must be an absolute http(s) URL.");
  }

  return {
    async createTask(input) {
      return request<TaskSummary>(fetchImpl, `${normalizedBaseUrl}/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
    },
    async listRuns() {
      const page = await request<{ runs: RunSummary[] }>(fetchImpl, `${normalizedBaseUrl}/runs`);
      return page.runs;
    },
    async listPendingApprovals() {
      return request<ApprovalSummary[]>(fetchImpl, `${normalizedBaseUrl}/approvals`);
    },
    async decideApproval(nonce, decision, decidedBy) {
      return approvalRequest<ApprovalDecisionResult>(fetchImpl, `${normalizedBaseUrl}/approvals/${encodeURIComponent(nonce)}/decide`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision, decidedBy }),
      });
    },
    async editApproval(nonce, editedRequest) {
      return approvalRequest<EditApprovalResult>(fetchImpl, `${normalizedBaseUrl}/approvals/${encodeURIComponent(nonce)}/edit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(editedRequest),
      });
    },
  };
}

export interface TelegramGatewayOptions {
  readonly telegram: TelegramClient;
  readonly controlApi: ControlApiClient;
  /** Chat IDs explicitly authorized to issue control-plane commands. */
  readonly allowedChatIds: ReadonlySet<number>;
  /** The control-api role required by POST /tasks. */
  readonly intakeRoleId: string;
}

/** Attach OIK-085 command handling to an injected Telegram client. */
export function registerTelegramCommands(options: TelegramGatewayOptions): void {
  options.telegram.onMessage(async (message) => {
    if (!options.allowedChatIds.has(message.chatId)) {
      await options.telegram.sendMessage(message.chatId, "Unauthorized chat.");
      return;
    }

    const [command, ...arguments_] = message.text.trim().split(/\s+/);
    const normalizedCommand = command?.replace(/@[^\s]+$/, "").toLowerCase();

    try {
      switch (normalizedCommand) {
        case "/task":
          await handleTask(options, message.chatId, arguments_.join(" "));
          break;
        case "/runs":
          await handleRuns(options, message.chatId);
          break;
        case "/approvals":
          await handleApprovals(options, message.chatId);
          break;
        default:
          await options.telegram.sendMessage(message.chatId, "Unknown command. Use /task, /runs, or /approvals.");
      }
    } catch (error) {
      // Keep upstream error details out of the chat: they can contain sensitive
      // request context, and a user can retry safely.
      console.error("[gateway-telegram] control API command failed", error);
      await options.telegram.sendMessage(message.chatId, "Command failed. Please try again shortly.");
    }
  });
}

async function handleTask(options: TelegramGatewayOptions, chatId: number, description: string): Promise<void> {
  const goal = description.trim();
  if (goal.length === 0) {
    await options.telegram.sendMessage(chatId, "Usage: /task <description>");
    return;
  }
  const task = await options.controlApi.createTask({
    roleId: options.intakeRoleId,
    title: goal.slice(0, 120),
    goal,
    requestedBy: `telegram:chat:${chatId}`,
  });
  await options.telegram.sendMessage(chatId, `Task created: ${escapeMarkdownV2(task.title)} (${escapeMarkdownV2(task.status)})`);
}

async function handleRuns(options: TelegramGatewayOptions, chatId: number): Promise<void> {
  const runs = await options.controlApi.listRuns();
  const message = runs.length === 0
    ? "No recent runs."
    : runs.map((run) => `${escapeMarkdownV2(run.status)}: ${escapeMarkdownV2(run.runId)} (${escapeMarkdownV2(run.provider)})`).join("\n");
  await options.telegram.sendMessage(chatId, message);
}

async function handleApprovals(options: TelegramGatewayOptions, chatId: number): Promise<void> {
  const approvals = await options.controlApi.listPendingApprovals();
  const message = approvals.length === 0
    ? "No pending approvals."
    : approvals.map((approval) => `Pending: ${escapeMarkdownV2(approval.capabilityId)} — ${escapeMarkdownV2(approval.actionRender)}`).join("\n");
  await options.telegram.sendMessage(chatId, message);
}

async function request<T>(
  fetchImpl: FetchLike,
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<T> {
  const response = await fetchImpl(url, init);
  if (!response.ok) {
    throw new Error(`control API request failed with status ${response.status}`);
  }
  return (await response.json()) as T;
}

/** A 409 means the nonce was already resolved, never a transport failure. */
async function approvalRequest<T extends { readonly decided?: boolean; readonly edited?: boolean }>(
  fetchImpl: FetchLike,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<T> {
  const response = await fetchImpl(url, init);
  if (response.status === 409) {
    return (await response.json()) as T;
  }
  if (!response.ok) {
    throw new Error(`control API request failed with status ${response.status}`);
  }
  return (await response.json()) as T;
}
