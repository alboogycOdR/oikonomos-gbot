// TASK-107 (Chat-1c): compose box — textarea + send button, disabled while
// a message is in flight, Enter-to-send / Shift+Enter-newline (spec §5).
//
// TASK-236 (Workspace-1 §2.3): fully controlled — the draft text lives in
// `workspaceState.ts`, owned by `ChatPage`, keyed by thread id. This
// component no longer holds its own `useState` copy of the text: the old
// internal state cleared the textarea the instant `onSend` was called,
// before the (void, fire-and-forget) POST resolved, so a failed send lost
// the user's words with no way to recover them. Clearing now happens only
// when the parent's state says the send succeeded (a new, empty `value`
// prop arrives); a failed send leaves `value` — and therefore the
// textarea — untouched.
import type { KeyboardEvent } from "react";

export interface ComposeBoxProps {
  /** The current draft text for the active thread. Fully controlled. */
  value: string;
  /** Called on every keystroke; the parent is the source of truth for the draft. */
  onChange: (value: string) => void;
  disabled?: boolean;
  onSend?: (body: string) => void;
  placeholder?: string;
}

export function ComposeBox({
  value,
  onChange,
  disabled = false,
  onSend,
  placeholder = "Message your bot…",
}: ComposeBoxProps) {
  const trySend = () => {
    const trimmed = value.trim();
    if (trimmed.length === 0 || disabled) return;
    onSend?.(trimmed);
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
        onChange={(event) => onChange(event.target.value)}
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
