import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/liveAgent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/liveAgent")>();
  return { ...actual, getLiveAgentStatus: vi.fn(), watchLiveAgent: vi.fn() };
});

import { UnauthorizedError } from "../../../lib/api";
import { getLiveAgentStatus, watchLiveAgent, type LiveAgentSubscription } from "../../../lib/liveAgent";
import { ComputerView } from "./ComputerView";

/** Captures the callbacks `ComputerView` wires up to `watchLiveAgent`, so a test can drive them directly, mirroring the fake-socket pattern `lib/liveAgent.test.ts` already uses one layer down. */
function captureWatch(): {
  subscription: LiveAgentSubscription;
  close: ReturnType<typeof vi.fn>;
  emitOutput: (chunk: string) => void;
  emitOpen: () => void;
  emitDone: () => void;
  emitError: (error: unknown) => void;
} {
  let onOutput!: (chunk: string) => void;
  let onOpen: (() => void) | undefined;
  let onDone: (() => void) | undefined;
  let onError: ((error: unknown) => void) | undefined;
  const close = vi.fn();

  vi.mocked(watchLiveAgent).mockImplementation((_roleId, output, open, done, error) => {
    onOutput = output;
    onOpen = open;
    onDone = done;
    onError = error;
    return { close };
  });

  return {
    subscription: { close },
    close,
    emitOutput: (chunk) => act(() => onOutput(chunk)),
    emitOpen: () => act(() => onOpen?.()),
    emitDone: () => act(() => onDone?.()),
    emitError: (error) => act(() => onError?.(error)),
  };
}

describe("ComputerView (TASK-248)", () => {
  beforeEach(() => {
    vi.mocked(getLiveAgentStatus).mockReset();
    vi.mocked(watchLiveAgent).mockReset();
  });

  afterEach(() => vi.restoreAllMocks());

  it("always states plainly that interactive control is not available (AC3, spec §10) — never a disabled control", async () => {
    vi.mocked(getLiveAgentStatus).mockResolvedValue({ available: false });
    render(<ComputerView roleId="bot-1" onUnauthorized={vi.fn()} />);
    const notice = await screen.findByTestId("computer-interactive-notice");
    expect(notice.textContent).toMatch(/not available/i);
    // Never rendered as a disabled interactive control (input/button/textarea).
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("shows the empty state when no active/recent sandbox exists", async () => {
    vi.mocked(getLiveAgentStatus).mockResolvedValue({ available: false });
    render(<ComputerView roleId="bot-1" onUnauthorized={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("computer-connection-state")).toHaveTextContent(/no active/i));
    expect(watchLiveAgent).not.toHaveBeenCalled();
  });

  it("shows the empty state when no role is selected, without calling the status API", () => {
    render(<ComputerView roleId={undefined} onUnauthorized={vi.fn()} />);
    expect(screen.getByTestId("computer-connection-state")).toHaveTextContent(/no active/i);
    expect(getLiveAgentStatus).not.toHaveBeenCalled();
  });

  it("AC1: shows live output from the active role's real run, and updates the last-update time as it arrives", async () => {
    vi.mocked(getLiveAgentStatus).mockResolvedValue({ available: true, state: "Running" });
    const watch = captureWatch();
    render(<ComputerView roleId="bot-1" onUnauthorized={vi.fn()} />);

    await waitFor(() => expect(watchLiveAgent).toHaveBeenCalledWith("bot-1", expect.any(Function), expect.any(Function), expect.any(Function), expect.any(Function)));

    watch.emitOpen();
    await waitFor(() => expect(screen.getByTestId("computer-connection-state")).toHaveTextContent(/live/i));
    expect(screen.queryByTestId("computer-last-update")).not.toBeInTheDocument();

    watch.emitOutput("$ ls\n");
    watch.emitOutput("file.txt\n");
    await waitFor(() => expect(screen.getByTestId("computer-terminal").textContent).toBe("$ ls\nfile.txt\n"));
    expect(screen.getByTestId("computer-last-update")).toBeInTheDocument();
  });

  it("leaves the transcript visible and marks the session ended when the stream closes normally", async () => {
    vi.mocked(getLiveAgentStatus).mockResolvedValue({ available: true, state: "Running" });
    const watch = captureWatch();
    render(<ComputerView roleId="bot-1" onUnauthorized={vi.fn()} />);
    await waitFor(() => expect(watchLiveAgent).toHaveBeenCalled());

    watch.emitOutput("final output\n");
    await waitFor(() => expect(screen.getByTestId("computer-terminal").textContent).toBe("final output\n"));

    watch.emitDone();
    await waitFor(() => expect(screen.getByTestId("computer-connection-state")).toHaveTextContent(/ended/i));
    // The transcript stays — the run happened; its output stays readable.
    expect(screen.getByTestId("computer-terminal").textContent).toBe("final output\n");
  });

  it("shows a connection error message when the stream errors", async () => {
    vi.mocked(getLiveAgentStatus).mockResolvedValue({ available: true, state: "Running" });
    const watch = captureWatch();
    render(<ComputerView roleId="bot-1" onUnauthorized={vi.fn()} />);
    await waitFor(() => expect(watchLiveAgent).toHaveBeenCalled());

    watch.emitError(new Error("socket dropped"));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("socket dropped"));
    expect(screen.getByTestId("computer-connection-state")).toHaveTextContent(/error/i);
  });

  it("calls onUnauthorized and never opens a socket when the status check 401s", async () => {
    vi.mocked(getLiveAgentStatus).mockRejectedValue(new UnauthorizedError());
    const onUnauthorized = vi.fn();
    render(<ComputerView roleId="bot-1" onUnauthorized={onUnauthorized} />);
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));
    expect(watchLiveAgent).not.toHaveBeenCalled();
  });

  it("closes the previous subscription and resets the transcript when the active role changes", async () => {
    vi.mocked(getLiveAgentStatus).mockResolvedValue({ available: true, state: "Running" });
    const first = captureWatch();
    const { rerender } = render(<ComputerView roleId="bot-1" onUnauthorized={vi.fn()} />);
    await waitFor(() => expect(watchLiveAgent).toHaveBeenCalledWith("bot-1", expect.any(Function), expect.any(Function), expect.any(Function), expect.any(Function)));
    first.emitOutput("bot-1 output\n");
    await waitFor(() => expect(screen.getByTestId("computer-terminal").textContent).toBe("bot-1 output\n"));

    const second = captureWatch();
    rerender(<ComputerView roleId="bot-2" onUnauthorized={vi.fn()} />);
    await waitFor(() => expect(watchLiveAgent).toHaveBeenCalledWith("bot-2", expect.any(Function), expect.any(Function), expect.any(Function), expect.any(Function)));

    expect(first.close).toHaveBeenCalledTimes(1);
    // Fresh role starts with a clean transcript, not the previous role's output.
    expect(screen.getByTestId("computer-terminal").textContent).toBe("");
    second.emitOutput("bot-2 output\n");
    await waitFor(() => expect(screen.getByTestId("computer-terminal").textContent).toBe("bot-2 output\n"));
  });
});
