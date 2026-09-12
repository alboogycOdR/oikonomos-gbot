/**
 * TASK-236 — the one controlled state module `ChatPage` owns (spec
 * §2.1-§2.4). Everything here is keyed by `threadId` so that switching the
 * active workspace can never leak or clobber another workspace's pending
 * state, draft, or transcript.
 *
 * This module is deliberately framework-light: a pure reducer
 * (`workspaceReducer`) plus a thin `useWorkspaceState` hook wrapping
 * `useReducer`. The reducer is exported and independently tested
 * (`workspaceState.test.ts`) without mounting any component.
 */
import { useCallback, useMemo, useReducer } from "react";

export type WorkspaceMessageRole = "user" | "bot" | "system";

/**
 * Deliberately narrower than `components/chat/types.ts`'s `ChatMessage` —
 * this module only needs the fields it merges/orders/dedupes by (`id`,
 * `createdAt`, `role`). Callers (`ChatPage.tsx`) map their richer
 * `GroupAwareChatMessage` shape down to this one when dispatching, and map
 * back up for rendering, exactly like `ChatPage.tsx`'s existing
 * `toChatMessage` boundary.
 */
export interface WorkspaceMessage {
  id: string;
  threadId: string;
  role: WorkspaceMessageRole;
  createdAt: string;
  /** Opaque payload carried through untouched — never inspected here. */
  raw: unknown;
}

export interface ThreadState {
  /** Deduplicated by id, ordered by `createdAt` (ties broken by id). */
  messages: WorkspaceMessage[];
  /** In-memory only (spec §2.3) — never written to storage, never here either. */
  draft: string;
  /** "Bot is responding" for this thread only (spec §2.2). */
  pending: boolean;
  /** createdAt of the most recent user message this thread is awaiting a reply to. */
  pendingSince: string | null;
  /** id of the newest message this thread's viewer has seen (mark-read is a distinct action from this module's concerns — spec §1 — this field only records the fact). */
  lastSeenMessageId: string | null;
}

export const EMPTY_THREAD_STATE: ThreadState = Object.freeze({
  messages: [],
  draft: "",
  pending: false,
  pendingSince: null,
  lastSeenMessageId: null,
}) as ThreadState;

export interface WorkspaceState {
  threads: Record<string, ThreadState>;
}

export const EMPTY_WORKSPACE_STATE: WorkspaceState = { threads: {} };

export type WorkspaceAction =
  /** A `GET /threads/:id/messages` response landed. Merged, never replaces (spec §2.4). */
  | { type: "messages-loaded"; threadId: string; messages: WorkspaceMessage[] }
  /** A message arrived over the live stream (spec §2.4). Clears pending when it's the awaited bot reply (spec §2.2). */
  | { type: "message-arrived"; threadId: string; message: WorkspaceMessage }
  /** A user's own send succeeded: appends the message, marks the thread pending, and clears its draft (spec §2.3). */
  | { type: "message-sent"; threadId: string; message: WorkspaceMessage }
  /** The composer's text changed for this thread (spec §2.3). */
  | { type: "draft-changed"; threadId: string; draft: string }
  /** Drops every thread's state at once (spec §2.3 "dropped on logout"). */
  | { type: "reset" };

function mergeMessages(
  existing: WorkspaceMessage[],
  incoming: WorkspaceMessage[],
): WorkspaceMessage[] {
  const byId = new Map<string, WorkspaceMessage>();
  for (const message of existing) byId.set(message.id, message);
  for (const message of incoming) byId.set(message.id, { ...byId.get(message.id), ...message });
  return Array.from(byId.values()).sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

function getThread(state: WorkspaceState, threadId: string): ThreadState {
  return state.threads[threadId] ?? EMPTY_THREAD_STATE;
}

function putThread(state: WorkspaceState, threadId: string, thread: ThreadState): WorkspaceState {
  return { threads: { ...state.threads, [threadId]: thread } };
}

export function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  switch (action.type) {
    case "messages-loaded": {
      const current = getThread(state, action.threadId);
      const messages = mergeMessages(current.messages, action.messages);
      return putThread(state, action.threadId, { ...current, messages });
    }
    case "message-arrived": {
      const current = getThread(state, action.threadId);
      const messages = mergeMessages(current.messages, [action.message]);
      let pending = current.pending;
      let pendingSince = current.pendingSince;
      if (
        action.message.role === "bot" &&
        (pendingSince === null || action.message.createdAt > pendingSince)
      ) {
        pending = false;
        pendingSince = null;
      }
      return putThread(state, action.threadId, { ...current, messages, pending, pendingSince });
    }
    case "message-sent": {
      const current = getThread(state, action.threadId);
      const messages = mergeMessages(current.messages, [action.message]);
      return putThread(state, action.threadId, {
        ...current,
        messages,
        pending: true,
        pendingSince: action.message.createdAt,
        draft: "",
      });
    }
    case "draft-changed": {
      const current = getThread(state, action.threadId);
      return putThread(state, action.threadId, { ...current, draft: action.draft });
    }
    case "reset":
      return EMPTY_WORKSPACE_STATE;
    default:
      return state;
  }
}

export interface UseWorkspaceState {
  state: WorkspaceState;
  dispatch: React.Dispatch<WorkspaceAction>;
  getThread: (threadId: string | undefined) => ThreadState;
}

export function useWorkspaceState(): UseWorkspaceState {
  const [state, dispatch] = useReducer(workspaceReducer, EMPTY_WORKSPACE_STATE);
  const get = useCallback(
    (threadId: string | undefined): ThreadState =>
      threadId === undefined ? EMPTY_THREAD_STATE : getThread(state, threadId),
    [state],
  );
  return useMemo(() => ({ state, dispatch, getThread: get }), [state, dispatch, get]);
}
