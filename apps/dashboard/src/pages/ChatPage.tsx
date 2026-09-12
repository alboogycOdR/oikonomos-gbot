import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { ChatShell } from "../components/chat/ChatShell";
import type { BotSummary, ChatMessage, MemberSummary, RoutineSummary } from "../components/chat/types";
import {
  isGroupThread,
  listRoles,
  listThreadMessages,
  listThreads,
  sendThreadMessage,
  UnauthorizedError,
  type GroupThread,
  type Role,
  type Thread,
  type ThreadMessage,
} from "../lib/api";
import { useAuth } from "../lib/AuthContext";
import { subscribeToThreadMessages, type RealtimeMessage } from "../lib/realtime";
import { useWorkspaceState, type WorkspaceMessage } from "../lib/workspaceState";

const BASE_URL: string = (import.meta.env.VITE_CONTROL_API_BASE_URL as string | undefined) ?? "";

interface ApiRoutine {
  routineId: string;
  name: string;
  schedule: string | null;
}

/**
 * TASK-122 (Chat-2c) — `BotSummary`/`ChatMessage` (components/chat/types.ts)
 * are not this task's Owned_Paths, so group-thread awareness is carried as
 * a locally-declared structural extension rather than a type edit there.
 * Every consumer that cares (`ChatShell`, `BotSidebar`, `ConversationPane`
 * — all this task's territory) declares the same shape locally; plain
 * `BotSummary`/`ChatMessage` consumers ignore the extra fields untyped,
 * exactly as TypeScript's structural typing intends.
 *
 * TASK-236 (spec §2.5) adds `memberRoleIds` alongside the existing
 * `memberNames` so the Members panel can resolve each group participant
 * against the canonical roster from `listRoles()` (name/avatar) instead of
 * re-deriving anything from the thread's own denormalized name string.
 */
export interface GroupAwareBotSummary extends BotSummary {
  isGroup?: boolean;
  memberNames?: string[];
  memberRoleIds?: string[];
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
 *
 * TASK-236 (Workspace-1 §2) — this is now the single owner of the active
 * thread id, sourced from the `/workspace/:threadId` route (`App.tsx`)
 * rather than local component state, and delegates all per-thread runtime
 * state (messages, pending, draft) to `lib/workspaceState.ts` so
 * `ChatShell`/`ComposeBox` can be fully controlled with zero state of
 * their own. See spec §2.1-§2.7 and this task's PLAN.md entry for the
 * defects this replaces.
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
      memberRoleIds: thread.memberRoleIds,
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

/** Boundary into `workspaceState.ts`'s deliberately narrow shape — see that module's own doc comment. */
function toWorkspaceMessage(message: ThreadMessage): WorkspaceMessage {
  return {
    id: message.id,
    threadId: message.threadId,
    role: message.role,
    createdAt: message.createdAt,
    raw: message,
  };
}

export function ChatPage() {
  const { markUnauthenticated } = useAuth();
  const navigate = useNavigate();
  const { threadId: routeThreadId } = useParams<{ threadId?: string }>();

  const [bots, setBots] = useState<GroupAwareBotSummary[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [routines, setRoutines] = useState<RoutineSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const { dispatch, getThread } = useWorkspaceState();
  // Which threads' initial `GET /threads/:id/messages` history has already
  // been fetched — avoids re-fetching every time the user switches back to
  // a thread they've already visited (spec §2.7's "switch A→B→C→A" case);
  // the reducer already keeps every visited thread's messages in memory.
  const loadedThreadsRef = useRef<Set<string>>(new Set());

  const handleAuthError = useCallback(
    (err: unknown): boolean => {
      if (err instanceof UnauthorizedError) {
        // Drops every thread's messages/drafts/pending state at once
        // (spec §2.3 "dropped on logout") — belt-and-braces alongside the
        // fact that `RequireAuth` unmounts this whole page on
        // `markUnauthenticated()` anyway.
        dispatch({ type: "reset" });
        loadedThreadsRef.current.clear();
        markUnauthenticated();
        return true;
      }
      return false;
    },
    [markUnauthenticated, dispatch],
  );

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const [threads, rolesList] = await Promise.all([listThreads(), listRoles()]);
        if (cancelled) return;
        setBots(threads.map(toBotSummary));
        setRoles(rolesList);
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

  const refreshThreads = useCallback(async () => {
    const threads = await listThreads();
    setBots(threads.map(toBotSummary));
    return threads;
  }, []);

  /**
   * TASK-236 (spec §2.5) — replaces the old `window.location.reload()`
   * dialogs used to land the user on a freshly-created bot/group: refetch
   * the owned thread list, then navigate to the new thread's route. No
   * reload, no lost in-memory state for any other open thread.
   */
  const handleThreadCreated = useCallback(
    (result: { threadId: string }) => {
      void (async () => {
        try {
          await refreshThreads();
          navigate(`/workspace/${encodeURIComponent(result.threadId)}`);
        } catch (err) {
          if (!handleAuthError(err)) {
            setError(err instanceof Error ? err.message : "failed to refresh threads");
          }
        }
      })();
    },
    [refreshThreads, handleAuthError, navigate],
  );

  const sortedByRecency = useMemo(
    () =>
      [...bots].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0)),
    [bots],
  );

