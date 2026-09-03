import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { Avatar } from "./Avatar";

describe("Avatar", () => {
  it("renders initials derived from the name", () => {
    render(<Avatar seed="Research Assistant" name="Research Assistant" />);
    expect(screen.getByLabelText("Research Assistant avatar")).toHaveTextContent(
      "RA",
    );
  });

  it("is deterministic for the same seed", () => {
    const { container: a } = render(<Avatar seed="bot-ops" name="Ops Bot" />);
    const { container: b } = render(<Avatar seed="bot-ops" name="Ops Bot" />);
    const colorA = (a.firstChild as HTMLElement).style.backgroundColor;
    const colorB = (b.firstChild as HTMLElement).style.backgroundColor;
    expect(colorA).toBe(colorB);
  });
});
