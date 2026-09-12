import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ChatShell, type ChatShellProps } from "./ChatShell";
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

/**
 * TASK-236 (spec §2.1): `ChatShell` is now fully controlled — it keeps no
 * `useState` copy of `activeBotId` or the draft. This harness stands in
 * for `ChatPage`, which is the real single owner of both, so these tests
 * exercise the same contract a real caller relies on.
 */
function ControlledChatShell(
  props: Partial<ChatShellProps> & Pick<ChatShellProps, "bots" | "messagesByBotId">,
) {
  const [activeBotId, setActiveBotId] = useState<string | undefined>(props.activeBotId);
  const [draft, setDraft] = useState(props.draft ?? "");
  return (
    <ChatShell
      members={fixtureMembers}
      routines={fixtureRoutines}
      {...props}
      activeBotId={activeBotId}
      draft={draft}
      onDraftChange={(value) => {
        setDraft(value);
        props.onDraftChange?.(value);
      }}
      onSelectBot={(botId) => {
        setActiveBotId(botId);
        props.onSelectBot?.(botId);
      }}
    />
  );
}

describe("ChatShell", () => {
  it("renders the three-column layout: sidebar, conversation, right panel", () => {
    render(
      <ControlledChatShell
        bots={fixtureBots}
        messagesByBotId={messagesByBotId()}
        activeBotId="bot-research"
      />,
    );

    expect(screen.getByLabelText("Your bots")).toBeInTheDocument();
    expect(
      screen.getByLabelText("Conversation with Research Assistant"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Bot details")).toBeInTheDocument();
  });

  it("lists every fixture bot in the sidebar", () => {
    render(<ControlledChatShell bots={fixtureBots} messagesByBotId={messagesByBotId()} />);

    const sidebar = screen.getByLabelText("Your bots");
    for (const bot of fixtureBots) {
      expect(within(sidebar).getByText(bot.name)).toBeInTheDocument();
    }
  });

  it("renders a multi-message conversation with distinguishable user/bot bubbles", () => {
    render(
      <ControlledChatShell
        bots={fixtureBots}
        messagesByBotId={messagesByBotId()}
        activeBotId="bot-research"
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
      <ControlledChatShell
        bots={fixtureBots}
        messagesByBotId={messagesByBotId()}
        activeBotId="bot-research"
      />,
    );

    await user.click(screen.getByRole("option", { name: /Ops Bot/i }));
    expect(
      screen.getByLabelText("Conversation with Ops Bot"),
    ).toBeInTheDocument();
  });

  it("does not keep its own copy of activeBotId — selecting a bot has no effect without a parent onSelectBot wiring it back", async () => {
    // A bare, uncontrolled-style render (no internal state feeding
    // activeBotId back in) must NOT switch on click — that would mean
    // ChatShell still owns a copy of the selection itself, the exact
    // defect this task fixes.
    const user = userEvent.setup();
    render(
      <ChatShell
        bots={fixtureBots}
        messagesByBotId={messagesByBotId()}
        members={fixtureMembers}
        routines={fixtureRoutines}
        activeBotId="bot-research"
        draft=""
        onDraftChange={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("option", { name: /Ops Bot/i }));
    expect(
      screen.getByLabelText("Conversation with Research Assistant"),
    ).toBeInTheDocument();
  });

  it("compose box calls onSend with the active bot id and message body, Enter submits", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(
      <ControlledChatShell
        bots={fixtureBots}
        messagesByBotId={messagesByBotId()}
        activeBotId="bot-research"
        onSend={onSend}
      />,
    );

    const textarea = screen.getByLabelText("Message");
    await user.type(textarea, "hello there{Enter}");

    expect(onSend).toHaveBeenCalledWith("bot-research", "hello there");
  });

  it("the draft is controlled: typing dispatches onDraftChange, not internal state", async () => {
    const onDraftChange = vi.fn();
    const user = userEvent.setup();
    render(
      <ChatShell
        bots={fixtureBots}
        messagesByBotId={messagesByBotId()}
        members={fixtureMembers}
        routines={fixtureRoutines}
        activeBotId="bot-research"
        draft=""
        onDraftChange={onDraftChange}
      />,
    );

    await user.type(screen.getByLabelText("Message"), "h");
    expect(onDraftChange).toHaveBeenCalledWith("h");
  });

  it("disables the compose box while a bot response is in flight and shows a typing indicator", () => {
    render(
      <ControlledChatShell
        bots={fixtureBots}
        messagesByBotId={messagesByBotId()}
        activeBotId="bot-research"
        isBotResponding
      />,
    );

    expect(screen.getByLabelText("Message")).toBeDisabled();
    expect(screen.getByTestId("typing-indicator")).toBeInTheDocument();
  });

  it("keeps the compose box enabled for a selected group thread", () => {
    render(
      <ControlledChatShell
        bots={[{ ...fixtureBots[0]!, id: "group-thread", name: "Planning group", isGroup: true } as typeof fixtureBots[number]]}
        messagesByBotId={{}}
        activeBotId="group-thread"
      />,
    );

    expect(screen.getByLabelText("Message")).toBeEnabled();
  });

  it("right panel switches between Members and Routines tabs", async () => {
    const user = userEvent.setup();
    render(
      <ControlledChatShell
        bots={fixtureBots}
        messagesByBotId={messagesByBotId()}
        activeBotId="bot-research"
      />,
    );

    expect(screen.getByLabelText("Members")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Routines" }));
    expect(screen.getByLabelText("Routines")).toBeInTheDocument();
  });

  it("renders an inline approval placeholder for a bot message awaiting approval, never as HTML", () => {
    render(
      <ControlledChatShell
        bots={fixtureBots}
        messagesByBotId={messagesByBotId()}
        activeBotId="bot-research"
      />,
    );

    const approval = screen.getByTestId("inline-approval-placeholder");
    expect(approval).toBeInTheDocument();
    // action_render must appear verbatim as text, never parsed as markup.
    expect(approval.querySelector("script")).toBeNull();
    expect(approval.textContent).toContain("Send email to finance@basileia.example");
  });

  // TASK-124 (Grants-1e): the permissions view (TASK-119) is real and
  // tested at the RightPanel level, but was invisible in the live
  // component tree because activeRoleId never reached it. These tests
  // exercise ChatShell's own activeBot derivation end-to-end, not
  // RightPanel in isolation.
  describe("activeRoleId wiring to RightPanel (TASK-124)", () => {
    const botsWithRoles = [
      { ...fixtureBots[0]!, id: "bot-research", roleId: "role-research" },
      { ...fixtureBots[1]!, id: "bot-ops", roleId: "role-ops" },
    ];

    function mockGrantsFetch() {
      return vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/roles/role-research/grants")) {
          return new Response(
            JSON.stringify([{ capabilityId: "email.send", maxTier: "T3_external" }]),
            { status: 200 },
          );
        }
        if (url.endsWith("/roles/role-ops/grants")) {
          return new Response(
            JSON.stringify([{ capabilityId: "deploy.trigger", maxTier: "T2_internal" }]),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      }) as unknown as typeof fetch;
    }

    it("shows real grants in the permissions section when a bot with grants is selected", async () => {
      const originalFetch = global.fetch;
      global.fetch = mockGrantsFetch();
      try {
        render(
          <ControlledChatShell
            bots={botsWithRoles}
            messagesByBotId={messagesByBotId()}
            activeBotId="bot-research"
          />,
        );

        expect(await screen.findByText("email.send")).toBeInTheDocument();
        expect(screen.getByLabelText("Permissions")).toBeInTheDocument();
      } finally {
        global.fetch = originalFetch;
      }
    });

    it("switches the shown grants when a different bot is selected in the sidebar", async () => {
      const originalFetch = global.fetch;
      global.fetch = mockGrantsFetch();
      const user = userEvent.setup();
      try {
        render(
          <ControlledChatShell
            bots={botsWithRoles}
            messagesByBotId={messagesByBotId()}
            activeBotId="bot-research"
          />,
        );

        expect(await screen.findByText("email.send")).toBeInTheDocument();

        await user.click(screen.getByRole("option", { name: /Ops Bot/i }));

        expect(await screen.findByText("deploy.trigger")).toBeInTheDocument();
        expect(screen.queryByText("email.send")).not.toBeInTheDocument();
      } finally {
        global.fetch = originalFetch;
      }
    });
  });
});