  const threadExists = routeThreadId !== undefined && bots.some((bot) => bot.id === routeThreadId);
  const notFound = !loading && routeThreadId !== undefined && !threadExists;

  /**
   * TASK-236 (spec §2.6) — `/` redirects to the most recently active
   * thread once threads have loaded; with no threads at all it stays put
   * and `ChatShell`/`BotSidebar` render their existing empty state.
   */
  useEffect(() => {
    if (loading || routeThreadId !== undefined) return;
    const mostRecent = sortedByRecency[0];
    if (mostRecent !== undefined) {
      navigate(`/workspace/${encodeURIComponent(mostRecent.id)}`, { replace: true });
    }
  }, [loading, routeThreadId, sortedByRecency, navigate]);

  // The one owner of the active thread id (spec §2.1): sourced from the
  // route, never a local copy — but only once it resolves to a thread we
  // actually own, so a foreign/unknown id in the URL never drives a
  // messages/stream fetch (spec §2.6 "never another user's data").
  const activeThreadId = threadExists ? routeThreadId : undefined;

  const loadMessages = useCallback(
    async (threadId: string) => {
      const messages = await listThreadMessages(threadId);
      dispatch({ type: "messages-loaded", threadId, messages: messages.map(toWorkspaceMessage) });
      loadedThreadsRef.current.add(threadId);
    },
    [dispatch],
  );

  useEffect(() => {
    if (activeThreadId === undefined) return;
    if (loadedThreadsRef.current.has(activeThreadId)) return;
    void loadMessages(activeThreadId).catch((err) => {
      if (!handleAuthError(err)) {
        setError(err instanceof Error ? err.message : "failed to load messages");
      }
    });
  }, [activeThreadId, loadMessages, handleAuthError]);

  const handleSelectBot = useCallback(
    (botId: string) => {
      navigate(`/workspace/${encodeURIComponent(botId)}`);
    },
    [navigate],
  );

  const handleSend = useCallback(
    async (threadId: string, body: string) => {
      try {
        const sent = await sendThreadMessage(threadId, body);
        dispatch({ type: "message-sent", threadId, message: toWorkspaceMessage(sent) });
      } catch (err) {
        if (!handleAuthError(err)) {
          setError(err instanceof Error ? err.message : "failed to send message");
        }
        // Deliberately no dispatch here: "message-sent" (the only action
        // that clears a thread's draft) only ever fires on success, so a
        // failed send leaves the draft exactly as the user left it (spec
        // §2.3).
      }
    },
    [dispatch, handleAuthError],
  );

