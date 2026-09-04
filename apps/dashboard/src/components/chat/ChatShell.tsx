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

import { useState } from "react";

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
  initialActiveBotId?: string;
  isBotResponding?: boolean;
  onSelectBot?: (botId: string) => void;
  onSend?: (botId: string, body: string) => void;
  onCreateBot?: () => void;
}

export function ChatShell({
  bots,
  messagesByBotId,
  members,
  routines,
  initialActiveBotId,
  isBotResponding = false,
  onSelectBot,
  onSend,
  onCreateBot,
}: ChatShellProps) {
  const [activeBotId, setActiveBotId] = useState<string | undefined>(
    initialActiveBotId ?? bots[0]?.id,
  );

  const activeBot: GroupAwareBotSummary | undefined = bots.find((bot) => bot.id === activeBotId);
  const messages = activeBotId ? (messagesByBotId[activeBotId] ?? []) : [];

  const handleSelectBot = (botId: string) => {
    setActiveBotId(botId);
    onSelectBot?.(botId);
  };

  return (
    <div className="flex h-screen w-full overflow-hidden bg-chrome text-slate-100">
      <BotSidebar
        bots={bots}
        activeBotId={activeBotId}
        onSelectBot={handleSelectBot}
        onCreateBot={onCreateBot}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <ConversationPane
          bot={activeBot}
          messages={messages}
          isBotResponding={isBotResponding}
        />
        <ComposeBox
          disabled={isBotResponding || !activeBot}
          onSend={(body) => activeBotId && onSend?.(activeBotId, body)}
        />
      </div>
      <RightPanel members={members} routines={routines} activeRoleId={activeBot?.roleId} />
    </div>
  );
}
