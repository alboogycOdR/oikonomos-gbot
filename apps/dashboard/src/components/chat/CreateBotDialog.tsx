// TASK-110 (Chat-1f): "Create bot" flow (spec §1.4, §5, §6). A minimal
// name + description dialog that creates a bot (`POST /roles`) and
// immediately opens a working conversation with it (`POST /threads`) —
// no tier/capability picker, matching spec §1's "no manifest, role
// definition, or routine authored by the user first" bar. The created
// role gets zero `role_grants` server-side (fail-closed default,
// enforced in services/control-api/src/app.ts's `POST /roles` handler,
// not here) — this dialog never sends or exposes a tier/capability field.
//
// This component talks to control-api directly with a small local fetch
// helper mirroring lib/api.ts's own conventions (same-origin credentials,
// same BASE_URL env var, same UnauthorizedError shape reused by import so
// 401 handling matches the rest of the app) rather than adding exports to
// `lib/api.ts` (still outside this task's Owned_Paths).
//
// TASK-236 (spec §2.5, AC "refreshes the thread list without reload"): on
// success this now calls `onCreated` only — no `window.location.reload()`.
// A full reload used to be how `ChatPage`'s old mount effect picked up the
// new thread; `ChatPage` now refreshes `GET /threads` and navigates to the
// new thread's route itself in response to `onCreated`, so the SPA never
// drops its in-memory state (other threads' drafts, open streams) just to
// show one new thread.
import { useId, useRef, useState, type FormEvent } from "react";

import { UnauthorizedError } from "../../lib/api";

const BASE_URL: string =
  (import.meta.env.VITE_CONTROL_API_BASE_URL as string | undefined) ?? "";

interface CreatedRole {
  id: string;
  name: string;
  description: string;
  avatarSeed: string;
}

interface CreatedThread {
  id: string;
  roleId: string;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.status === 401) {
    throw new UnauthorizedError();
  }
  if (!response.ok) {
    let message = `request to ${path} failed with ${response.status}`;
    try {
      const errorBody = (await response.json()) as { error?: string };
      if (errorBody.error !== undefined) {
        message = errorBody.error;
      }
    } catch {
      // response body wasn't JSON; keep the generic message.
    }
    throw new Error(message);
  }
  return (await response.json()) as T;
}

export interface CreateBotDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** Called after the role + thread are both created, before the reload. */
  onCreated?: (result: { role: CreatedRole; threadId: string }) => void;
  /** Called when the dashboard session cookie has expired (401). */
  onUnauthorized?: () => void;
}

export function CreateBotDialog({
  isOpen,
  onClose,
  onCreated,
  onUnauthorized,
}: CreateBotDialogProps) {
  const titleId = useId();
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!isOpen) {
    return null;
  }

  function resetAndClose() {
    setName("");
    setDescription("");
    setValidationError(null);
    setSubmitError(null);
    setSubmitting(false);
    onClose();
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      setValidationError("Give your bot a name before creating it.");
      nameInputRef.current?.focus();
      return;
    }
    setValidationError(null);
    setSubmitError(null);
    setSubmitting(true);
    try {
      const role = await postJson<CreatedRole>("/roles", {
        name: trimmedName,
        description: description.trim(),
      });
      const thread = await postJson<CreatedThread>("/threads", { roleId: role.id });
      onCreated?.({ role, threadId: thread.id });
      // No reload anymore (TASK-236): reset local form state so a
      // subsequent open of this same long-lived component instance starts
      // fresh, exactly as `resetAndClose` does for Cancel.
      setName("");
      setDescription("");
      setSubmitting(false);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized?.();
        return;
      }
      setSubmitError(err instanceof Error ? err.message : "failed to create bot");
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
          Create a bot
        </h2>
        <form onSubmit={(event) => void handleSubmit(event)}>
          <label className="mb-1 block text-xs font-medium text-slate-300" htmlFor={`${titleId}-name`}>
            Name
          </label>
          <input
            id={`${titleId}-name`}
            ref={nameInputRef}
            type="text"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              if (validationError !== null) setValidationError(null);
            }}
            disabled={submitting}
            placeholder="e.g. Research Assistant"
            className="mb-3 w-full rounded-md border border-chrome-border bg-surface-raised px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-bubble-user disabled:opacity-50"
          />

          <label
            className="mb-1 block text-xs font-medium text-slate-300"
            htmlFor={`${titleId}-description`}
          >
            Description <span className="text-slate-500">(optional)</span>
          </label>
          <textarea
            id={`${titleId}-description`}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            disabled={submitting}
            rows={3}
            placeholder="What should this bot help with?"
            className="mb-3 w-full resize-none rounded-md border border-chrome-border bg-surface-raised px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-bubble-user disabled:opacity-50"
          />

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
              {submitting ? "Creating…" : "Create bot"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
