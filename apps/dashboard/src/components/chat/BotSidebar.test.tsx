import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { BotSidebar } from "./BotSidebar";
import { fixtureBots } from "./fixtures";

describe("BotSidebar", () => {
  it("renders every bot with name and last-message preview", () => {
    render(<BotSidebar bots={fixtureBots} />);
    for (const bot of fixtureBots) {
      expect(screen.getByText(bot.name)).toBeInTheDocument();
      if (bot.lastMessagePreview) {
        expect(screen.getByText(bot.lastMessagePreview)).toBeInTheDocument();
      }
    }
  });

  it("marks the active bot as selected", () => {
    render(<BotSidebar bots={fixtureBots} activeBotId={fixtureBots[0]!.id} />);
    const options = screen.getAllByRole("option");
    expect(options[0]).toHaveAttribute("aria-selected", "true");
  });

  it("calls onSelectBot when a bot is clicked", async () => {
    const onSelectBot = vi.fn();
    const user = userEvent.setup();
    render(<BotSidebar bots={fixtureBots} onSelectBot={onSelectBot} />);

    await user.click(screen.getByText(fixtureBots[1]!.name));
    expect(onSelectBot).toHaveBeenCalledWith(fixtureBots[1]!.id);
  });

  it("calls onCreateBot when '+ New bot' is clicked", async () => {
    const onCreateBot = vi.fn();
    const user = userEvent.setup();
    render(<BotSidebar bots={fixtureBots} onCreateBot={onCreateBot} />);

    await user.click(screen.getByRole("button", { name: "+ New bot" }));
    expect(onCreateBot).toHaveBeenCalled();
  });

  it("shows an empty state when there are no bots", () => {
    render(<BotSidebar bots={[]} />);
    expect(screen.getByText(/No bots yet/i)).toBeInTheDocument();
  });
});
