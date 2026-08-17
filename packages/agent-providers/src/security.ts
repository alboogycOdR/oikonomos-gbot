/**
 * Strict allow-list security check.
 *
 * Mirrors the original OpenCode Telegram Bot's model: only Telegram user IDs
 * explicitly listed in config may interact with the bot. Everyone else is
 * silently ignored at the update-handling layer (the bot never reveals its
 * existence to unauthorized senders) and the attempt is logged so the owner
 * can see who knocked.
 */

export interface UnauthorizedAttempt {
  userId: number;
  username: string | undefined;
  firstName: string | undefined;
  chatId: number;
  timestamp: number;
}

export class AccessGuard {
  private readonly allowed: ReadonlySet<number>;
  private readonly onUnauthorized: (attempt: UnauthorizedAttempt) => void;

  constructor(allowedUserIds: ReadonlySet<number>, onUnauthorized?: (attempt: UnauthorizedAttempt) => void) {
    if (allowedUserIds.size === 0) {
      throw new Error("AccessGuard requires at least one allowed user ID.");
    }
    this.allowed = allowedUserIds;
    this.onUnauthorized = onUnauthorized ?? (() => {});
  }

  isAllowed(userId: number): boolean {
    return this.allowed.has(userId);
  }

  /**
   * Checks access and reports the attempt if denied.
   * Returns true when the caller should proceed handling the update.
   */
  check(params: {
    userId: number;
    username?: string;
    firstName?: string;
    chatId: number;
  }): boolean {
    if (this.isAllowed(params.userId)) {
      return true;
    }

    this.onUnauthorized({
      userId: params.userId,
      username: params.username,
      firstName: params.firstName,
      chatId: params.chatId,
      timestamp: Date.now(),
    });

    return false;
  }
}
