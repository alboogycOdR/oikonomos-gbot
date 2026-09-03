// TASK-107 (Chat-1c): compose box — textarea + send button, disabled while
// a message is in flight, Enter-to-send / Shift+Enter-newline (spec §5).
// Only a `disabled` prop and an `onSend` callback for now — Chat-1d wires
// this to a real POST /threads/:id/messages call.
import { useState, type KeyboardEvent } from "react";

export interface ComposeBoxProps {
  disabled?: boolean;
  onSend?: (body: string) => void;
  placeholder?: string;
}

export function ComposeBox({
  disabled = false,
  onSend,
  placeholder = "Message your bot…",
}: ComposeBoxProps) {
  const [value, setValue] = useState("");

  const trySend = () => {
    const trimmed = value.trim();
    if (trimmed.length === 0 || disabled) return;
    onSend?.(trimmed);
    setValue("");
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      trySend();
    }
  };

  return (
    <form
      className="flex items-end gap-2 border-t border-chrome-border bg-chrome-panel p-3"
      onSubmit={(event) => {
        event.preventDefault();
        trySend();
      }}
    >
      <textarea
        aria-label="Message"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        placeholder={placeholder}
        rows={1}
        className="max-h-40 flex-1 resize-none rounded-xl border border-chrome-border bg-surface-raised px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-bubble-user disabled:opacity-50"
      />
      <button
        type="submit"
        disabled={disabled || value.trim().length === 0}
        className="rounded-xl bg-bubble-user px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        Send
      </button>
    </form>
  );
}
