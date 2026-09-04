import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApprovalCard } from "./ApprovalCard";
import type { ApprovalRender } from "./types";

const PENDING: ApprovalRender = {
  nonce: "nonce-secret-abc",
  actionRender:
    "**Send email** to <finance@basileia.example>\n[click here](javascript:alert(1))",
  status: "pending",
};

/** TASK-118: capability+tier present, as the real /threads/:id/messages projection now sends. */
const PENDING_WITH_GRANT_DATA = {
  ...PENDING,
  capabilityId: "email.send",
  maxTier: "T3_external",
};
const ROLE_ID = "chat-bot";

/**
 * TASK-109 AC coverage: `action_render` renders verbatim as plain text
 * (never interpreted as Markdown/HTML — same rule TASK-082 proved for the
 * Telegram gateway); Approve/Reject call the real decide endpoint with
 * the real nonce which never leaks into the URL bar, browser history, or
 * persisted storage (same standard TASK-103 proved for the ops approvals
 * page); a second decide on an already-decided approval (409) is handled
 * gracefully.
 */
describe("ApprovalCard", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();
  });

  it("renders action_render verbatim as literal text, not interpreted Markdown/HTML", () => {
    render(<ApprovalCard approval={PENDING} />);

    // The raw string — including the Markdown/HTML-looking syntax —
    // appears as literal text content of the <pre>.
    const rendered = screen.getByTestId("approval-card-render");
    expect(rendered.textContent).toBe(PENDING.actionRender);

    // It must never have been interpreted: no anchor/link element and no
    // bold element produced from the embedded syntax.
    expect(rendered.querySelector("a")).toBeNull();
    expect(rendered.querySelector("strong")).toBeNull();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("approves via POST /approvals/:nonce/decide with the real nonce, never leaking it into the URL, history, or storage", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      expect(url).toContain("/approvals/");
      expect(url).toContain(encodeURIComponent(PENDING.nonce));
      const body = JSON.parse(String(init?.body)) as { decision: string };
      expect(body.decision).toBe("granted");
      return new Response(
        JSON.stringify({
          decided: true,
          approval: { nonce: PENDING.nonce, status: "granted" },
        }),
        { status: 200 },
      );
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<ApprovalCard approval={PENDING} />);
    await user.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(screen.getByText(/Approved/)).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Nonce discipline: never in the address bar / history / persisted storage.
    expect(window.location.href).not.toContain(PENDING.nonce);
    expect(window.location.pathname).not.toContain(PENDING.nonce);
    expect(localStorage.getItem(PENDING.nonce)).toBeNull();
    expect(Object.values(localStorage).join()).not.toContain(PENDING.nonce);
    expect(Object.values(sessionStorage).join()).not.toContain(PENDING.nonce);

    // Buttons disappear once decided — no re-decide affordance shown.
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reject" })).not.toBeInTheDocument();
  });

  it("handles a second decide on an already-decided approval (409) gracefully", async () => {
    const user = userEvent.setup();
    global.fetch = vi.fn(async () => new Response(null, { status: 409 })) as unknown as typeof fetch;

    render(<ApprovalCard approval={PENDING} />);
    await user.click(screen.getByRole("button", { name: "Reject" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Already decided or no longer valid."),
    );
    // Buttons are disabled/removed rather than left clickable against a
    // stale pending state.
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reject" })).not.toBeInTheDocument();
  });

  it("shows a decided approval's status with no action buttons", () => {
    render(
      <ApprovalCard approval={{ ...PENDING, status: "approved" }} />,
    );
    expect(screen.getByText(/Status: Approved/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reject" })).not.toBeInTheDocument();
  });

  it("hides Always Allow when capability/tier/roleId aren't available", () => {
    render(<ApprovalCard approval={PENDING} />);
    expect(screen.queryByRole("button", { name: "Always Allow" })).not.toBeInTheDocument();
  });

  /**
   * TASK-118 AC coverage: clicking "Always Allow" decides the approval via
   * the exact same `POST /approvals/:nonce/decide` call "Approve" makes
   * (reused, not duplicated), then writes a standing grant via
   * `POST /roles/:roleId/grants` — and the nonce discipline TASK-109
   * proved never leaks into the URL/history/storage, extended here to
   * cover this new decide+grant path too.
   */
  it("Always Allow decides the approval AND writes a standing grant, with the nonce never leaking", async () => {
    const user = userEvent.setup();
    const calls: { url: string; body: unknown }[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as unknown);
      calls.push({ url, body });
      if (url.includes("/approvals/")) {
        expect(url).toContain(encodeURIComponent(PENDING.nonce));
        expect((body as { decision: string }).decision).toBe("granted");
        return new Response(
          JSON.stringify({ decided: true, approval: { nonce: PENDING.nonce, status: "granted" } }),
          { status: 200 },
        );
      }
      expect(url).toBe(`/roles/${ROLE_ID}/grants`);
      expect(body).toEqual({ capabilityId: "email.send", maxTier: "T3_external" });
      return new Response(
        JSON.stringify({ roleId: ROLE_ID, capabilityId: "email.send", maxTier: "T3_external", constraints: {} }),
        { status: 201 },
      );
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<ApprovalCard approval={PENDING_WITH_GRANT_DATA} roleId={ROLE_ID} />);
    await user.click(screen.getByRole("button", { name: "Always Allow" }));

    await waitFor(() => expect(screen.getByText(/Approved/)).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // decide is called before the grant write (Approve's exact call path, reused first).
    expect(calls[0]!.url).toContain("/approvals/");
    expect(calls[1]!.url).toBe(`/roles/${ROLE_ID}/grants`);

    expect(window.location.href).not.toContain(PENDING.nonce);
    expect(window.location.pathname).not.toContain(PENDING.nonce);
    expect(localStorage.getItem(PENDING.nonce)).toBeNull();
    expect(Object.values(localStorage).join()).not.toContain(PENDING.nonce);
    expect(Object.values(sessionStorage).join()).not.toContain(PENDING.nonce);
    // the grant call body never carries the nonce either.
    expect(JSON.stringify(calls[1]!.body)).not.toContain(PENDING.nonce);

    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Always Allow" })).not.toBeInTheDocument();
  });

  it("Always Allow surfaces a 409 (already decided) without writing a grant", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain("/approvals/");
      return new Response(null, { status: 409 });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<ApprovalCard approval={PENDING_WITH_GRANT_DATA} roleId={ROLE_ID} />);
    await user.click(screen.getByRole("button", { name: "Always Allow" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Already decided or no longer valid."),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
