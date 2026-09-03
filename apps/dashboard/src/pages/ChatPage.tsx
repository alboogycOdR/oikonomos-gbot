import { useCallback, useEffect, useRef, useState } from "react";

import { ChatShell } from "../components/chat/ChatShell";
import type { BotSummary, ChatMessage } from "../components/chat/types";
import {
  listRoles,
  listThreadMessages,
  listThreads,
  sendThreadMessage,
  UnauthorizedError,
  type Thread,
  type ThreadMessage,
} from "../lib/api";
import { useAuth } from "../lib/AuthContext";

/**
 * TASK-108 (Chat-1d) — mounts `<ChatShell>` (Chat-1c, unmodified) at `/`
 * against the real control-api endpoints (spec §4/§5). Threads double as
 * "bots" for `<ChatShell>`'s props: v1 is one thread per bot (spec §3), so
 * `thread.id` is used as the shell's `botId`.
 *
 * Polling (spec §4 "Reply delivery for v1: polling, not websockets"):
 * after a send, poll `GET /threads/:id/messages` every ~2s while a reply
 * is in flight; stop as soon as a bot message newer than the just-sent
 * user message appears, or the thread is switched away from. No run is
 * ever polled at idle load — only immediately after this tab sent a
 * message and hasn't seen the reply yet.
 */
const POLL_INTERVAL_MS = 2000;

function toBotSummary(thread: Thread): BotSummary {
  return {
    id: thread.id,
    name: thread.botName,
    description: thread.botDescription,
    avatarSeed: thread.avatarSeed,
    lastMessagePreview: thread.lastMessagePreview,
    updatedAt: thread.updatedAt,
  };
}

function toChatMessage(message: ThreadMessage): ChatMessage {
  return {
    id: message.id,
    threadId: message.threadId,
    role: message.role,
    body: message.body,
    createdAt: message.createdAt,
    ...(message.approval === undefined
      ? {}
      : {
          approval: {
            nonce: message.approval.nonce,
            actionRender: message.approval.action_render,
            status: message.approval.status as "pending" | "approved" | "rejected",
          },
        }),
  };
}

export function ChatPage() {
  const { markUnauthenticated } = useAuth();
  const [bots, setBots] = useState<BotSummary[]>([]);
  const [messagesByBotId, setMessagesByBotId] = useState<Record<string, ChatMessage[]>>({});
  const [activeBotId, setActiveBotId] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isBotResponding, setIsBotResponding] = useState(false);

  // Tracks the createdAt of the most recent user message we're awaiting a
  // reply to, so polling knows when a *newer* bot message is the reply
  // (not stale) and can stop itself (AC3).
  const pendingSinceRef = useRef<string | null>(null);
  const pollThreadIdRef = useRef<string | undefined>(undefined);

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
        pollThreadIdRef.current = botId;
        setIsBotResponding(true);
      } catch (err) {
        if (!handleAuthError(err)) {
          setError(err instanceof Error ? err.message : "failed to send message");
        }
      }
    },
    [handleAuthError],
  );

  // Polling effect: active only while isBotResponding is true for the
  // thread that triggered it. Stops (clears the interval) the moment a
  // bot message newer than pendingSinceRef arrives, or the run is no
  // longer in flight in any other observable way (thread switch, unmount).
  useEffect(() => {
    if (!isBotResponding) return undefined;
    const threadId = pollThreadIdRef.current;
    if (threadId === undefined) return undefined;

    const intervalId = setInterval(() => {
      void (async () => {
        try {
          const messages = await listThreadMessages(threadId);
          setMessagesByBotId((prev) => ({ ...prev, [threadId]: messages.map(toChatMessage) }));
          const pendingSince = pendingSinceRef.current;
          const reply = messages.find(
            (message) =>
              message.role === "bot" &&
              (pendingSince === null || message.createdAt > pendingSince),
          );
          if (reply !== undefined) {
            pendingSinceRef.current = null;
            setIsBotResponding(false);
          }
        } catch (err) {
          if (handleAuthError(err)) {
            setIsBotResponding(false);
          }
          // transient poll errors don't stop polling on their own — the
          // next tick retries; UnauthorizedError above is the one case
          // that must stop it, since no further poll can succeed.
        }
      })();
    }, POLL_INTERVAL_MS);

    return () => clearInterval(intervalId);
  }, [isBotResponding, handleAuthError]);

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
