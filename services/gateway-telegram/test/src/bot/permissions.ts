/**
 * Staged from cc-multi-agent-bot `src/bot/permissions.ts`.
 */

import type { PermissionDecision } from "../types.js";

interface PendingApproval {
  resolve: (decision: PermissionDecision) => void;
  chatId: number;
  createdAt: number;
}

export const APPROVE_PREFIX = "perm_yes:";
export const DENY_PREFIX = "perm_no:";

/** Telegram callback_data has a 64-byte limit; keep our prefixes short. */
export function approveCallbackData(requestId: string): string {
  return `${APPROVE_PREFIX}${requestId}`;
}
export function denyCallbackData(requestId: string): string {
  return `${DENY_PREFIX}${requestId}`;
}

/**
 * Bridges a provider's async permission callback to a Telegram inline
 * keyboard: `register()` returns a Promise the provider awaits, and the
 * bot's callback_query handler calls `resolve()` once the user taps a
 * button.
 */
export class PermissionBroker {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly timeoutMs: number;

  constructor(timeoutMs = 10 * 60 * 1000) {
    this.timeoutMs = timeoutMs;
  }

  register(requestId: string, chatId: number): Promise<PermissionDecision> {
    return new Promise((resolve) => {
      this.pending.set(requestId, { resolve, chatId, createdAt: Date.now() });
    });
  }

  resolve(requestId: string, chatId: number, decision: PermissionDecision): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    if (entry.chatId !== chatId) return false;
    this.pending.delete(requestId);
    entry.resolve(decision);
    return true;
  }

  /** Denies and clears any requests older than the configured timeout. */
  sweepExpired(): number {
    const now = Date.now();
    let count = 0;
    for (const [requestId, entry] of this.pending.entries()) {
      if (now - entry.createdAt > this.timeoutMs) {
        this.pending.delete(requestId);
        entry.resolve({ allow: false, reason: "Permission request timed out waiting for a response." });
        count += 1;
      }
    }
    return count;
  }

  pendingCount(): number {
    return this.pending.size;
  }
}