  const handleDraftChange = useCallback(
    (threadId: string, value: string) => {
      dispatch({ type: "draft-changed", threadId, draft: value });
    },
    [dispatch],
  );

  /**
   * TASK-129 (RT-01): push subscription for whichever thread is active.
   * Opens one held-open SSE stream per active thread and tears it down
   * (no leaked connection) the moment the active thread changes or this
   * component unmounts — mirrors the discipline the old poll-interval
   * cleanup test held this codebase to (AC2).
   */
  useEffect(() => {
    if (activeThreadId === undefined) return undefined;
    const threadId = activeThreadId;

    const subscription = subscribeToThreadMessages(
      threadId,
      (raw: RealtimeMessage) => {
        dispatch({
          type: "message-arrived",
          threadId,
          message: toWorkspaceMessage(raw as unknown as ThreadMessage),
        });
      },
      (err) => {
        handleAuthError(err);
        // Transient stream errors reconnect on their own (lib/realtime.ts
        // AC3); UnauthorizedError above is the one case with no possible
        // recovery without a fresh login.
      },
    );

    return () => subscription.close();
  }, [activeThreadId, dispatch, handleAuthError]);

  const activeBot = bots.find((bot) => bot.id === activeThreadId);

  useEffect(() => {
    if (activeBot?.roleId === undefined) {
      setRoutines([]);
      return undefined;
    }
    let cancelled = false;
    fetch(`${BASE_URL}/roles/${encodeURIComponent(activeBot.roleId)}/routines`, { credentials: "same-origin" })
      .then(async (response) => {
        if (response.status === 401) throw new UnauthorizedError();
        if (!response.ok) throw new Error(`failed to load routines (${response.status})`);
        return (await response.json()) as ApiRoutine[];
      })
      .then((data) => {
        if (!cancelled) setRoutines(data.map((routine) => ({ id: routine.routineId, name: routine.name, description: routine.schedule ?? undefined })));
      })
      .catch((err: unknown) => {
        if (!cancelled && !handleAuthError(err)) setError(err instanceof Error ? err.message : "failed to load routines");
      });
    return () => { cancelled = true; };
  }, [activeBot?.roleId, handleAuthError]);

  /** Members panel roster (spec §2.5) — resolved against `listRoles()`'s canonical roster, not re-derived from thread display strings. */
  const members = useMemo<MemberSummary[]>(() => {
    if (activeBot === undefined) return [];
    if (activeBot.isGroup) {
      return (activeBot.memberRoleIds ?? []).map((roleId) => {
        const role = roles.find((r) => r.id === roleId);
        return { id: roleId, name: role?.name ?? "Unknown", role: "bot" as const };
      });
    }
    if (activeBot.roleId !== undefined) {
      const role = roles.find((r) => r.id === activeBot.roleId);
      return [{ id: activeBot.roleId, name: role?.name ?? activeBot.name, role: "bot" as const }];
    }
    return [];
  }, [activeBot, roles]);

  const activeThread = getThread(activeThreadId);
  const messagesByBotId: Record<string, GroupAwareChatMessage[]> =
    activeThreadId === undefined
      ? {}
      : { [activeThreadId]: activeThread.messages.map((m) => toChatMessage(m.raw as ThreadMessage)) };

  if (notFound) {
    return (
      <main className="flex h-screen w-full items-center justify-center bg-chrome">
        <p role="alert" className="text-sm text-slate-400">
          Workspace not found.
        </p>
      </main>
    );
  }

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
          members={members}
          routines={routines}
          activeBotId={activeThreadId}
          isBotResponding={activeThread.pending}
          draft={activeThread.draft}
          onDraftChange={(value) => activeThreadId && handleDraftChange(activeThreadId, value)}
          onSelectBot={handleSelectBot}
          onSend={(botId, body) => void handleSend(botId, body)}
          onThreadCreated={handleThreadCreated}
          onUnauthorized={markUnauthenticated}
        />
      ) : null}
    </main>
  );
}
