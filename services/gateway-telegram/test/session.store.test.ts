import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import { SessionStore, type StoreFs } from "./src/session/store.js";

/** Minimal in-memory filesystem fake implementing the StoreFs contract. */
function createFakeFs(): StoreFs & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    async readFile(path: string): Promise<string> {
      const content = files.get(path);
      if (content === undefined) {
        const err = new Error("ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return content;
    },
    async writeFile(path: string, data: string): Promise<void> {
      files.set(path, data);
    },
    async mkdir(): Promise<void> {
      // no-op: the in-memory fake has no real directories to create
    },
  };
}

describe("SessionStore", () => {
  let fakeFs: ReturnType<typeof createFakeFs>;
  let store: SessionStore;

  beforeEach(async () => {
    fakeFs = createFakeFs();
    store = new SessionStore("/fake/state", "claude-code", fakeFs);
    await store.load();
  });

  it("throws if used before load()", async () => {
    const fresh = new SessionStore("/fake/state", "claude-code", createFakeFs());
    expect(() => fresh.getChatState(1)).toThrow();
  });

  it("creates a fresh chat state with the configured default provider", () => {
    const state = store.getChatState(42);
    expect(state.chatId).toBe(42);
    expect(state.activeProvider).toBe("claude-code");
    expect(state.sessions).toEqual({});
  });

  it("returns null for the active session when none exists yet", () => {
    expect(store.getActiveSession(42)).toBeNull();
  });

  it("persists an upserted session and makes it the active session", async () => {
    await store.upsertSession(1, "claude-code", {
      provider: "claude-code",
      sessionId: "sess-abc",
      cwd: "/home/user/project",
      model: null,
      lastActiveAt: 1000,
      title: "Fix the bug",
    });

    const active = store.getActiveSession(1);
    expect(active?.sessionId).toBe("sess-abc");
    expect(active?.cwd).toBe("/home/user/project");
  });

  it("switches the active provider and reflects it in getActiveSession", async () => {
    await store.upsertSession(1, "claude-code", {
      provider: "claude-code",
      sessionId: "sess-cc",
      cwd: "/tmp",
      model: null,
      lastActiveAt: 1,
      title: null,
    });
    await store.upsertSession(1, "codex", {
      provider: "codex",
      sessionId: "sess-codex",
      cwd: "/tmp",
      model: null,
      lastActiveAt: 2,
      title: null,
    });

    expect(store.getActiveSession(1)?.sessionId).toBe("sess-cc");
    await store.setActiveProvider(1, "codex");
    expect(store.getActiveSession(1)?.sessionId).toBe("sess-codex");
  });

  it("clears a session for one provider without affecting another", async () => {
    await store.upsertSession(1, "claude-code", {
      provider: "claude-code",
      sessionId: "sess-cc",
      cwd: "/tmp",
      model: null,
      lastActiveAt: 1,
      title: null,
    });
    await store.setActiveProvider(1, "codex");
    await store.upsertSession(1, "codex", {
      provider: "codex",
      sessionId: "sess-codex",
      cwd: "/tmp",
      model: null,
      lastActiveAt: 2,
      title: null,
    });

    await store.clearSession(1, "codex");
    expect(store.getActiveSession(1)).toBeNull();
    await store.setActiveProvider(1, "claude-code");
    expect(store.getActiveSession(1)?.sessionId).toBe("sess-cc");
  });

  it("setCwd creates a session entry if none exists, and updates cwd if one does", async () => {
    await store.setCwd(1, "claude-code", "/first/path");
    expect(store.getActiveSession(1)?.cwd).toBe("/first/path");

    await store.setCwd(1, "claude-code", "/second/path");
    expect(store.getActiveSession(1)?.cwd).toBe("/second/path");
    expect(store.getActiveSession(1)?.sessionId).toBeNull();
  });

  it("persists state to the fake filesystem as valid JSON", async () => {
    await store.upsertSession(7, "grok", {
      provider: "grok",
      sessionId: null,
      cwd: "/tmp",
      model: "grok-4.5",
      lastActiveAt: 123,
      title: "quick question",
    });

    const written = fakeFs.files.get(path.join("/fake/state", "sessions.json"));
    expect(written).toBeDefined();
    const parsed = JSON.parse(written!);
    expect(parsed.version).toBe(1);
    expect(parsed.chats["7"].sessions.grok.title).toBe("quick question");
  });

  it("reloads persisted state from disk on a new instance", async () => {
    await store.upsertSession(9, "claude-code", {
      provider: "claude-code",
      sessionId: "persisted-session",
      cwd: "/tmp",
      model: null,
      lastActiveAt: 1,
      title: null,
    });

    const reloaded = new SessionStore("/fake/state", "claude-code", fakeFs);
    await reloaded.load();
    expect(reloaded.getActiveSession(9)?.sessionId).toBe("persisted-session");
  });

  it("starts fresh (without throwing) when the state file does not exist", async () => {
    const emptyFs = createFakeFs();
    const fresh = new SessionStore("/fake/empty", "claude-code", emptyFs);
    await expect(fresh.load()).resolves.toBeUndefined();
    expect(fresh.getChatState(1).sessions).toEqual({});
  });

  it("starts fresh when the state file contains invalid JSON", async () => {
    const brokenFs = createFakeFs();
    brokenFs.files.set(path.join("/fake/broken", "sessions.json"), "{ not valid json");
    const fresh = new SessionStore("/fake/broken", "claude-code", brokenFs);
    await expect(fresh.load()).resolves.toBeUndefined();
    expect(fresh.getChatState(1).sessions).toEqual({});
  });
});
