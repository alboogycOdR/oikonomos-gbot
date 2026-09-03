// TASK-107 (Chat-1c): center conversation pane — message list, auto-scroll,
// typing/in-flight indicator (spec §5). Static fixture data only.
//
// Inline approval rendering: spec §5 assigns a dedicated <ApprovalCard>
// to Chat-1e (TASK-109), which owns ApprovalCard.tsx and its wiring point
// here. Until that file exists this task renders `message.approval`
// verbatim (never re-interpreted as Markdown/HTML, per spec §5's
// ApprovalCard rule carried forward) as a plain fixture-only placeholder
// so the three-column layout is visually complete for this task's review;
// TASK-109 replaces this block with the real <ApprovalCard>.
import { useEffect, useRef } from "react";

import type { BotSummary, ChatMessage } from "./types";
import { MessageBubble } from "./MessageBubble";

export interface ConversationPaneProps {
  bot?: BotSummary;
  messages: ChatMessage[];
  /** True while a run is in flight for this thread (spec §5 "typing/in-flight indicator"). */
  isBotResponding?: boolean;
}

export function ConversationPane({
  bot,
  messages,
  isBotResponding = false,
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
              <div
                data-testid="inline-approval-placeholder"
                className="ml-10 max-w-[70%] rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-xs text-amber-200"
              >
                <p className="mb-1 font-semibold uppercase tracking-wide">
                  Approval needed
                </p>
                <pre className="whitespace-pre-wrap font-mono text-[11px] text-amber-100">
                  {message.approval.actionRender}
                </pre>
                <p className="mt-1 text-amber-300/80">
                  Status: {message.approval.status} — wired in TASK-109.
                </p>
              </div>
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
