// TASK-110 (Chat-1f) tests for CreateBotDialog: client-side validation,
// the POST /roles → POST /threads happy path, 401 handling, and that the
// dialog never sends a tier/capability field (spec §1.4, §6 correction:
// zero role_grants, no tier picker).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { CreateBotDialog } from "./CreateBotDialog";

const originalReload = window.location.reload;

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

describe("CreateBotDialog", () => {
  it("renders nothing when isOpen is false", () => {
    render(<CreateBotDialog isOpen={false} onClose={vi.fn()} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("rejects an empty name client-side without sending a request", async () => {
    const fetchMock = mockFetchSequence([]);
    const user = userEvent.setup();
    render(<CreateBotDialog isOpen onClose={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Create bot" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/name/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a whitespace-only name client-side without sending a request", async () => {
    const fetchMock = mockFetchSequence([]);
    const user = userEvent.setup();
    render(<CreateBotDialog isOpen onClose={vi.fn()} />);

    await user.type(screen.getByLabelText("Name"), "   ");
    await user.click(screen.getByRole("button", { name: "Create bot" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/name/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("creates a role then a thread, calls onCreated, and reloads on success", async () => {
    const fetchMock = mockFetchSequence([
      {
        status: 201,
        body: { id: "role-1", name: "Research Bot", description: "", avatarSeed: "role-1" },
      },
      { status: 201, body: { id: "thread-1", roleId: "role-1" } },
    ]);
    const onCreated = vi.fn();
    const user = userEvent.setup();
    render(<CreateBotDialog isOpen onClose={vi.fn()} onCreated={onCreated} />);

    await user.type(screen.getByLabelText("Name"), "Research Bot");
    await user.click(screen.getByRole("button", { name: "Create bot" }));

    await waitFor(() => expect(window.location.reload).toHaveBeenCalled());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [rolesCall, threadsCall] = fetchMock.mock.calls;
    expect(rolesCall![0]).toBe("/roles");
    const rolesInit = rolesCall![1] as RequestInit;
    const rolesBody = JSON.parse(rolesInit.body as string) as Record<string, unknown>;
    expect(rolesBody).toEqual({ name: "Research Bot", description: "" });
    // No tier/capability field is ever sent — the server assigns zero
    // role_grants unconditionally (spec §6 correction).
    expect(rolesBody).not.toHaveProperty("tier");
    expect(rolesBody).not.toHaveProperty("capability");
    expect(rolesBody).not.toHaveProperty("role_grants");

    expect(threadsCall![0]).toBe("/threads");
    const threadsInit = threadsCall![1] as RequestInit;
    expect(JSON.parse(threadsInit.body as string)).toEqual({ roleId: "role-1" });

    expect(onCreated).toHaveBeenCalledWith({
      role: { id: "role-1", name: "Research Bot", description: "", avatarSeed: "role-1" },
      threadId: "thread-1",
    });
  });

  it("shows a server error and does not reload when POST /roles fails", async () => {
    mockFetchSequence([{ status: 400, body: { error: "name must not be empty." } }]);
    const user = userEvent.setup();
    render(<CreateBotDialog isOpen onClose={vi.fn()} />);

    await user.type(screen.getByLabelText("Name"), "Research Bot");
    await user.click(screen.getByRole("button", { name: "Create bot" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("name must not be empty.");
    expect(window.location.reload).not.toHaveBeenCalled();
  });

  it("calls onUnauthorized and does not reload on a 401", async () => {
    mockFetchSequence([{ status: 401, body: {} }]);
    const onUnauthorized = vi.fn();
    const user = userEvent.setup();
    render(<CreateBotDialog isOpen onClose={vi.fn()} onUnauthorized={onUnauthorized} />);

    await user.type(screen.getByLabelText("Name"), "Research Bot");
    await user.click(screen.getByRole("button", { name: "Create bot" }));

    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled());
    expect(window.location.reload).not.toHaveBeenCalled();
  });

  it("calls onClose when Cancel is clicked", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<CreateBotDialog isOpen onClose={onClose} />);

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
  });
});
