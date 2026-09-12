// TASK-107 (Chat-1c): three-column chat shell (spec §1, §2, §5) —
// sidebar / conversation / right panel. Static fixture data only; Chat-1d
// (TASK-108) wires this to live GET /threads, GET/POST
// /threads/:id/messages and mounts it at `/`.
//
// This file (not main.tsx/App.tsx, which belong to TASK-108) is the entry
// point that actually pulls in the Tailwind stylesheet, so the design
// system is genuinely wired for anything that renders <ChatShell> —
// including this task's own tests and preview harness.
import "../../index.css";

import type { BotSummary, ChatMessage, MemberSummary, RoutineSummary } from "./types";
import { BotSidebar } from "./BotSidebar";
import { ComposeBox } from "./ComposeBox";
import { ConversationPane } from "./ConversationPane";
import { RightPanel } from "./RightPanel";

/**
 * TASK-122 (Chat-2c) — see ChatPage.tsx's own comment: `BotSummary` is not
 * this task's territory, so group-thread awareness is a local structural
 * extension, not a `types.ts` edit. TASK-126 made the group compose
 * endpoint real, so groups intentionally use the same enabled
 * `ComposeBox` path as 1:1 threads.
 */
interface GroupAwareBotSummary extends BotSummary {
  isGroup?: boolean;
}

export interface ChatShellProps {
  bots: BotSummary[];
  messagesByBotId: Record<string, ChatMessage[]>;
  members: MemberSummary[];
  routines: RoutineSummary[];
  /**
   * TASK-236 (spec §2.1) — the single owner of the active thread id is
   * `ChatPage` (derived from the route). `ChatShell` renders whatever it's
   * told and keeps no state of its own: there is deliberately no
   * `initialActiveBotId`/internal `useState` fallback here anymore — a
   * second copy of this value is exactly the defect this task fixes
   * (`ChatPage.tsx:116` vs the old `ChatShell.tsx:54-64`).
   */
  activeBotId: string | undefined;
  isBotResponding?: boolean;
  /** The active thread's draft text (spec §2.3) — controlled, owned by `ChatPage`/`workspaceState.ts`. */
  draft: string;
  onDraftChange: (value: string) => void;
  onSelectBot?: (botId: string) => void;
  onSend?: (botId: string, body: string) => void;
  onCreateBot?: () => void;
  /** Fired after a bot or group thread is created from the sidebar (spec §2.5) — no reload involved. */
  onThreadCreated?: (result: { threadId: string }) => void;
  /** The dashboard's session cookie expired (401) while creating a bot/group. */
  onUnauthorized?: () => void;
  /**
   * TASK-239 (spec §4.3) — the ACTIVE thread's deterministic failure
   * reason (from the run's terminal audit event / failure note), present
   * only when its latest run is `failed`. `undefined`/`null` renders no
   * banner. Never invented client-side text.
   */
  activeBlockedReason?: string | null;
  /** Re-send the active thread's last message (spec §4.3's "offer only retry (re-send)"). */
  onRetry?: () => void;
  /** TASK-239 (spec §3.2) — clears the server session and drops all workspace state. */
  onLogout?: () => void;
  /** TASK-239 (spec §6.2) — the running dashboard build's own embedded git SHA, shown in the footer. */
  buildSha?: string;
}

export function ChatShell({
  bots,
  messagesByBotId,
  members,
  routines,
  activeBotId,
  isBotResponding = false,
  draft,
  onDraftChange,
  onSelectBot,
  onSend,
  onCreateBot,
  onThreadCreated,
  onUnauthorized,
  activeBlockedReason,
  onRetry,
  onLogout,
  buildSha,
}: ChatShellProps) {
  const activeBot: GroupAwareBotSummary | undefined = bots.find((bot) => bot.id === activeBotId);
  const messages = activeBotId ? (messagesByBotId[activeBotId] ?? []) : [];

  return (
    <div className="flex h-screen w-full flex-col overflow-hidden bg-chrome text-slate-100">
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <BotSidebar
          bots={bots}
          activeBotId={activeBotId}
          onSelectBot={onSelectBot}
          onCreateBot={onCreateBot}
          onThreadCreated={onThreadCreated}
          onUnauthorized={onUnauthorized}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <ConversationPane
            bot={activeBot}
            messages={messages}
            isBotResponding={isBotResponding}
            onUnauthorized={onUnauthorized}
          />
          {/*
           * TASK-239 (spec §4.3) — a failed run's deterministic reason,
           * shown for the active thread only, with the one action that
           * applies: retry (re-send). A pending-approval workspace instead
           * links via its sidebar badge to the already-rendered inline
           * `ApprovalCard` in the transcript above — no separate banner.
           */}
          {activeBlockedReason !== undefined && activeBlockedReason !== null ? (
            <div
              role="alert"
              className="flex items-center justify-between gap-3 border-t border-rose-500/40 bg-rose-500/10 px-5 py-2 text-xs text-rose-200"
            >
              <span>
                <span className="font-semibold uppercase tracking-wide">Run failed:</span>{" "}
                {activeBlockedReason}
              </span>
              <button
                type="button"
                onClick={onRetry}
                className="shrink-0 rounded-md bg-rose-600/80 px-3 py-1 font-medium text-white hover:bg-rose-600"
              >
                Retry
              </button>
            </div>
          ) : null}
          <ComposeBox
            value={draft}
            onChange={onDraftChange}
            disabled={isBotResponding || !activeBot}
            onSend={(body) => activeBotId && onSend?.(activeBotId, body)}
          />
        </div>
        <RightPanel members={members} routines={routines} activeRoleId={activeBot?.roleId} />
      </div>
      {/* TASK-239 (spec §6.2) — the running build's own embedded SHA, plus the logout action (spec §3.2). */}
      <footer className="flex shrink-0 items-center justify-between border-t border-chrome-border bg-chrome-panel px-4 py-1.5 text-[10px] text-slate-500">
        <span>OIKONOMOS · build {buildSha ?? "unknown"}</span>
        <button
          type="button"
          onClick={onLogout}
          className="rounded-md px-2 py-1 font-medium text-slate-400 hover:bg-surface-raised hover:text-slate-200"
        >
          Log out
        </button>
      </footer>
    </div>
  );
}
