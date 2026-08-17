import { describe, it, expect } from "vitest";
import { escapeMarkdownV2, toTelegramMarkdownV2, chunkMessage } from "./src/bot/formatting.js";

describe("escapeMarkdownV2", () => {
  it("escapes every MarkdownV2 special character", () => {
    const input = "_*[]()~`>#+-=|{}.!";
    const expected = "\\_\\*\\[\\]\\(\\)\\~\\`\\>\\#\\+\\-\\=\\|\\{\\}\\.\\!";
    expect(escapeMarkdownV2(input)).toBe(expected);
  });

  it("leaves plain alphanumeric text untouched", () => {
    expect(escapeMarkdownV2("Hello world 123")).toBe("Hello world 123");
  });

  it("handles an empty string", () => {
    expect(escapeMarkdownV2("")).toBe("");
  });
});

describe("toTelegramMarkdownV2", () => {
  it("converts **bold** to *bold* and escapes the inner text", () => {
    expect(toTelegramMarkdownV2("**hello.world**")).toBe("*hello\\.world*");
  });

  it("converts *italic* to _italic_", () => {
    expect(toTelegramMarkdownV2("*hi*")).toBe("_hi_");
  });

  it("preserves inline code spans verbatim (minus backtick/backslash escaping)", () => {
    expect(toTelegramMarkdownV2("run `npm test` now")).toBe("run `npm test` now");
  });

  it("escapes plain text around an inline code span but not the span itself", () => {
    expect(toTelegramMarkdownV2("run `npm test` now.")).toBe("run `npm test` now\\.");
  });

  it("escapes special characters inside a code span only for backtick/backslash", () => {
    const out = toTelegramMarkdownV2("`a\\b`");
    expect(out).toBe("`a\\\\b`");
  });

  it("renders fenced code blocks with escaped backticks/backslashes and preserved language tag", () => {
    const source = "```ts\nconst x = 1;\n```";
    const out = toTelegramMarkdownV2(source);
    expect(out).toBe("```ts\nconst x = 1;\n```");
  });

  it("escapes plain text surrounding a fenced code block", () => {
    const source = "before.\n```\ncode\n```\nafter!";
    const out = toTelegramMarkdownV2(source);
    expect(out).toContain("before\\.\n");
    expect(out).toContain("```\ncode\n```");
    expect(out).toContain("\nafter\\!");
  });

  it("does not choke on unmatched markdown-like characters", () => {
    expect(() => toTelegramMarkdownV2("a * b ** c")).not.toThrow();
  });
});

describe("chunkMessage", () => {
  it("returns the whole text as a single chunk when under the limit", () => {
    expect(chunkMessage("short text", 100)).toEqual(["short text"]);
  });

  it("returns an empty array for empty input", () => {
    expect(chunkMessage("", 100)).toEqual([]);
  });

  it("splits long text into chunks no larger than maxChars", () => {
    const text = "word ".repeat(2000);
    const chunks = chunkMessage(text, 1000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(1000);
    }
  });

  it("reassembles to the original text", () => {
    const text = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    const chunks = chunkMessage(text, 300);
    expect(chunks.join("")).toBe(text);
  });

  it("prefers splitting on paragraph boundaries when possible", () => {
    const para1 = "a".repeat(400);
    const para2 = "b".repeat(400);
    const text = `${para1}\n\n${para2}`;
    const chunks = chunkMessage(text, 450);
    expect(chunks[0]).toBe(`${para1}\n\n`);
    expect(chunks[1]).toBe(para2);
  });
});
