import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ChatShell } from "./ChatShell";
import {
  fixtureBots,
  fixtureMembers,
  fixtureMessages,
  fixtureRoutines,
} from "./fixtures";

function messagesByBotId() {
  return fixtureMessages.reduce<Record<string, typeof fixtureMessages>>(
    (acc, message) => {
      (acc[message.threadId] ??= []).push(message);
      return acc;
    },
    {},
  );
}

describe("ChatShell", () => {
  it("renders the three-column layout: sidebar, conversation, right panel", () => {
    render(
      <ChatShell
        bots={fixtureBots}
        messagesByBotId={messagesByBotId()}
        members={fixtureMembers}
        routines={fixtureRoutines}
        initialActiveBotId="bot-research"
      />,
    );

    expect(screen.getByLabelText("Your bots")).toBeInTheDocument();
    expect(
      screen.getByLabelText("Conversation with Research Assistant"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Bot details")).toBeInTheDocument();
  });

  it("lists every fixture bot in the sidebar", () => {
    render(
      <ChatShell
        bots={fixtureBots}
        messagesByBotId={messagesByBotId()}
        members={fixtureMembers}
        routines={fixtureRoutines}
      />,
    );

    const sidebar = screen.getByLabelText("Your bots");
    for (const bot of fixtureBots) {
      expect(within(sidebar).getByText(bot.name)).toBeInTheDocument();
    }
  });

  it("renders a multi-message conversation with distinguishable user/bot bubbles", () => {
    render(
      <ChatShell
        bots={fixtureBots}
        messagesByBotId={messagesByBotId()}
        members={fixtureMembers}
        routines={fixtureRoutines}
        initialActiveBotId="bot-research"
      />,
    );

    const bubbles = screen.getAllByTestId("message-bubble");
    expect(bubbles.length).toBe(
      fixtureMessages.filter((m) => m.threadId === "bot-research").length,
    );
    const userBubbles = bubbles.filter((b) => b.dataset.role === "user");
    const botBubbles = bubbles.filter((b) => b.dataset.role === "bot");
    expect(userBubbles.length).toBeGreaterThan(0);
    expect(botBubbles.length).toBeGreaterThan(0);
  });

  it("switches conversation when a different bot is selected in the sidebar", async () => {
    const user = userEvent.setup();
    render(
      <ChatShell
        bots={fixtureBots}
        messagesByBotId={messagesByBotId()}
        members={fixtureMembers}
        routines={fixtureRoutines}
        initialActiveBotId="bot-research"
      />,
    );

    await user.click(screen.getByRole("option", { name: /Ops Bot/i }));
    expect(
      screen.getByLabelText("Conversation with Ops Bot"),
    ).toBeInTheDocument();
  });

  it("compose box calls onSend with the active bot id and message body, Enter submits", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(
      <ChatShell
        bots={fixtureBots}
        messagesByBotId={messagesByBotId()}
        members={fixtureMembers}
        routines={fixtureRoutines}
        initialActiveBotId="bot-research"
        onSend={onSend}
      />,
    );

    const textarea = screen.getByLabelText("Message");
    await user.type(textarea, "hello there{Enter}");

    expect(onSend).toHaveBeenCalledWith("bot-research", "hello there");
  });

  it("disables the compose box while a bot response is in flight and shows a typing indicator", () => {
    render(
      <ChatShell
        bots={fixtureBots}
        messagesByBotId={messagesByBotId()}
        members={fixtureMembers}
        routines={fixtureRoutines}
        initialActiveBotId="bot-research"
        isBotResponding
      />,
    );

    expect(screen.getByLabelText("Message")).toBeDisabled();
    expect(screen.getByTestId("typing-indicator")).toBeInTheDocument();
  });

  it("right panel switches between Members and Routines tabs", async () => {
    const user = userEvent.setup();
    render(
      <ChatShell
        bots={fixtureBots}
        messagesByBotId={messagesByBotId()}
        members={fixtureMembers}
        routines={fixtureRoutines}
        initialActiveBotId="bot-research"
      />,
    );

    expect(screen.getByLabelText("Members")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Routines" }));
    expect(screen.getByLabelText("Routines")).toBeInTheDocument();
  });

  it("renders an inline approval placeholder for a bot message awaiting approval, never as HTML", () => {
    render(
      <ChatShell
        bots={fixtureBots}
        messagesByBotId={messagesByBotId()}
        members={fixtureMembers}
        routines={fixtureRoutines}
        initialActiveBotId="bot-research"
      />,
    );

    const approval = screen.getByTestId("inline-approval-placeholder");
    expect(approval).toBeInTheDocument();
    // action_render must appear verbatim as text, never parsed as markup.
    expect(approval.querySelector("script")).toBeNull();
    expect(approval.textContent).toContain("Send email to finance@basileia.example");
  });
});
