import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
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

  it("passes saved avatar tokens to sidebar avatars", () => {
    render(<BotSidebar bots={[{ ...fixtureBots[0]!, avatarColor: "pink", avatarShape: "star" }]} />);
    expect(screen.getByLabelText(`${fixtureBots[0]!.name} avatar`)).toHaveAttribute("data-avatar-shape", "star");
  });

  it("opens a bot-pair entry as a read-only handoff transcript", async () => {
    const pair = {
      id: "bot_pair:role-a:role-b",
      name: "Alpha and Beta",
      avatarSeed: "pair",
      updatedAt: "2026-09-25T10:00:00.000Z",
      lastMessagePreview: "Please review this.",
      isGroup: true,
      isBotPair: true,
      memberRoleIds: ["role-a", "role-b"],
      memberNames: ["Alpha", "Beta"],
    };
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/roles/role-a/messages")) {
        return new Response(JSON.stringify([{ messageId: "handoff-1", fromRoleId: "role-a", toRoleId: "role-b", body: "Please review this.", createdAt: "2026-09-25T10:00:00.000Z" }]), { status: 200 });
      }
      if (url.endsWith("/roles")) return new Response(JSON.stringify([{ id: "role-a", name: "Alpha" }, { id: "role-b", name: "Beta" }]), { status: 200 });
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    }) as unknown as typeof fetch;
    const onSelectBot = vi.fn();
    const user = userEvent.setup();

    render(<BotSidebar bots={[pair]} onSelectBot={onSelectBot} />);
    expect(screen.getByLabelText("Alpha and Beta pair avatars")).toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: /alpha and beta/i }));

    const dialog = await screen.findByRole("dialog", { name: /alpha and beta messages/i });
    expect(dialog).toBeInTheDocument();
    await within(dialog).findByText("Please review this.");
    expect(within(dialog).getByLabelText("Alpha avatar")).toBeInTheDocument();
    expect(screen.queryByLabelText("Message")).not.toBeInTheDocument();
    expect(onSelectBot).not.toHaveBeenCalled();
  });

  it("renders the outbound arrow and preserves legacy group selection", async () => {
    const onSelectBot = vi.fn();
    const user = userEvent.setup();
    render(<BotSidebar bots={[{
      id: "legacy-group", name: "Alpha, Beta", avatarSeed: "legacy", updatedAt: "2026-09-25T10:00:00.000Z",
      lastMessagePreview: "Latest group message", isGroup: true, memberNames: ["Alpha", "Beta"],
    }, {
      id: "single", name: "Alpha", avatarSeed: "alpha", updatedAt: "2026-09-25T10:01:00.000Z",
      lastMessagePreview: "Messaged Beta: hello", previewAuthorKind: "bot_outbound",
    }]} onSelectBot={onSelectBot} />);

    expect(screen.getByLabelText("Outbound message")).toHaveTextContent("↗");
    await user.click(screen.getByRole("option", { name: /alpha, beta/i }));
    await waitFor(() => expect(onSelectBot).toHaveBeenCalledWith("legacy-group"));
  });
});
