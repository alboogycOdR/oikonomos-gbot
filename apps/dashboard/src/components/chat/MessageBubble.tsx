// TASK-107 (Chat-1c): distinguishable user/bot chat bubble (spec §2, §5).
import type { ChatMessage } from "./types";
import { Avatar } from "./Avatar";

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export interface MessageBubbleProps {
  message: ChatMessage;
  botName?: string;
}

export function MessageBubble({ message, botName }: MessageBubbleProps) {
  const isUser = message.role === "user";
  return (
    <div
      data-testid="message-bubble"
      data-role={message.role}
      className={`flex items-end gap-2 ${isUser ? "flex-row-reverse" : "flex-row"}`}
    >
      <Avatar
        seed={isUser ? "you" : (botName ?? "bot")}
        name={isUser ? "You" : (botName ?? "Bot")}
        size="sm"
      />
      <div
        className={`max-w-[70%] rounded-2xl px-4 py-2 text-sm leading-relaxed shadow-sm ${
          isUser
            ? "rounded-br-sm bg-bubble-user text-white"
            : "rounded-bl-sm bg-bubble-bot text-slate-100"
        }`}
      >
        <p className="whitespace-pre-wrap">{message.body}</p>
        <time
          dateTime={message.createdAt}
          className={`mt-1 block text-[10px] ${isUser ? "text-blue-100/80" : "text-slate-400"}`}
        >
          {formatTime(message.createdAt)}
        </time>
      </div>
    </div>
  );
}
