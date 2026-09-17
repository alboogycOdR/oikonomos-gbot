// TASK-248 (spec §9.4) — the workspace's "Computer" segment: a real, live
// read-only view of the active role's current or most-recent OpenSandbox
// sandbox activity, sourced via `lib/liveAgent.ts`
// (`GET /roles/:roleId/live-agent/status` + the `/live-agent/pty` WS
// viewer), mirroring the mobile app's `LiveAgentScreen` (TASK-171) for the
// web client.
//
// Interactive input deliberately waits on TASK-235 (CDP hand-off +
// exclusivity proof) — this view states that plainly (AC3, spec §10)
// rather than rendering a disabled control that could be mistaken for a
// coming-soon toggle. There is no code path here that could send a byte
// upstream even if a future change tried to bolt one on carelessly:
// `watchLiveAgent` (this task's own client) structurally has no
// send/write method, same reasoning as the server's `relay()` never
// forwarding viewer input.
import { useEffect, useRef, useState } from "react";

import { UnauthorizedError } from "../../../lib/api";
import { getLiveAgentStatus, watchLiveAgent, type LiveAgentSubscription } from "../../../lib/liveAgent";

export type ComputerConnectionState =
  | "loading"
  | "empty"
  | "connecting"
  | "live"
  | "ended"
  | "error";

export interface ComputerViewProps {
  /** The workspace's active role, or `undefined` when no role/bot is selected yet. */
  roleId: string | undefined;
  onUnauthorized: () => void;
}

const CONNECTION_LABEL: Record<ComputerConnectionState, string> = {
  loading: "Checking for a live sandbox…",
  empty: "No active or recent sandboxed run for this bot.",
  connecting: "Connecting…",
  live: "Live",
  ended: "Session ended",
  error: "Connection error",
};

function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour12: false });
}

export function ComputerView({ roleId, onUnauthorized }: ComputerViewProps) {
  const [state, setState] = useState<ComputerConnectionState>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [lastUpdateAt, setLastUpdateAt] = useState<Date | null>(null);
  const [output, setOutput] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (roleId === undefined) {
      setState("empty");
      setErrorMessage(null);
      setOutput("");
      setLastUpdateAt(null);
      return undefined;
    }

    let cancelled = false;
    let subscription: LiveAgentSubscription | undefined;
    setState("loading");
    setErrorMessage(null);
    setOutput("");
    setLastUpdateAt(null);

    getLiveAgentStatus(roleId)
      .then((status) => {
        if (cancelled) return;
        if (!status.available) {
          setState("empty");
          return;
        }
        setState("connecting");
        subscription = watchLiveAgent(
          roleId,
          (chunk) => {
            if (cancelled) return;
            setOutput((prev) => prev + chunk);
            setLastUpdateAt(new Date());
            setState("live");
          },
          () => {
            if (cancelled) return;
            setState("live");
          },
          () => {
            if (cancelled) return;
            // The sandbox session ended or the server closed the stream —
            // leave the transcript visible rather than clearing it (the
            // run happened; its output stays readable), same convention
            // as the mobile screen's onDone handling.
            setState((prev) => (prev === "error" ? prev : "ended"));
          },
          (error) => {
            if (cancelled) return;
            setState("error");
            setErrorMessage(error instanceof Error ? error.message : "Live view connection failed.");
          },
        );
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        setState("error");
        setErrorMessage(error instanceof Error ? error.message : "Could not load the live view.");
      });

    return () => {
      cancelled = true;
      subscription?.close();
    };
  }, [roleId, onUnauthorized]);

  useEffect(() => {
    const node = scrollRef.current;
    if (node === null) return;
    node.scrollTop = node.scrollHeight;
  }, [output]);

  return (
    <section aria-label="Computer" className="flex flex-1 flex-col overflow-hidden p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span
            data-testid="computer-connection-state"
            role="status"
            className={`text-xs font-medium ${
              state === "live"
                ? "text-emerald-400"
                : state === "error"
                  ? "text-red-400"
                  : "text-slate-400"
            }`}
          >
            {CONNECTION_LABEL[state]}
          </span>
          {lastUpdateAt !== null ? (
            <span data-testid="computer-last-update" className="text-[10px] text-slate-500">
              Last update: {formatTime(lastUpdateAt)}
            </span>
          ) : null}
        </div>
      </div>

      <p data-testid="computer-interactive-notice" className="mb-3 text-xs text-slate-500">
        Interactive control is not available in this view yet — you can watch this bot&apos;s sandbox activity, but
        not type into it. (Coming with browser hand-off.)
      </p>

      {errorMessage !== null ? (
        <p role="alert" className="mb-2 text-sm text-red-400">
          {errorMessage}
        </p>
      ) : null}

      {state === "empty" ? (
        <p className="text-sm text-slate-500">No active or recent sandboxed run for this bot.</p>
      ) : (
        <div
          ref={scrollRef}
          data-testid="computer-terminal"
          className="min-h-0 flex-1 overflow-y-auto rounded-lg bg-black p-3"
        >
          <pre className="whitespace-pre-wrap break-words font-mono text-xs text-emerald-300">{output}</pre>
        </div>
      )}
    </section>
  );
}
