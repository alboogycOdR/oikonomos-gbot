/**
 * Staged from cc-multi-agent-bot `src/session/store.ts`.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentSession, ChatState, ProviderId } from "../types.js";

export interface StoreFs {
  readFile(path: string, encoding: "utf-8"): Promise<string>;
  writeFile(path: string, data: string, encoding: "utf-8"): Promise<void>;
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
}

export const nodeFs: StoreFs = {
  readFile: (p, enc) => fs.readFile(p, enc),
  writeFile: (p, data, enc) => fs.writeFile(p, data, enc),
  mkdir: (p, opts) => fs.mkdir(p, opts),
};

interface PersistedShape {
  version: 1;
  chats: Record<string, ChatState>;
}

export class SessionStore {
  private readonly chats = new Map<number, ChatState>();
  private readonly filePath: string;
  private readonly fsImpl: StoreFs;
  private readonly defaultProvider: ProviderId;
  private loaded = false;

  constructor(stateDir: string, defaultProvider: ProviderId, fsImpl: StoreFs = nodeFs) {
    this.filePath = path.join(stateDir, "sessions.json");
    this.fsImpl = fsImpl;
    this.defaultProvider = defaultProvider;
  }

  async load(): Promise<void> {
    try {
      const raw = await this.fsImpl.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as PersistedShape;
      if (parsed.version === 1) {
        for (const [chatIdStr, state] of Object.entries(parsed.chats)) {
          this.chats.set(Number(chatIdStr), state);
        }
      }
    } catch (err) {
      if (!isEnoent(err)) {
        console.warn(`[session-store] could not read state file, starting fresh: ${String(err)}`);
      }
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    const dir = path.dirname(this.filePath);
    await this.fsImpl.mkdir(dir, { recursive: true });
    const shape: PersistedShape = {
      version: 1,
      chats: Object.fromEntries(this.chats.entries()),
    };
    await this.fsImpl.writeFile(this.filePath, JSON.stringify(shape, null, 2), "utf-8");
  }

  private ensureLoaded(): void {
    if (!this.loaded) {
      throw new Error("SessionStore.load() must be awaited before use.");
    }
  }

  getChatState(chatId: number): ChatState {
    this.ensureLoaded();
    const existing = this.chats.get(chatId);
    if (existing) {
      return existing;
    }
    const fresh: ChatState = {
      chatId,
      activeProvider: this.defaultProvider,
      sessions: {},
    };
    this.chats.set(chatId, fresh);
    return fresh;
  }

  getActiveSession(chatId: number): AgentSession | null {
    const state = this.getChatState(chatId);
    return state.sessions[state.activeProvider] ?? null;
  }

  async setActiveProvider(chatId: number, provider: ProviderId): Promise<void> {
    const state = this.getChatState(chatId);
    state.activeProvider = provider;
    await this.persist();
  }

  async upsertSession(chatId: number, provider: ProviderId, session: AgentSession): Promise<void> {
    const state = this.getChatState(chatId);
    state.sessions[provider] = session;
    await this.persist();
  }

  async clearSession(chatId: number, provider: ProviderId): Promise<void> {
    const state = this.getChatState(chatId);
    delete state.sessions[provider];
    await this.persist();
  }

  async setCwd(chatId: number, provider: ProviderId, cwd: string): Promise<void> {
    const state = this.getChatState(chatId);
    const existing = state.sessions[provider];
    if (existing) {
      existing.cwd = cwd;
    } else {
      state.sessions[provider] = {
        provider,
        sessionId: null,
        cwd,
        model: null,
        lastActiveAt: Date.now(),
        title: null,
      };
    }
    await this.persist();
  }
}

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code: unknown }).code === "ENOENT";
}
