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

  it("renders saved color and shape tokens", () => {
    render(<Avatar seed="bot-ops" name="Ops Bot" avatarColor="violet" avatarShape="hexagon" />);
    const avatar = screen.getByLabelText("Ops Bot avatar");
    expect(avatar).toHaveAttribute("data-avatar-color", "violet");
    expect(avatar).toHaveAttribute("data-avatar-shape", "hexagon");
    expect(avatar).toHaveStyle({ backgroundColor: "rgb(139, 92, 246)", clipPath: "polygon(25% 0, 75% 0, 100% 50%, 75% 100%, 25% 100%, 0 50%)" });
  });

  it("falls back to the derived color when persisted tokens are null", () => {
    const { rerender } = render(<Avatar seed="same-seed" name="Bot" />);
    const derived = (screen.getByLabelText("Bot avatar") as HTMLElement).style.backgroundColor;
    rerender(<Avatar seed="same-seed" name="Bot" avatarColor={null} avatarShape={null} />);
    const fallback = screen.getByLabelText("Bot avatar") as HTMLElement;
    expect(fallback.style.backgroundColor).toBe(derived);
    expect(fallback).toHaveAttribute("data-avatar-color", "derived");
  });
});
