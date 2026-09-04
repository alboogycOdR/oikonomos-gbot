import { useCallback, useEffect, useRef, useState } from "react";

import { ChatShell } from "../components/chat/ChatShell";
import type { BotSummary, ChatMessage } from "../components/chat/types";
import {
  isGroupThread,
  listRoles,
  listThreadMessages,
  listThreads,
  sendThreadMessage,
  UnauthorizedError,
  type GroupThread,
  type Thread,
  type ThreadMessage,
} from "../lib/api";
import { useAuth } from "../lib/AuthContext";
import { subscribeToThreadMessages, type RealtimeMessage } from "../lib/realtime";

/**
 * TASK-122 (Chat-2c) — `BotSummary`/`ChatMessage` (components/chat/types.ts)
 * are not this task's Owned_Paths, so group-thread awareness is carried as
 * a locally-declared structural extension rather than a type edit there.
 * Every consumer that cares (`ChatShell`, `BotSidebar`, `ConversationPane`
 * — all this task's territory) declares the same shape locally; plain
 * `BotSummary`/`ChatMessage` consumers ignore the extra fields untyped,
 * exactly as TypeScript's structural typing intends.
 */
export interface GroupAwareBotSummary extends BotSummary {
  isGroup?: boolean;
  memberNames?: string[];
}
export interface GroupAwareChatMessage extends ChatMessage {
  senderRoleId?: string | null;
  senderName?: string | null;
}

/**
 * TASK-108 (Chat-1d) — mounts `<ChatShell>` (Chat-1c, unmodified) at `/`
 * against the real control-api endpoints (spec §4/§5). Threads double as
 * "bots" for `<ChatShell>`'s props: v1 is one thread per bot (spec §3), so
 * `thread.id` is used as the shell's `botId`.
 *
 * TASK-129 (RT-01): reply delivery is now real push — a held-open SSE
 * subscription (`lib/realtime.ts`) against the active thread, replacing
 * the previous `setInterval`/`GET /threads/:id/messages` 2s poll. The
 * initial transcript load on thread-switch still uses
 * `GET /threads/:id/messages` unmodified (spec: only the poll *loop* is
 * removed, not the endpoint) — the subscription only carries messages
 * that arrive *after* it opens.
 */

function toBotSummary(thread: Thread | GroupThread): GroupAwareBotSummary {
  if (isGroupThread(thread)) {
    return {
      id: thread.id,
      // No single role owns a group thread; RightPanel/ApprovalCard
      // degrade safely on an undefined roleId, same accepted pattern as
      // TASK-123/124's own documented gaps.
      roleId: undefined,
      name: thread.title ?? thread.memberNames.join(", "),
      description: `Group · ${thread.memberNames.join(", ")}`,
      avatarSeed: thread.id,
      lastMessagePreview: thread.lastMessagePreview,
      updatedAt: thread.updatedAt,
      isGroup: true,
      memberNames: thread.memberNames,
    };
  }
  return {
    id: thread.id,
    roleId: thread.roleId,
    name: thread.botName,
    description: thread.botDescription,
    avatarSeed: thread.avatarSeed,
    lastMessagePreview: thread.lastMessagePreview,
    updatedAt: thread.updatedAt,
  };
}

function toChatMessage(message: ThreadMessage): GroupAwareChatMessage {
  return {
    id: message.id,
    threadId: message.threadId,
    role: message.role,
    body: message.body,
    createdAt: message.createdAt,
    senderRoleId: message.senderRoleId ?? null,
    senderName: message.senderName ?? null,
    ...(message.approval === undefined
      ? {}
      : {
          approval: {
            nonce: message.approval.nonce,
            actionRender: message.approval.action_render,
            status: message.approval.status as "pending" | "approved" | "rejected",
            capabilityId: message.approval.capability_id,
            ...(message.approval.max_tier === null ? {} : { maxTier: message.approval.max_tier }),
          },
        }),
  };
}

