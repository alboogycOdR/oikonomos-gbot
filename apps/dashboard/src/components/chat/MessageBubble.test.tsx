import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { MessageBubble } from "./MessageBubble";
import type { ChatMessage } from "./types";

const userMessage: ChatMessage = {
  id: "m1",
  threadId: "t1",
  role: "user",
  body: "hello",
  createdAt: "2026-09-02T18:31:00Z",
};

const botMessage: ChatMessage = {
  id: "m2",
  threadId: "t1",
  role: "bot",
  body: "hi there",
  createdAt: "2026-09-02T18:31:30Z",
};

describe("MessageBubble", () => {
  it("renders a user bubble aligned to the right (row-reverse)", () => {
    render(<MessageBubble message={userMessage} />);
    const bubble = screen.getByTestId("message-bubble");
    expect(bubble.dataset.role).toBe("user");
    expect(bubble.className).toContain("flex-row-reverse");
    expect(screen.getByText("hello")).toBeInTheDocument();
  });

  it("renders a bot bubble aligned to the left with the bot's name in the avatar label", () => {
    render(<MessageBubble message={botMessage} botName="Research Assistant" />);
    const bubble = screen.getByTestId("message-bubble");
    expect(bubble.dataset.role).toBe("bot");
    expect(
      screen.getByLabelText("Research Assistant avatar"),
    ).toBeInTheDocument();
    expect(screen.getByText("hi there")).toBeInTheDocument();
  });

  it("renders a visible timestamp", () => {
    render(<MessageBubble message={userMessage} />);
    const time = screen.getByText(/\d{1,2}:\d{2}/);
    expect(time.tagName.toLowerCase()).toBe("time");
  });
});
