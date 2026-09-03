// TASK-107 (Chat-1c): persistent left sidebar listing the user's bots
// (spec §1.1, §5). Static fixture data only — GET /threads wiring is
// Chat-1d (TASK-108).
import type { BotSummary } from "./types";
import { Avatar } from "./Avatar";

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const diffMinutes = Math.round((Date.now() - then) / 60000);
  if (diffMinutes < 1) return "just now";
  if (diffMinutes < 60) return `${diffMinutes}m`;
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h`;
  return `${Math.round(diffHours / 24)}d`;
}

export interface BotSidebarProps {
  bots: BotSummary[];
  activeBotId?: string;
  onSelectBot?: (botId: string) => void;
  onCreateBot?: () => void;
}

export function BotSidebar({
  bots,
  activeBotId,
  onSelectBot,
  onCreateBot,
}: BotSidebarProps) {
  return (
    <aside
      aria-label="Your bots"
      className="flex h-full w-72 shrink-0 flex-col border-r border-chrome-border bg-chrome-panel"
    >
      <div className="flex items-center justify-between border-b border-chrome-border px-4 py-3">
        <h1 className="text-sm font-semibold tracking-wide text-slate-100">
          Your bots
        </h1>
        <button
          type="button"
          onClick={onCreateBot}
          className="rounded-md bg-bubble-user px-2 py-1 text-xs font-medium text-white hover:opacity-90"
        >
          + New bot
        </button>
      </div>
      <ul className="flex-1 overflow-y-auto" role="listbox" aria-label="Bot threads">
        {bots.map((bot) => {
          const isActive = bot.id === activeBotId;
          return (
            <li key={bot.id}>
              <button
                type="button"
                role="option"
                aria-selected={isActive}
                onClick={() => onSelectBot?.(bot.id)}
                className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors ${
                  isActive
                    ? "bg-surface-raised"
                    : "hover:bg-surface-raised/60"
                }`}
              >
                <Avatar seed={bot.avatarSeed} name={bot.name} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-sm font-medium text-slate-100">
                      {bot.name}
                    </span>
                    <span className="shrink-0 text-[10px] text-slate-500">
                      {formatRelative(bot.updatedAt)}
                    </span>
                  </span>
                  {bot.lastMessagePreview ? (
                    <span className="block truncate text-xs text-slate-400">
                      {bot.lastMessagePreview}
                    </span>
                  ) : null}
                </span>
              </button>
            </li>
          );
        })}
        {bots.length === 0 ? (
          <li className="px-4 py-6 text-center text-xs text-slate-500">
            No bots yet — create one to start chatting.
          </li>
        ) : null}
      </ul>
    </aside>
  );
}
