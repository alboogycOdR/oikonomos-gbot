// TASK-122 (Chat-2c) tests for GroupThreadDialog: client-side 2+ selection
// validation, the POST /threads/group happy path (via lib/api.ts's
// createGroupThread), 401 handling, and that group-thread reload lands the
// user on the new group, same pattern as CreateBotDialog.test.tsx.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { GroupThreadDialog } from "./GroupThreadDialog";
import type { BotSummary } from "./types";

const originalReload = window.location.reload;

const bots: BotSummary[] = [
  { id: "thread-a", roleId: "role-a", name: "Alpha", avatarSeed: "role-a", updatedAt: "2026-01-01T00:00:00Z" },
  { id: "thread-b", roleId: "role-b", name: "Beta", avatarSeed: "role-b", updatedAt: "2026-01-01T00:00:00Z" },
  { id: "thread-c", roleId: "role-c", name: "Gamma", avatarSeed: "role-c", updatedAt: "2026-01-01T00:00:00Z" },
];

beforeEach(() => {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...window.location, reload: vi.fn() },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...window.location, reload: originalReload },
  });
});

function mockFetchSequence(responses: Array<{ status: number; body: unknown }>) {
  let call = 0;
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    const response = responses[call] ?? responses[responses.length - 1]!;
    call += 1;
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      json: async () => response.body,
    } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("GroupThreadDialog", () => {
  it("renders nothing when isOpen is false", () => {
    render(<GroupThreadDialog isOpen={false} bots={bots} onClose={vi.fn()} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("rejects fewer than two selected bots client-side without sending a request", async () => {
    const fetchMock = mockFetchSequence([]);
    const user = userEvent.setup();
    render(<GroupThreadDialog isOpen bots={bots} onClose={vi.fn()} />);

    await user.click(screen.getByRole("option", { name: /Alpha/ }));
    await user.click(screen.getByRole("button", { name: "Create group" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/at least two/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("creates a group thread with the selected roleIds, calls onCreated, and reloads on success", async () => {
    const fetchMock = mockFetchSequence([
      {
        status: 201,
        body: {
          id: "group-1",
          memberRoleIds: ["role-a", "role-b"],
          memberNames: ["Alpha", "Beta"],
          title: "Crew",
          lastMessagePreview: "",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      },
    ]);
    const onCreated = vi.fn();
    const user = userEvent.setup();
    render(<GroupThreadDialog isOpen bots={bots} onClose={vi.fn()} onCreated={onCreated} />);

    await user.type(screen.getByLabelText(/Title/), "Crew");
    await user.click(screen.getByRole("option", { name: /Alpha/ }));
    await user.click(screen.getByRole("option", { name: /Beta/ }));
    await user.click(screen.getByRole("button", { name: "Create group" }));

    await waitFor(() => expect(window.location.reload).toHaveBeenCalled());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [call] = fetchMock.mock.calls;
    expect(call![0]).toBe("/threads/group");
    const init = call![1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ roleIds: ["role-a", "role-b"], title: "Crew" });

    expect(onCreated).toHaveBeenCalledWith({ threadId: "group-1" });
  });

  it("shows a server error and does not reload when POST /threads/group fails", async () => {
    mockFetchSequence([{ status: 400, body: { error: "roleIds must contain at least two entries." } }]);
    const user = userEvent.setup();
    render(<GroupThreadDialog isOpen bots={bots} onClose={vi.fn()} />);

    await user.click(screen.getByRole("option", { name: /Alpha/ }));
    await user.click(screen.getByRole("option", { name: /Beta/ }));
    await user.click(screen.getByRole("button", { name: "Create group" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("roleIds must contain at least two entries.");
    expect(window.location.reload).not.toHaveBeenCalled();
  });

  it("calls onUnauthorized and does not reload on a 401", async () => {
    mockFetchSequence([{ status: 401, body: {} }]);
    const onUnauthorized = vi.fn();
    const user = userEvent.setup();
    render(<GroupThreadDialog isOpen bots={bots} onClose={vi.fn()} onUnauthorized={onUnauthorized} />);

    await user.click(screen.getByRole("option", { name: /Alpha/ }));
    await user.click(screen.getByRole("option", { name: /Beta/ }));
    await user.click(screen.getByRole("button", { name: "Create group" }));

    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled());
    expect(window.location.reload).not.toHaveBeenCalled();
  });

  it("calls onClose when Cancel is clicked", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<GroupThreadDialog isOpen bots={bots} onClose={onClose} />);

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
  });
});
