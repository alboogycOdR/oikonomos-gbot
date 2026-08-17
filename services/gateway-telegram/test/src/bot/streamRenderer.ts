/**
 * Staged from cc-multi-agent-bot `src/bot/streamRenderer.ts`.
 */

import { chunkMessage } from "./formatting.js";

export interface ToolLogEntry {
  toolUseId: string;
  toolName: string;
  summary: string;
  status: "running" | "ok" | "error";
}

export interface RenderedFrame {
  messageIndex: number;
  text: string;
  isNew: boolean;
}

export class MessageAccumulator {
  private readonly maxChars: number;
  private readonly toolLog: ToolLogEntry[] = [];
  private assistantText = "";
  private messageIndex = 0;
  private committedChars = 0;

  constructor(maxChars: number) {
    if (maxChars <= 200) {
      throw new Error("maxChars must be large enough to hold at least a status line and some text.");
    }
    this.maxChars = maxChars;
  }

  toolStart(entry: Omit<ToolLogEntry, "status">): void {
    this.toolLog.push({ ...entry, status: "running" });
  }

  toolEnd(toolUseId: string, ok: boolean): void {
    const entry = this.toolLog.find((t) => t.toolUseId === toolUseId);
    if (entry) {
      entry.status = ok ? "ok" : "error";
    }
  }

  appendText(text: string): void {
    this.assistantText += text;
  }

  render(): RenderedFrame {
    const full = this.buildFullText();

    if (full.length <= this.maxChars) {
      return { messageIndex: this.messageIndex, text: full, isNew: false };
    }

    const chunks = chunkMessage(full, this.maxChars);
    const tail = chunks[chunks.length - 1] ?? "";
    const isNewMessage = this.committedChars === 0 || full.length - tail.length > this.committedChars;

    if (isNewMessage) {
      this.messageIndex += 1;
      this.committedChars = full.length - tail.length;
      return { messageIndex: this.messageIndex, text: tail, isNew: true };
    }

    return { messageIndex: this.messageIndex, text: tail, isNew: false };
  }

  private buildFullText(): string {
    const statusBlock = this.renderStatusBlock();
    if (statusBlock.length === 0) return this.assistantText;
    if (this.assistantText.length === 0) return statusBlock;
    return `${statusBlock}\n\n${this.assistantText}`;
  }

  private renderStatusBlock(): string {
    if (this.toolLog.length === 0) return "";
    return this.toolLog.map((t) => `${statusEmoji(t.status)} ${t.toolName}: ${t.summary}`).join("\n");
  }
}

function statusEmoji(status: ToolLogEntry["status"]): string {
  switch (status) {
    case "running":
      return "⏳";
    case "ok":
      return "✅";
    case "error":
      return "❌";
  }
}
