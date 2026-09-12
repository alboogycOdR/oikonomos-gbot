// TASK-122 (Chat-2c): "New group" flow (specs/OIKONOMOS_CHAT_SURFACE_v1.0.md
// §8 group threads, WBS OIK-150) — multi-selects 2+ existing bots and calls
// `POST /threads/group` (TASK-121/`lib/api.ts`'s `createGroupThread`),
// mirroring `CreateBotDialog.tsx` (TASK-110)'s own dialog pattern.
//
// TASK-236 (spec §2.5): on success this calls `onCreated` only — no
// `window.location.reload()`. See `CreateBotDialog.tsx`'s own TASK-236
// note for why: `ChatPage` refreshes `GET /threads` and navigates to the
// new thread itself, without dropping other threads' in-memory state.
import { useId, useState, type FormEvent } from "react";

import { UnauthorizedError, createGroupThread } from "../../lib/api";
import type { BotSummary } from "./types";
import { Avatar } from "./Avatar";

export interface GroupThreadDialogProps {
  isOpen: boolean;
  /** Candidate bots to select from — real (non-group) bots only. */
  bots: BotSummary[];
  onClose: () => void;
  /** Called after the group thread is created, before the reload. */
  onCreated?: (result: { threadId: string }) => void;
  /** Called when the dashboard session cookie has expired (401). */
  onUnauthorized?: () => void;
}

export function GroupThreadDialog({
  isOpen,
  bots,
  onClose,
  onCreated,
  onUnauthorized,
}: GroupThreadDialogProps) {
  const titleId = useId();
  const [title, setTitle] = useState("");
  const [selectedRoleIds, setSelectedRoleIds] = useState<string[]>([]);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!isOpen) {
    return null;
  }

  function resetAndClose() {
    setTitle("");
    setSelectedRoleIds([]);
    setValidationError(null);
    setSubmitError(null);
    setSubmitting(false);
    onClose();
  }

  function toggleRole(roleId: string) {
    setSelectedRoleIds((prev) =>
      prev.includes(roleId) ? prev.filter((id) => id !== roleId) : [...prev, roleId],
    );
    if (validationError !== null) setValidationError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (selectedRoleIds.length < 2) {
      setValidationError("Select at least two bots to start a group.");
      return;
    }
    setValidationError(null);
    setSubmitError(null);
    setSubmitting(true);
    try {
      const trimmedTitle = title.trim();
      const thread = await createGroupThread(
        selectedRoleIds,
        trimmedTitle.length > 0 ? trimmedTitle : undefined,
      );
      onCreated?.({ threadId: thread.id });
      // No reload anymore (TASK-236) — reset local form state for the
      // next open of this same long-lived component instance.
      setTitle("");
      setSelectedRoleIds([]);
      setSubmitting(false);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized?.();
        return;
      }
      setSubmitError(err instanceof Error ? err.message : "failed to create group");
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(event) => {
        if (event.target === event.currentTarget && !submitting) {
          resetAndClose();
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-sm rounded-xl border border-chrome-border bg-chrome-panel p-5 shadow-xl"
      >
        <h2 id={titleId} className="mb-4 text-sm font-semibold tracking-wide text-slate-100">
          New group
        </h2>
        <form onSubmit={(event) => void handleSubmit(event)}>
          <label
            className="mb-1 block text-xs font-medium text-slate-300"
            htmlFor={`${titleId}-title`}
          >
            Title <span className="text-slate-500">(optional)</span>
          </label>
          <input
            id={`${titleId}-title`}
            type="text"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            disabled={submitting}
            placeholder="e.g. Research crew"
            className="mb-3 w-full rounded-md border border-chrome-border bg-surface-raised px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-bubble-user disabled:opacity-50"
          />

          <p className="mb-1 text-xs font-medium text-slate-300">Bots</p>
          <ul
            role="listbox"
            aria-multiselectable="true"
            aria-label="Select bots for the group"
            className="mb-3 max-h-48 overflow-y-auto rounded-md border border-chrome-border"
          >
            {bots.map((bot) => {
              const roleId = bot.roleId;
              if (roleId === undefined) return null;
              const isSelected = selectedRoleIds.includes(roleId);
              return (
                <li key={bot.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    disabled={submitting}
                    onClick={() => toggleRole(roleId)}
                    className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm disabled:opacity-50 ${
                      isSelected ? "bg-surface-raised" : "hover:bg-surface-raised/60"
                    }`}
                  >
                    <input type="checkbox" checked={isSelected} readOnly className="pointer-events-none" />
                    <Avatar seed={bot.avatarSeed} name={bot.name} size="sm" />
                    <span className="truncate text-slate-100">{bot.name}</span>
                  </button>
                </li>
              );
            })}
            {bots.length === 0 ? (
              <li className="px-3 py-4 text-center text-xs text-slate-500">
                Create at least two bots before starting a group.
              </li>
            ) : null}
          </ul>

          {validationError !== null ? (
            <p role="alert" className="mb-3 text-xs text-red-400">
              {validationError}
            </p>
          ) : null}
          {submitError !== null ? (
            <p role="alert" className="mb-3 text-xs text-red-400">
              {submitError}
            </p>
          ) : null}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={resetAndClose}
              disabled={submitting}
              className="rounded-md px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-surface-raised disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="rounded-md bg-bubble-user px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? "Creating…" : "Create group"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
