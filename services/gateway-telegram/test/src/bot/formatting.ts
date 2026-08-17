/**
 * Staged from cc-multi-agent-bot `src/bot/formatting.ts` so the 16
 * formatting tests stay green. Gateway implementation ticket owns moving
 * this into `services/gateway-telegram/src/`.
 */

const MARKDOWN_V2_SPECIAL_CHARS = [
  "_",
  "*",
  "[",
  "]",
  "(",
  ")",
  "~",
  "`",
  ">",
  "#",
  "+",
  "-",
  "=",
  "|",
  "{",
  "}",
  ".",
  "!",
];

/** Escape all MarkdownV2 special characters in plain (non-code) text. */
export function escapeMarkdownV2(text: string): string {
  let out = "";
  for (const ch of text) {
    if (MARKDOWN_V2_SPECIAL_CHARS.includes(ch)) {
      out += "\\" + ch;
    } else {
      out += ch;
    }
  }
  return out;
}

/** Escape text destined for inside a ``` fenced code block (backtick + backslash only). */
export function escapeCodeBlock(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/`/g, "\\`");
}

/**
 * Converts a subset of GitHub-flavored Markdown (as commonly emitted by
 * Claude/Codex responses) into Telegram MarkdownV2. Supports: fenced code
 * blocks, inline code, bold (**), italic (*), and leaves everything else as
 * escaped plain text.
 */
export function toTelegramMarkdownV2(source: string): string {
  const segments = splitFencedCodeBlocks(source);
  const rendered = segments.map((segment) => {
    if (segment.type === "code_block") {
      const lang = segment.lang ? escapeMarkdownV2(segment.lang) : "";
      return "```" + lang + "\n" + escapeCodeBlock(segment.text) + "\n```";
    }
    return renderInline(segment.text);
  });
  return rendered.join("");
}

interface TextSegment {
  type: "text";
  text: string;
}
interface CodeBlockSegment {
  type: "code_block";
  text: string;
  lang: string | null;
}

function splitFencedCodeBlocks(source: string): Array<TextSegment | CodeBlockSegment> {
  const fenceRe = /```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g;
  const out: Array<TextSegment | CodeBlockSegment> = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = fenceRe.exec(source)) !== null) {
    if (match.index > lastIndex) {
      out.push({ type: "text", text: source.slice(lastIndex, match.index) });
    }
    const lang = match[1] ?? "";
    const body = match[2] ?? "";
    out.push({
      type: "code_block",
      lang: lang.length > 0 ? lang : null,
      text: body.replace(/\n$/, ""),
    });
    lastIndex = fenceRe.lastIndex;
  }

  if (lastIndex < source.length) {
    out.push({ type: "text", text: source.slice(lastIndex) });
  }

  return out;
}

function renderInline(text: string): string {
  const parts = text.split(/(`[^`\n]+`)/g);
  return parts
    .map((part) => {
      if (part.startsWith("`") && part.endsWith("`") && part.length >= 2) {
        const inner = part.slice(1, -1);
        return "`" + escapeCodeBlock(inner) + "`";
      }
      return renderBoldItalic(part);
    })
    .join("");
}

function renderBoldItalic(text: string): string {
  const tokens = text.split(/(\*\*[^*]+\*\*)/g);
  return tokens
    .map((token) => {
      const boldMatch = /^\*\*([^*]+)\*\*$/.exec(token);
      if (boldMatch) {
        return "*" + escapeMarkdownV2(boldMatch[1] ?? "") + "*";
      }
      const italicTokens = token.split(/(\*[^*]+\*)/g);
      return italicTokens
        .map((t) => {
          const italicMatch = /^\*([^*]+)\*$/.exec(t);
          if (italicMatch) {
            return "_" + escapeMarkdownV2(italicMatch[1] ?? "") + "_";
          }
          return escapeMarkdownV2(t);
        })
        .join("");
    })
    .join("");
}

/**
 * Splits long text into Telegram-safe chunks, preferring to break on
 * paragraph or line boundaries so code blocks are not split mid-fence
 * whenever avoidable.
 */
export function chunkMessage(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) {
    return text.length > 0 ? [text] : [];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxChars) {
    let splitAt = findBestSplitPoint(remaining, maxChars);
    if (splitAt <= 0) {
      splitAt = maxChars;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

function findBestSplitPoint(text: string, maxChars: number): number {
  const window = text.slice(0, maxChars);

  const doubleNewline = window.lastIndexOf("\n\n");
  if (doubleNewline > maxChars * 0.4) {
    return doubleNewline + 2;
  }

  const singleNewline = window.lastIndexOf("\n");
  if (singleNewline > maxChars * 0.4) {
    return singleNewline + 1;
  }

  const space = window.lastIndexOf(" ");
  if (space > maxChars * 0.4) {
    return space + 1;
  }

  return maxChars;
}
