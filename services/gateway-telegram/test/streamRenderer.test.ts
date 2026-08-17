import { describe, it, expect } from "vitest";
import { MessageAccumulator } from "./src/bot/streamRenderer.js";

describe("MessageAccumulator", () => {
  it("throws if constructed with too small a maxChars", () => {
    expect(() => new MessageAccumulator(100)).toThrow();
  });

  it("renders plain assistant text with no tool activity", () => {
    const acc = new MessageAccumulator(1000);
    acc.appendText("Hello ");
    acc.appendText("world");
    const frame = acc.render();
    expect(frame.text).toBe("Hello world");
    expect(frame.messageIndex).toBe(0);
    expect(frame.isNew).toBe(false);
  });

  it("renders a status block above assistant text once a tool starts", () => {
    const acc = new MessageAccumulator(1000);
    acc.toolStart({ toolUseId: "t1", toolName: "bash", summary: "npm test" });
    acc.appendText("Running tests now.");
    const frame = acc.render();
    expect(frame.text).toBe("⏳ bash: npm test\n\nRunning tests now.");
  });

  it("updates the status emoji from running to ok when a tool ends successfully", () => {
    const acc = new MessageAccumulator(1000);
    acc.toolStart({ toolUseId: "t1", toolName: "bash", summary: "npm test" });
    acc.toolEnd("t1", true);
    const frame = acc.render();
    expect(frame.text).toContain("✅ bash: npm test");
  });

  it("updates the status emoji to error when a tool fails", () => {
    const acc = new MessageAccumulator(1000);
    acc.toolStart({ toolUseId: "t1", toolName: "bash", summary: "npm test" });
    acc.toolEnd("t1", false);
    const frame = acc.render();
    expect(frame.text).toContain("❌ bash: npm test");
  });

  it("tracks multiple concurrent tool calls independently", () => {
    const acc = new MessageAccumulator(1000);
    acc.toolStart({ toolUseId: "a", toolName: "bash", summary: "ls" });
    acc.toolStart({ toolUseId: "b", toolName: "read", summary: "file.ts" });
    acc.toolEnd("a", true);
    const frame = acc.render();
    expect(frame.text).toContain("✅ bash: ls");
    expect(frame.text).toContain("⏳ read: file.ts");
  });

  it("ignores toolEnd for an unknown toolUseId without throwing", () => {
    const acc = new MessageAccumulator(1000);
    expect(() => acc.toolEnd("does-not-exist", true)).not.toThrow();
  });

  it("stays on message index 0 while content fits within maxChars", () => {
    const acc = new MessageAccumulator(500);
    acc.appendText("x".repeat(400));
    const frame = acc.render();
    expect(frame.messageIndex).toBe(0);
    expect(frame.isNew).toBe(false);
  });

  it("advances to a new message once content exceeds maxChars, and reports isNew once", () => {
    const acc = new MessageAccumulator(300);
    acc.appendText("x".repeat(250));
    const first = acc.render();
    expect(first.messageIndex).toBe(0);

    acc.appendText("y".repeat(200));
    const second = acc.render();
    expect(second.messageIndex).toBe(1);
    expect(second.isNew).toBe(true);

    const third = acc.render();
    expect(third.messageIndex).toBe(1);
    expect(third.isNew).toBe(false);
  });

  it("keeps advancing message index across repeated overflow", () => {
    const acc = new MessageAccumulator(300);
    let lastIndex = 0;
    for (let i = 0; i < 10; i++) {
      acc.appendText("z".repeat(100));
      const frame = acc.render();
      expect(frame.messageIndex).toBeGreaterThanOrEqual(lastIndex);
      lastIndex = frame.messageIndex;
    }
    expect(lastIndex).toBeGreaterThan(0);
  });
});
