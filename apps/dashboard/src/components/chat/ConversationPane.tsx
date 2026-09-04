// TASK-107 (Chat-1c) / TASK-109 (Chat-1e): center conversation pane —
// message list, auto-scroll, typing/in-flight indicator (spec §5), and
// inline <ApprovalCard> rendering (spec §4, §5, §6, §7) for messages that
// carry a pending/decided approval.
import { useEffect, useRef } from "react";

import type { BotSummary, ChatMessage } from "./types";
import { MessageBubble } from "./MessageBubble";
import { ApprovalCard } from "./ApprovalCard";

export interface ConversationPaneProps {
  bot?: BotSummary;
  messages: ChatMessage[];
  /** True while a run is in flight for this thread (spec §5 "typing/in-flight indicator"). */
  isBotResponding?: boolean;
  /** Called when the dashboard's session cookie has expired (401) during a decide. */
  onUnauthorized?: () => void;
}

export function ConversationPane({
  bot,
  messages,
  isBotResponding = false,
  onUnauthorized,
}: ConversationPaneProps) {
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // jsdom (unit test environment) doesn't implement scrollIntoView.
    bottomRef.current?.scrollIntoView?.({ block: "end" });
  }, [messages.length, isBotResponding]);

  if (!bot) {
    return (
      <div className="flex flex-1 items-center justify-center bg-surface text-sm text-slate-500">
        Select a bot to start chatting.
      </div>
    );
  }

  return (
    <section
      aria-label={`Conversation with ${bot.name}`}
      className="flex min-w-0 flex-1 flex-col bg-surface"
    >
      <header className="border-b border-chrome-border px-5 py-3">
        <h2 className="text-sm font-semibold text-slate-100">{bot.name}</h2>
        {bot.description ? (
          <p className="text-xs text-slate-500">{bot.description}</p>
        ) : null}
      </header>

      <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
        {messages.map((message) => (
          <div key={message.id} className="space-y-2">
            <MessageBubble message={message} botName={bot.name} />
            {message.approval ? (
              <ApprovalCard
                approval={message.approval}
                roleId={bot.roleId}
                onUnauthorized={onUnauthorized}
              />
            ) : null}
          </div>
        ))}

        {isBotResponding ? (
          <div
            data-testid="typing-indicator"
            className="flex items-center gap-1 pl-10 text-xs text-slate-500"
            aria-live="polite"
          >
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-500 [animation-delay:-0.3s]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-500 [animation-delay:-0.15s]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-500" />
            <span className="ml-1">{bot.name} is typing…</span>
          </div>
        ) : null}
        <div ref={bottomRef} />
      </div>
    </section>
  );
}
