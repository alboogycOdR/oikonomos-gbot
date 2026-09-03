import { describe, expect, it } from "vitest";

import { destinationFor, finalText } from "./chatRunDriver.js";

const chatRunDriverSource = await import("node:fs/promises").then((fs) =>
  fs.readFile(new URL("./chatRunDriver.ts", import.meta.url), "utf8"),
);

const base = {
  toolUseId: "tool-use", runId: "11111111-1111-1111-1111-111111111111", roleId: "chat-bot", tenantId: "basileia",
  agentRef: { provider: "claude", sessionRef: "session", isSubagent: false },
};

describe("chat run driver governance helpers", () => {
  it("uses the scoped built-in mount while leaving Agent SDK query ownership to harness-factory", () => {
    expect(chatRunDriverSource).toContain('allowedTools: ["Bash(*)"]');
    expect(chatRunDriverSource).not.toMatch(/queryFn\s*:/);
    expect(chatRunDriverSource).not.toContain("@anthropic-ai/claude-agent-sdk");
  });

  it("derives only ADR-013's approved destinations and fails closed otherwise", () => {
    expect(destinationFor({ ...base, toolName: "Read", input: { file_path: "src/app.ts" } })).toBe("src/app.ts");
    expect(destinationFor({ ...base, toolName: "Glob", input: { pattern: "src/**/*.ts" } })).toBe("src/**/*.ts");
    expect(destinationFor({ ...base, toolName: "Bash", input: { command: "git status" } })).toBe("git status");
    expect(destinationFor({ ...base, toolName: "mcp__gmail__send_message", input: { to: "user@example.test" } })).toBe("user@example.test");
    expect(() => destinationFor({ ...base, toolName: "WebFetch", input: { url: "https://example.test" } })).toThrow(/No governed destination/);
  });

  it("uses the final SDK result while keeping a non-empty fallback reply", () => {
    expect(finalText([{ result: "first" }, { type: "progress" }, { result: " final reply " }])).toBe("final reply");
    expect(finalText([{ type: "progress" }])).toMatch(/completed/);
  });
});
