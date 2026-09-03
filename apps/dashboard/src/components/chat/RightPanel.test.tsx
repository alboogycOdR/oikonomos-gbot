import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { RightPanel } from "./RightPanel";
import { fixtureMembers, fixtureRoutines } from "./fixtures";

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
});
