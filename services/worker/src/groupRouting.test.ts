import type { AgentProvider, ProviderEvent } from "@oikonomos/agent-providers";
import { describe, expect, it, vi } from "vitest";

import {
  GROUP_MEMBER_CAP,
  createTierZeroScorer,
  route,
  type GroupMember,
  type ShouldRespondScorer,
} from "./groupRouting.js";

const members: readonly GroupMember[] = [
  { roleId: "writer", name: "Writer", title: "Writer", description: "Writes clear copy." },
  { roleId: "researcher", name: "Researcher", title: "Researcher", description: "Finds sources." },
  { roleId: "reviewer", name: "Reviewer", title: "Reviewer", description: "Checks accuracy." },
];

function scorer(scores: Record<string, number>): ShouldRespondScorer {
  return async ({ member }) => scores[member.roleId]!;
}

describe("route", () => {
  it("routes an unaddressed three-member message to exactly one scored member", async () => {
    const result = await route({
      message: "Please prepare a sourced briefing.",
      members,
      mostRecentResponderRoleId: null,
      scorer: scorer({ writer: 0.2, researcher: 0.9, reviewer: 0.4 }),
    });
    expect(result).toMatchObject({ reason: "scored", recipients: [members[1]] });
  });

  it("routes @everyone to every member and does not invoke the scorer", async () => {
    const score = vi.fn<ShouldRespondScorer>();
    const result = await route({ message: "@everyone status update", members, mostRecentResponderRoleId: null, scorer: score });
    expect(result).toMatchObject({ reason: "everyone", recipients: members });
    expect(score).not.toHaveBeenCalled();
  });

  it("routes two @name tokens to exactly those members", async () => {
    const result = await route({
      message: "@Writer and @reviewer please collaborate.",
      members,
      mostRecentResponderRoleId: null,
      scorer: vi.fn(),
    });
    expect(result).toMatchObject({ reason: "mentioned", recipients: [members[0], members[2]] });
  });

  it("breaks equal scores using the most recent responder", async () => {
    const result = await route({
      message: "Who can help?",
      members,
      mostRecentResponderRoleId: "reviewer",
      scorer: scorer({ writer: 0.5, researcher: 0.2, reviewer: 0.5 }),
    });
    expect(result.recipients).toEqual([members[2]]);
  });

  it("rejects a seven-member group with an explicit cap error", async () => {
    const tooMany = Array.from({ length: GROUP_MEMBER_CAP + 1 }, (_, index) => ({
      roleId: `role-${index}`,
      name: `bot-${index}`,
      title: "Fixture",
      description: "Fixture",
    }));
    await expect(route({ message: "hello", members: tooMany, mostRecentResponderRoleId: null, scorer: vi.fn() })).rejects.toThrow(
      /at most 6 members; received 7/,
    );
  });
});

describe("createTierZeroScorer", () => {
  it("reports classifier spend to the budget sink under the Tier-0 provider", async () => {
    const events: readonly ProviderEvent[] = [
      { type: "text_delta", text: '{"score":0.75}' },
      { type: "turn_complete", sessionId: null, costUsd: 0.001, durationMs: 1, turns: 1 },
    ];
    const provider: AgentProvider = {
      id: "gemini",
      displayName: "Tier 0 fixture",
      defaultModel: "tier-0-fixture",
      availableModels: ["tier-0-fixture"],
      capabilities: { agentic: false, resumableSessions: false, permissionPrompts: false, interruptible: true },
      async *sendPrompt() { yield* events; },
      async interrupt() {},
    };
    const report = vi.fn();
    const score = createTierZeroScorer({ provider, budgetSink: { report }, cwd: "/tmp" });

    await expect(score({ member: members[0]!, message: "Draft an announcement." })).resolves.toBe(0.75);
    expect(report).toHaveBeenCalledWith({ provider: "gemini", model: "tier-0-fixture", costUsd: 0.001, tokens: null });
  });
});
