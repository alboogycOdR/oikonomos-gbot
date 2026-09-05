import { describe, expect, it } from "vitest";
import type { Role, Skill } from "@oikonomos/db";

import { assembleSystemPrompt, buildRoleSystemPrompt, extractSkillTokens, formatSkillBlock } from "./promptAssembly.js";

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

// TASK-177 (G-01b): fake skill reader per the spec's test note ("unit test
// on promptAssembly with a fake skill reader"). No DB here — skills.routes
// and packages/db cover real persistence separately.
function skill(overrides: Partial<Skill> = {}): Skill {
  return {
    skillId: "11111111-1111-1111-1111-111111111111",
    tenantId: "basileia",
    name: "weekly-export",
    description: "Exports the weekly report",
    whenToUse: "When the user asks for the weekly export.",
    body: "1. Gather the week's data.\n2. Export to CSV.",
    inputs: [],
    access: [],
    approvals: [],
    failurePolicy: {},
    version: 1,
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("extractSkillTokens", () => {
  it("extracts distinct /name tokens in first-seen order, de-duplicated", () => {
    expect(extractSkillTokens("Please run /weekly-export then /weekly-export again, and also /daily-brief"))
      .toEqual(["weekly-export", "daily-brief"]);
  });

  it("ignores a slash that is not preceded by whitespace or the start of the message", () => {
    expect(extractSkillTokens("See https://example.test/weekly-export for details")).toEqual([]);
  });

  it("returns an empty list when the message has no skill tokens", () => {
    expect(extractSkillTokens("Just a normal message.")).toEqual([]);
  });
});

describe("formatSkillBlock", () => {
  it("renders name, when_to_use, body, and approvals", () => {
    const block = formatSkillBlock(skill({ approvals: ["email.send"] }));
    expect(block).toContain("## Skill: weekly-export");
    expect(block).toContain("When to use: When the user asks for the weekly export.");
    expect(block).toContain("1. Gather the week's data.");
    expect(block).toContain("Approvals required: email.send");
  });

  it("omits the when-to-use line and approvals line when absent", () => {
    const block = formatSkillBlock(skill({ whenToUse: null, approvals: [] }));
    expect(block).not.toContain("When to use:");
    expect(block).not.toContain("Approvals required:");
  });
});

describe("assembleSystemPrompt", () => {
  it("injects exactly one ## Skill block, positioned after the persona block, for an enabled skill", async () => {
    const resolved: string[] = [];
    const prompt = await assembleSystemPrompt({
      role: role(),
      fallbackRoleId: "chat-bot",
      message: "Please run /weekly-export for me",
      resolveEnabledSkill: async (name) => {
        resolved.push(name);
        return name === "weekly-export" ? skill() : null;
      },
    });
    expect(resolved).toEqual(["weekly-export"]);
    const personaIndex = prompt.indexOf("You are Northstar, serving as Market Analyst.");
    const skillIndex = prompt.indexOf("## Skill: weekly-export");
    expect(personaIndex).toBeGreaterThanOrEqual(0);
    expect(skillIndex).toBeGreaterThan(personaIndex);
    expect(prompt.match(/## Skill: weekly-export/g)).toHaveLength(1);
  });

  it("never duplicates a skill referenced twice in the same message", async () => {
    const resolved: string[] = [];
    const prompt = await assembleSystemPrompt({
      role: role(),
      fallbackRoleId: "chat-bot",
      message: "/weekly-export then /weekly-export again",
      resolveEnabledSkill: async (name) => {
        resolved.push(name);
        return skill();
      },
    });
    expect(resolved).toEqual(["weekly-export"]);
    expect(prompt.match(/## Skill: weekly-export/g)).toHaveLength(1);
  });

  it("leaves a disabled or non-existent skill's token as plain text and appends a not-enabled note instead of a block", async () => {
    const prompt = await assembleSystemPrompt({
      role: role(),
      fallbackRoleId: "chat-bot",
      message: "Please run /not-a-real-skill for me",
      resolveEnabledSkill: async () => null,
    });
    expect(prompt).not.toContain("## Skill:");
    expect(prompt).toContain("skill 'not-a-real-skill' is not enabled for this bot");
  });

  it("resolves multiple distinct skills, each exactly once, in first-seen order", async () => {
    const prompt = await assembleSystemPrompt({
      role: role(),
      fallbackRoleId: "chat-bot",
      message: "/weekly-export and /daily-brief please",
      resolveEnabledSkill: async (name) => skill({ name, body: `body for ${name}` }),
    });
    const firstIndex = prompt.indexOf("## Skill: weekly-export");
    const secondIndex = prompt.indexOf("## Skill: daily-brief");
    expect(firstIndex).toBeGreaterThanOrEqual(0);
    expect(secondIndex).toBeGreaterThan(firstIndex);
  });
});
