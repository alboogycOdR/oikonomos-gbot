// TASK-107 (Chat-1c): persistent left sidebar listing the user's bots
// (spec §1.1, §5). Static fixture data only — GET /threads wiring is
// Chat-1d (TASK-108).
//
// TASK-110 (Chat-1f): "+ New bot" now also opens a self-contained
// `<CreateBotDialog>` (this task's own territory) in addition to still
// calling the optional `onCreateBot` prop unchanged — BotSidebar.test.tsx
// (TASK-107, outside this task's Owned_Paths) asserts `onCreateBot` fires
// directly on click with no dialog involved, so that call is preserved
// exactly as before.
import { useState } from "react";

import type { BotSummary, WorkspaceBadgeKind } from "./types";
import { Avatar } from "./Avatar";
import { CreateBotDialog } from "./CreateBotDialog";
import { GroupThreadDialog } from "./GroupThreadDialog";

/** TASK-239 (spec §4.2) — label + color per badge kind, applied to every background workspace's sidebar row. */
const BADGE_LABEL: Record<WorkspaceBadgeKind, string> = {
  working: "Working",
  waiting_approval: "Approval",
  blocked: "Blocked",
  unread: "New",
};

const BADGE_CLASS: Record<WorkspaceBadgeKind, string> = {
  working: "bg-sky-500/20 text-sky-300",
  waiting_approval: "bg-amber-500/20 text-amber-300",
  blocked: "bg-rose-500/20 text-rose-300",
  unread: "bg-emerald-500/20 text-emerald-300",
};

/**
 * TASK-122 (Chat-2c) — see ChatPage.tsx's own comment: group-thread
 * awareness is a local structural extension of `BotSummary`, not a
 * `types.ts` edit (outside this task's Owned_Paths).
 */
interface GroupAwareBotSummary extends BotSummary {
  isGroup?: boolean;
  memberNames?: string[];
}

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
  /**
   * TASK-236 (spec §2.5) — forwarded straight through to
   * `CreateBotDialog`/`GroupThreadDialog`'s own `onCreated` so the parent
   * (`ChatPage`) can refresh the thread list and navigate to the new
   * thread without a full page reload.
   */
  onThreadCreated?: (result: { threadId: string }) => void;
  onUnauthorized?: () => void;
}

export function BotSidebar({
  bots,
  activeBotId,
  onSelectBot,
  onCreateBot,
  onThreadCreated,
  onUnauthorized,
}: BotSidebarProps) {
  const [isCreateDialogOpen, setCreateDialogOpen] = useState(false);
  const [isGroupDialogOpen, setGroupDialogOpen] = useState(false);
  const groupAwareBots = bots as GroupAwareBotSummary[];
  const realBots = groupAwareBots.filter((bot) => bot.isGroup !== true);

  return (
    <aside
      aria-label="Your bots"
      className="flex h-full w-72 shrink-0 flex-col border-r border-chrome-border bg-chrome-panel"
    >
      <div className="flex items-center justify-between border-b border-chrome-border px-4 py-3">
        <h1 className="text-sm font-semibold tracking-wide text-slate-100">
          Your bots
        </h1>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => setGroupDialogOpen(true)}
            className="rounded-md px-2 py-1 text-xs font-medium text-slate-300 hover:bg-surface-raised"
          >
            + New group
          </button>
          <button
            type="button"
            onClick={() => {
              setCreateDialogOpen(true);
              onCreateBot?.();
            }}
            className="rounded-md bg-bubble-user px-2 py-1 text-xs font-medium text-white hover:opacity-90"
          >
            + New bot
          </button>
        </div>
      </div>
      <CreateBotDialog
        isOpen={isCreateDialogOpen}
        onClose={() => setCreateDialogOpen(false)}
        onCreated={(result) => {
          setCreateDialogOpen(false);
          onThreadCreated?.({ threadId: result.threadId });
        }}
        onUnauthorized={onUnauthorized}
      />
      <GroupThreadDialog
        isOpen={isGroupDialogOpen}
        bots={realBots}
        onClose={() => setGroupDialogOpen(false)}
        onCreated={(result) => {
          setGroupDialogOpen(false);
          onThreadCreated?.(result);
        }}
        onUnauthorized={onUnauthorized}
      />
      <ul className="flex-1 overflow-y-auto" role="listbox" aria-label="Bot threads">
        {groupAwareBots.map((bot) => {
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
                      {bot.isGroup === true ? "👥 " : ""}
                      {bot.name}
                    </span>
                    <span className="shrink-0 text-[10px] text-slate-500">
                      {formatRelative(bot.updatedAt)}
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    {bot.lastMessagePreview ? (
                      <span className="block min-w-0 flex-1 truncate text-xs text-slate-400">
                        {bot.lastMessagePreview}
                      </span>
                    ) : null}
                    {/* TASK-239 (spec §4.2) — badge for a background workspace's latest run/activity; never rendered for the active thread (ChatPage.tsx never attaches `status` to it). */}
                    {bot.status !== undefined ? (
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${BADGE_CLASS[bot.status.badge]}`}
                      >
                        {BADGE_LABEL[bot.status.badge]}
                        {bot.status.badge === "waiting_approval" && bot.status.pendingApprovals > 1
                          ? ` (${bot.status.pendingApprovals})`
                          : ""}
                      </span>
                    ) : null}
                  </span>
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