export function ChatPage() {
  const { markUnauthenticated } = useAuth();
  const [bots, setBots] = useState<GroupAwareBotSummary[]>([]);
  const [messagesByBotId, setMessagesByBotId] = useState<Record<string, GroupAwareChatMessage[]>>({});
  const [activeBotId, setActiveBotId] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isBotResponding, setIsBotResponding] = useState(false);

  // Tracks the createdAt of the most recent user message we're awaiting a
  // reply to, so the subscription knows when a *newer* pushed bot message
  // is the reply (not a stale/unrelated one) and can clear
  // `isBotResponding`.
  const pendingSinceRef = useRef<string | null>(null);

  const handleAuthError = useCallback(
    (err: unknown): boolean => {
      if (err instanceof UnauthorizedError) {
        markUnauthenticated();
        return true;
      }
      return false;
    },
    [markUnauthenticated],
  );

  const loadMessages = useCallback(
    async (threadId: string) => {
      const messages = await listThreadMessages(threadId);
      setMessagesByBotId((prev) => ({ ...prev, [threadId]: messages.map(toChatMessage) }));
      return messages;
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const [threads] = await Promise.all([listThreads(), listRoles()]);
        if (cancelled) return;
        setBots(threads.map(toBotSummary));
        const first = threads[0];
        if (first !== undefined) {
          setActiveBotId(first.id);
          await loadMessages(first.id);
        }
      } catch (err) {
        if (cancelled) return;
        if (!handleAuthError(err)) {
          setError(err instanceof Error ? err.message : "failed to load threads");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSelectBot = useCallback(
    (botId: string) => {
      // Switching threads abandons any in-flight poll for the previous one.
      setIsBotResponding(false);
      pendingSinceRef.current = null;
      if (messagesByBotId[botId] === undefined) {
        void loadMessages(botId).catch((err) => {
          if (!handleAuthError(err)) {
            setError(err instanceof Error ? err.message : "failed to load messages");
          }
        });
      }
    },
    [messagesByBotId, loadMessages, handleAuthError],
  );

  const handleSend = useCallback(
    async (botId: string, body: string) => {
      try {
        const sent = await sendThreadMessage(botId, body);
        setMessagesByBotId((prev) => ({
          ...prev,
          [botId]: [...(prev[botId] ?? []), toChatMessage(sent)],
        }));
        pendingSinceRef.current = sent.createdAt;
        setIsBotResponding(true);
      } catch (err) {
        if (!handleAuthError(err)) {
          setError(err instanceof Error ? err.message : "failed to send message");
        }
      }
    },
    [handleAuthError],
  );

  /**
   * TASK-129 (RT-01): push subscription for whichever thread is active.
   * Opens one held-open SSE stream per active thread and tears it down
   * (no leaked connection) the moment the active thread changes or this
   * component unmounts — mirrors the discipline the old poll-interval
   * cleanup test held this codebase to (AC2).
   */
  useEffect(() => {
    if (activeBotId === undefined) return undefined;
    const threadId = activeBotId;

    const subscription = subscribeToThreadMessages(
      threadId,
      (raw: RealtimeMessage) => {
        const incoming = toChatMessage(raw as unknown as ThreadMessage);
        setMessagesByBotId((prev) => {
          const existing = prev[threadId] ?? [];
          const index = existing.findIndex((message) => message.id === incoming.id);
          const next =
            index === -1
              ? [...existing, incoming]
              : existing.map((message, i) => (i === index ? incoming : message));
          return { ...prev, [threadId]: next };
        });
        const pendingSince = pendingSinceRef.current;
        if (raw.role === "bot" && (pendingSince === null || raw.createdAt > pendingSince)) {
          pendingSinceRef.current = null;
          setIsBotResponding(false);
        }
      },
      (err) => {
        if (handleAuthError(err)) {
          setIsBotResponding(false);
        }
        // Transient stream errors reconnect on their own (lib/realtime.ts
        // AC3); UnauthorizedError above is the one case with no possible
        // recovery without a fresh login.
      },
    );

    return () => subscription.close();
  }, [activeBotId, handleAuthError]);

  const activeBot = bots.find((bot) => bot.id === activeBotId);

  return (
    <main className="h-screen w-full">
      {loading && bots.length === 0 && (
        <p className="p-4 text-sm text-slate-400">Loading…</p>
      )}
      {error !== null && (
        <p role="alert" className="p-4 text-sm text-red-400">
          {error}
        </p>
      )}
      {!loading || bots.length > 0 ? (
        <ChatShell
          bots={bots}
          messagesByBotId={messagesByBotId}
          members={[]}
          routines={[]}
          initialActiveBotId={activeBot?.id}
          isBotResponding={isBotResponding}
          onSelectBot={handleSelectBot}
          onSend={(botId, body) => void handleSend(botId, body)}
        />
      ) : null}
    </main>
  );
}
