import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { RightPanel } from "./RightPanel";
import { fixtureMembers, fixtureRoutines } from "./fixtures";

const ROLE_ID = "role-marketing-bot";

describe("RightPanel", () => {
  it("defaults to the Members tab, listing every member", () => {
    render(<RightPanel members={fixtureMembers} routines={fixtureRoutines} />);
    expect(screen.getByRole("tab", { name: "Members" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    for (const member of fixtureMembers) {
      expect(screen.getByText(member.name)).toBeInTheDocument();
    }
  });

  it("switches to Routines and lists every routine", async () => {
    const user = userEvent.setup();
    render(<RightPanel members={fixtureMembers} routines={fixtureRoutines} />);

    await user.click(screen.getByRole("tab", { name: "Routines" }));
    expect(screen.getByRole("tab", { name: "Routines" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    for (const routine of fixtureRoutines) {
      expect(screen.getByText(routine.name)).toBeInTheDocument();
    }
  });

  it("collapses to a zero-width panel when collapsed=true", () => {
    render(
      <RightPanel
        members={fixtureMembers}
        routines={fixtureRoutines}
        collapsed
      />,
    );
    expect(screen.getByLabelText("Panel (collapsed)")).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });

  describe("permissions (TASK-119)", () => {
    const originalFetch = global.fetch;

    beforeEach(() => {
      // no-op: kept symmetric with afterEach for clarity
    });

    afterEach(() => {
      global.fetch = originalFetch;
      vi.restoreAllMocks();
    });

    it("does not render a permissions section without an activeRoleId", () => {
      render(<RightPanel members={fixtureMembers} routines={fixtureRoutines} />);
      expect(screen.queryByText("Permissions")).not.toBeInTheDocument();
    });

    it("fetches and lists the active bot's real grants (not fixture data)", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => [
          { capabilityId: "email.send", maxTier: "T3_external" },
          { capabilityId: "calendar.read", maxTier: "T1_internal" },
        ],
      }) as unknown as typeof fetch;

      render(
        <RightPanel
          members={fixtureMembers}
          routines={fixtureRoutines}
          activeRoleId={ROLE_ID}
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("email.send")).toBeInTheDocument();
      });
      expect(screen.getByText("calendar.read")).toBeInTheDocument();
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining(`/roles/${ROLE_ID}/grants`),
        expect.objectContaining({ credentials: "same-origin" }),
      );
    });

    it("revoking a grant calls DELETE and removes the row after the fetch resolves", async () => {
      const user = userEvent.setup();
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => [{ capabilityId: "email.send", maxTier: "T3_external" }],
        })
        .mockResolvedValueOnce({ ok: true, status: 204 }) as unknown as typeof fetch;

      render(
        <RightPanel
          members={fixtureMembers}
          routines={fixtureRoutines}
          activeRoleId={ROLE_ID}
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("email.send")).toBeInTheDocument();
      });

      await user.click(screen.getByRole("button", { name: "Revoke" }));

      await waitFor(() => {
        expect(screen.queryByText("email.send")).not.toBeInTheDocument();
      });
      expect(global.fetch).toHaveBeenLastCalledWith(
        expect.stringContaining(`/roles/${ROLE_ID}/grants/email.send`),
        expect.objectContaining({ method: "DELETE", credentials: "same-origin" }),
      );
      expect(screen.getByText("No standing grants.")).toBeInTheDocument();
    });

    it("shows an error and keeps the row when revoke fails", async () => {
      const user = userEvent.setup();
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => [{ capabilityId: "email.send", maxTier: "T3_external" }],
        })
        .mockResolvedValueOnce({ ok: false, status: 500 }) as unknown as typeof fetch;

      render(
        <RightPanel
          members={fixtureMembers}
          routines={fixtureRoutines}
          activeRoleId={ROLE_ID}
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("email.send")).toBeInTheDocument();
      });

      await user.click(screen.getByRole("button", { name: "Revoke" }));

      await waitFor(() => {
        expect(screen.getByRole("alert")).toBeInTheDocument();
      });
      expect(screen.getByText("email.send")).toBeInTheDocument();
    });
  });
});
