import { describe, expect, it } from "vitest";
import type { Role } from "@oikonomos/db";

import { buildRoleSystemPrompt } from "./promptAssembly.js";

// TASK-175 carve: pure-function coverage for the extracted module. The
// end-to-end proof that a real persisted role's identity/instructions reach
// the Agent SDK's systemPrompt option (TASK-156) stays in
// chatRunDriver.test.ts, since it exercises createChatRunDriver end-to-end
// against real Postgres — this file covers buildRoleSystemPrompt itself.
function role(overrides: Partial<Role> = {}): Role {
  return {
    roleId: "role-1",
    tenantId: "basileia",
    name: "Northstar",
    title: "Market Analyst",
    description: "Explains market movements with sources.",
    instructions: null,
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("buildRoleSystemPrompt", () => {
  it("uses the fallback role id and a generic identity line when no role is persisted", () => {
    const prompt = buildRoleSystemPrompt(null, "chat-bot");
    expect(prompt).toContain("You are chat-bot, serving as chat-bot.");
    expect(prompt).toContain("Represent this bot identity clearly and helpfully.");
    expect(prompt).not.toContain("Your custom instructions:");
  });

  it("includes the role's name, title, and description", () => {
    const prompt = buildRoleSystemPrompt(role(), "chat-bot");
    expect(prompt).toContain("You are Northstar, serving as Market Analyst.");
    expect(prompt).toContain("Your role description: Explains market movements with sources.");
  });

  it("appends custom instructions only when present", () => {
    const withInstructions = buildRoleSystemPrompt(role({ instructions: "Always cite sources." }), "chat-bot");
    expect(withInstructions).toContain("Your custom instructions:\nAlways cite sources.");

    const withoutInstructions = buildRoleSystemPrompt(role({ instructions: null }), "chat-bot");
    expect(withoutInstructions).not.toContain("Your custom instructions:");
  });
});
