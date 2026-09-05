import { issueApproval, type ApprovalWaitSignal } from "@oikonomos/approvals";
import { Database, getOrCreateThreadForRole, insertMessage, type DatabaseOptions } from "@oikonomos/db";

import { route, type GroupMember, type ShouldRespondScorer } from "./groupRouting.js";

/**
 * TASK-122 (Chat-2c) — the fan-out-approval rule, confirmed against the
 * real Grok Bot reference product 2026-09-03 (PLAN.md orchestrator_notes):
 * a single 1:1 bot-to-bot delegation ping needs no human approval; a bot
 * messaging multiple bots or a whole group in one action does. Kept
 * deliberately narrow (Description's own instruction: "this task does not
 * need to solve general multi-agent orchestration, only gate the fan-out
 * case") — a single exported gate function, not a new orchestration layer.
 *
 * Reuses the existing approval-issuance path (`issueApproval`, already
 * imported and already used by this driver's own `brokerDependencies`)
 * rather than inventing a second one, per the Description. The gate runs
 * *before* any message is persisted: a fan-out call returns the pending
 * `ApprovalWaitSignal` and delivers nothing; a single-recipient call
 * delivers immediately via the same `insertMessage`/`getOrCreateThreadForRole`
 * primitives `runChatTask` already uses for the human-facing bot reply.
 */
export interface BotToBotMessageRequest {
  readonly fromRoleId: string;
  readonly toRoleIds: readonly string[];
  readonly body: string;
  readonly runId: string;
  readonly tenantId?: string;
  /**
   * Optional until TASK-189 supplies the live group-thread composition.
   * When present, recipients are derived before TASK-122's approval gate.
   */
  readonly routing?: {
    readonly members: readonly GroupMember[];
    readonly mostRecentResponderRoleId: string | null;
    readonly scorer: ShouldRespondScorer;
  };
}
export type BotToBotMessageResult =
  | { readonly delivered: true }
  | { readonly delivered: false; readonly approval: ApprovalWaitSignal };

export const CHAT_FANOUT_CAPABILITY_ID = "chat.bot_fanout";

export async function deliverBotToBotMessage(
  options: DatabaseOptions,
  request: BotToBotMessageRequest,
): Promise<BotToBotMessageResult> {
  const fromRoleId = request.fromRoleId.trim();
  if (fromRoleId.length === 0) throw new Error("bot-to-bot message requires fromRoleId.");
  const requestedRoleIds = [...new Set(request.toRoleIds.map((roleId) => roleId.trim()))].filter(
    (roleId) => roleId.length > 0,
  );
  const body = request.body.trim();
  if (body.length === 0) throw new Error("bot-to-bot message body must not be empty.");
  const toRoleIds = request.routing === undefined
    ? requestedRoleIds
    : (await route({ message: body, ...request.routing })).recipients.map((member) => member.roleId);
  if (toRoleIds.length === 0) throw new Error("bot-to-bot message requires at least one recipient role.");

  // Fan-out: 2+ distinct recipients requires a real pending approval
  // before anything is sent — deleting this branch (falling through to
  // direct delivery below for every case) is exactly the mutation the
  // liveness test proves against: it would make every fan-out deliver
  // immediately with zero pending approvals, reddening the test.
  if (toRoleIds.length > 1) {
    // `approvals.capability_id` FK-references `capabilities` — upsert
    // (idempotent) rather than requiring a manifest/migration for this
    // one governed action, same pattern packages/db's own
    // `seedInboxTriage` uses for a capability with no connector manifest.
    const database = new Database(options);
    try {
      await database.upsertCapability({
        capabilityId: CHAT_FANOUT_CAPABILITY_ID,
        description: "Send a chat message to more than one bot or a whole group in one action.",
        defaultTier: "T2_internal",
        adapter: "chat:bot_fanout",
        enabled: true,
      });
    } finally {
      await database.close();
    }
    const approval = await issueApproval(
      {
        runId: request.runId,
        capabilityId: CHAT_FANOUT_CAPABILITY_ID,
        toolName: "chat.bot_fanout",
        input: { fromRoleId, toRoleIds, body },
        destination: toRoleIds.join(","),
        ...(request.tenantId === undefined ? {} : { tenantId: request.tenantId }),
      },
      { database: options },
    );
    return { delivered: false, approval };
  }

  const [toRoleId] = toRoleIds;
  const thread = await getOrCreateThreadForRole(options, { roleId: toRoleId! });
  await insertMessage(options, {
    threadId: thread.id,
    role: "bot",
    body,
    runId: request.runId,
    senderRoleId: fromRoleId,
  });
  return { delivered: true };
}
