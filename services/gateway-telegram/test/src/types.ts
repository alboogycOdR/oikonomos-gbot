/**
 * Minimal types copied from the extracted AgentProvider surface so the
 * staged gateway tests compile without adding a package.json dependency
 * (gateway-telegram/package.json is outside this task's Owned_Paths).
 */

export type ProviderId = "claude-code" | "codex" | "grok";

export interface AgentSession {
  provider: ProviderId;
  sessionId: string | null;
  cwd: string;
  model: string | null;
  lastActiveAt: number;
  title: string | null;
}

export interface ChatState {
  chatId: number;
  activeProvider: ProviderId;
  sessions: Partial<Record<ProviderId, AgentSession>>;
}

export type PermissionDecision =
  | { allow: true; remember?: boolean }
  | { allow: false; reason?: string };
