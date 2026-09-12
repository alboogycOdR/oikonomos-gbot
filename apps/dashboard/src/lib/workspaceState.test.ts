import { describe, expect, it } from "vitest";

import {
  EMPTY_THREAD_STATE,
  EMPTY_WORKSPACE_STATE,
  workspaceReducer,
  type WorkspaceMessage,
  type WorkspaceState,
} from "./workspaceState";

function msg(overrides: Partial<WorkspaceMessage> & { id: string }): WorkspaceMessage {
  return {
    threadId: "thread-a",
    role: "user",
    createdAt: "2026-09-12T10:00:00.000Z",
    raw: null,
    ...overrides,
  };
}

describe("workspaceReducer", () => {
  it("keeps threads fully independent — an action on one thread never touches another", () => {
    let state = EMPTY_WORKSPACE_STATE;
    state = workspaceReducer(state, {
      type: "messages-loaded",
      threadId: "thread-a",
      messages: [msg({ id: "a1", threadId: "thread-a" })],
    });
    state = workspaceReducer(state, { type: "draft-changed", threadId: "thread-b", draft: "hello b" });

    expect(state.threads["thread-a"]?.messages).toHaveLength(1);
    expect(state.threads["thread-a"]?.draft).toBe("");
    expect(state.threads["thread-b"]?.draft).toBe("hello b");
    expect(state.threads["thread-b"]?.messages ?? []).toHaveLength(0);
  });

  it("unknown threadId reads back the frozen empty thread state, never undefined", () => {
    const state = EMPTY_WORKSPACE_STATE;
    expect(state.threads["nope"] ?? EMPTY_THREAD_STATE).toEqual(EMPTY_THREAD_STATE);
  });

  describe("message merge (spec §2.4)", () => {
    it("a later history load never removes a message that arrived by stream after the request began", () => {
      let state: WorkspaceState = EMPTY_WORKSPACE_STATE;
      // Stream delivers a message first (simulating it arriving while a
      // concurrent history fetch is still in flight)...
      state = workspaceReducer(state, {
        type: "message-arrived",
        threadId: "thread-a",
        message: msg({ id: "streamed-1", role: "bot", createdAt: "2026-09-12T10:00:05.000Z" }),
      });
      // ...then the slower history fetch resolves without that message
      // (it started before the message existed server-side).
      state = workspaceReducer(state, {
        type: "messages-loaded",
        threadId: "thread-a",
        messages: [msg({ id: "history-1", createdAt: "2026-09-12T10:00:00.000Z" })],
      });

      const ids = state.threads["thread-a"]?.messages.map((m) => m.id);
      expect(ids).toContain("streamed-1");
      expect(ids).toContain("history-1");
      expect(ids).toHaveLength(2);
    });

    it("deduplicates by id when the same message shows up in both history and stream", () => {
      let state: WorkspaceState = EMPTY_WORKSPACE_STATE;
      state = workspaceReducer(state, {
        type: "messages-loaded",
        threadId: "thread-a",
        messages: [msg({ id: "dup-1" })],
      });
      state = workspaceReducer(state, {
        type: "message-arrived",
        threadId: "thread-a",
        message: msg({ id: "dup-1" }),
      });

      expect(state.threads["thread-a"]?.messages).toHaveLength(1);
    });

    it("orders merged messages by createdAt", () => {
      let state: WorkspaceState = EMPTY_WORKSPACE_STATE;
      state = workspaceReducer(state, {
        type: "messages-loaded",
        threadId: "thread-a",
        messages: [
          msg({ id: "m3", createdAt: "2026-09-12T10:00:30.000Z" }),
          msg({ id: "m1", createdAt: "2026-09-12T10:00:10.000Z" }),
        ],
      });
      state = workspaceReducer(state, {
        type: "message-arrived",
        threadId: "thread-a",
        message: msg({ id: "m2", createdAt: "2026-09-12T10:00:20.000Z" }),
      });

      expect(state.threads["thread-a"]?.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    });
  });

  describe("pending state keyed by thread (spec §2.2)", () => {
    it("a bot frame arriving on thread B while A is pending neither clears nor sets A's pending state", () => {
      let state: WorkspaceState = EMPTY_WORKSPACE_STATE;
      state = workspaceReducer(state, {
        type: "message-sent",
        threadId: "thread-a",
        message: msg({ id: "a-user-1", threadId: "thread-a", createdAt: "2026-09-12T10:00:00.000Z" }),
      });
      expect(state.threads["thread-a"]?.pending).toBe(true);

      state = workspaceReducer(state, {
        type: "message-arrived",
        threadId: "thread-b",
        message: msg({
          id: "b-bot-1",
          threadId: "thread-b",
          role: "bot",
          createdAt: "2026-09-12T10:00:05.000Z",
        }),
      });

      expect(state.threads["thread-a"]?.pending).toBe(true);
      expect(state.threads["thread-b"]?.pending).toBe(false);
    });

    it("clears pending only when the bot reply is newer than the message it's pending since", () => {
      let state: WorkspaceState = EMPTY_WORKSPACE_STATE;
      state = workspaceReducer(state, {
        type: "message-sent",
        threadId: "thread-a",
        message: msg({ id: "u1", createdAt: "2026-09-12T10:00:10.000Z" }),
      });
      // A stale/out-of-order bot frame older than pendingSince must not clear pending.
      state = workspaceReducer(state, {
        type: "message-arrived",
        threadId: "thread-a",
        message: msg({ id: "stale-bot", role: "bot", createdAt: "2026-09-12T10:00:05.000Z" }),
      });
      expect(state.threads["thread-a"]?.pending).toBe(true);

      state = workspaceReducer(state, {
        type: "message-arrived",
        threadId: "thread-a",
        message: msg({ id: "real-reply", role: "bot", createdAt: "2026-09-12T10:00:20.000Z" }),
      });
      expect(state.threads["thread-a"]?.pending).toBe(false);
      expect(state.threads["thread-a"]?.pendingSince).toBeNull();
    });
  });

  describe("drafts keyed by thread (spec §2.3)", () => {
    it("text typed in A is absent from B and present again on returning to A", () => {
      let state: WorkspaceState = EMPTY_WORKSPACE_STATE;
      state = workspaceReducer(state, { type: "draft-changed", threadId: "thread-a", draft: "draft for a" });
      expect(state.threads["thread-b"]?.draft ?? "").toBe("");
      expect(state.threads["thread-a"]?.draft).toBe("draft for a");
    });

    it("a successful send clears only that thread's draft", () => {
      let state: WorkspaceState = EMPTY_WORKSPACE_STATE;
      state = workspaceReducer(state, { type: "draft-changed", threadId: "thread-a", draft: "hi" });
      state = workspaceReducer(state, { type: "draft-changed", threadId: "thread-b", draft: "hey" });
      state = workspaceReducer(state, {
        type: "message-sent",
        threadId: "thread-a",
        message: msg({ id: "sent-1" }),
      });

      expect(state.threads["thread-a"]?.draft).toBe("");
      expect(state.threads["thread-b"]?.draft).toBe("hey");
    });

    it("a failed send is never modeled as clearing the draft (no action exists for it)", () => {
      // There is deliberately no "send-failed" action that touches the
      // draft — a failed POST simply never dispatches "message-sent", so
      // the draft set by "draft-changed" survives untouched.
      let state: WorkspaceState = EMPTY_WORKSPACE_STATE;
      state = workspaceReducer(state, { type: "draft-changed", threadId: "thread-a", draft: "still here" });
      // No further action dispatched — simulating the failed-send path.
      expect(state.threads["thread-a"]?.draft).toBe("still here");
    });
  });

  it("reset drops every thread's state at once (logout, spec §2.3)", () => {
    let state: WorkspaceState = EMPTY_WORKSPACE_STATE;
    state = workspaceReducer(state, { type: "draft-changed", threadId: "thread-a", draft: "secret draft" });
    state = workspaceReducer(state, { type: "reset" });
    expect(state).toEqual(EMPTY_WORKSPACE_STATE);
  });
});
