import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { ConversationPane } from "./ConversationPane";
import { fixtureBots, fixtureMessages } from "./fixtures";

describe("ConversationPane", () => {
  it("shows a placeholder when no bot is selected", () => {
    render(<ConversationPane messages={[]} />);
    expect(screen.getByText(/Select a bot to start chatting/i)).toBeInTheDocument();
  });

  it("renders the bot's messages in order with a header", () => {
    const bot = fixtureBots[0]!;
    const messages = fixtureMessages.filter((m) => m.threadId === bot.id);
    render(<ConversationPane bot={bot} messages={messages} />);

    expect(
      screen.getByRole("heading", { name: bot.name }),
    ).toBeInTheDocument();
    expect(screen.getAllByTestId("message-bubble")).toHaveLength(
      messages.length,
    );
  });

  it("shows the typing indicator only while isBotResponding is true", () => {
    const bot = fixtureBots[0]!;
    const { rerender } = render(
      <ConversationPane bot={bot} messages={[]} isBotResponding={false} />,
    );
    expect(screen.queryByTestId("typing-indicator")).not.toBeInTheDocument();

    rerender(<ConversationPane bot={bot} messages={[]} isBotResponding />);
    expect(screen.getByTestId("typing-indicator")).toBeInTheDocument();
  });
});
