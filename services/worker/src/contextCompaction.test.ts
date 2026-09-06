import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentProvider, ProviderEvent } from "@oikonomos/agent-providers";
import { describe, expect, it, vi } from "vitest";

import {
  COMPACTION_THRESHOLD_RATIO,
  createTierZeroSummarizer,
  estimatePromptTokens,
  estimateTokens,
  maybeCompact,
  redactSummaryBody,
  type ContextCompactionPorts,
  type ContextMessage,
  type ThreadContextState,
  type ThreadSummary,
} from "./contextCompaction.js";

// TASK-179 AC: "packages/memory is not imported by contextCompaction.ts
// (grep assertion in test)". Reads this module's own source rather than
// trusting a listed import — a transitive re-export under a different name
// would not fool a source grep.
describe("contextCompaction.ts never imports packages/memory", () => {
  it("has no import of @oikonomos/memory or a relative packages/memory path", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(path.join(here, "contextCompaction.ts"), "utf8");
    expect(source).not.toMatch(/@oikonomos\/memory/);
    expect(source).not.toMatch(/packages\/memory/);
  });
});

describe("estimateTokens / estimatePromptTokens", () => {
  it("estimates roughly one token per four characters, ceiling non-empty strings above zero", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("   ")).toBe(0);
    expect(estimateTokens("ab")).toBe(1);
    expect(estimateTokens("a".repeat(8))).toBe(2);
  });

  it("sums system prompt, summary, and history token estimates", () => {
    const messages: ContextMessage[] = [
      { id: "m1", role: "user", body: "a".repeat(8) },
      { id: "m2", role: "bot", body: "a".repeat(4) },
    ];
    const total = estimatePromptTokens({ systemPrompt: "a".repeat(4), summary: "a".repeat(4), messages });
    expect(total).toBe(1 + 1 + 2 + 1);
  });
});

function fakeMessages(count: number, prefix = "msg"): ContextMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${String(index).padStart(4, "0")}`,
    role: index % 2 === 0 ? "user" : "bot",
    // Long bodies so a realistic number of turns crosses the token threshold.
    body: `Turn ${index}: ${"lorem ipsum dolor sit amet ".repeat(10)}`,
  }));
}

function fakePorts(initial: {
  state: ThreadContextState;
  messages: ContextMessage[];
  summaries?: ThreadSummary[];
}): ContextCompactionPorts & {
  savedSummaries: Array<{ threadId: string; epoch: number; coversThroughMessageId: string; body: string }>;
  updatedState: ThreadContextState[];
  systemMessages: string[];
} {
  let state = initial.state;
  const messages = initial.messages;
  const summaries = initial.summaries ?? [];
  const savedSummaries: Array<{ threadId: string; epoch: number; coversThroughMessageId: string; body: string }> = [];
  const updatedState: ThreadContextState[] = [];
  const systemMessages: string[] = [];

  return {
    savedSummaries,
    updatedState,
    systemMessages,
    async loadState() {
      return state;
    },
    async loadLatestSummary(_threadId, epoch) {
      const forEpoch = summaries.filter((summary) => summary.epoch === epoch);
      return forEpoch.length === 0 ? null : forEpoch[forEpoch.length - 1]!;
    },
    async loadMessagesSince(_threadId, _epoch, afterMessageId) {
      if (afterMessageId === null) return messages;
      const index = messages.findIndex((message) => message.id === afterMessageId);
      return index === -1 ? messages : messages.slice(index + 1);
    },
    async saveSummary(input) {
      savedSummaries.push(input);
      const summary: ThreadSummary = {
        summaryId: `summary-${String(savedSummaries.length)}`,
        threadId: input.threadId,
        epoch: input.epoch,
        coversThroughMessageId: input.coversThroughMessageId,
        body: input.body,
        createdAt: new Date("2026-09-06T00:00:00.000Z"),
      };
      summaries.push(summary);
      return summary;
    },
    async updateState(threadId, patch) {
      state = {
        contextTokens: patch.contextTokens,
        contextLimit: state.contextLimit,
        compactedThroughMessageId: patch.compactedThroughMessageId,
        epoch: state.epoch,
      };
      updatedState.push(state);
      void threadId;
    },
    async insertSystemMessage(_threadId, body) {
      systemMessages.push(body);
    },
  };
}

describe("maybeCompact", () => {
  it("is a no-op below the threshold and reports the measured (not assumed) size", async () => {
    const ports = fakePorts({
      state: { contextTokens: 0, contextLimit: 8000, compactedThroughMessageId: null, epoch: 0 },
      messages: fakeMessages(5),
    });
    const result = await maybeCompact({
      threadId: "thread-1",
      systemPrompt: "You are a bot.",
      ports,
      summarize: vi.fn(),
    });
    expect(result.compacted).toBe(false);
    expect(result.promptTokens).toBeGreaterThan(0);
    expect(result.promptTokens).toBeLessThan(8000 * COMPACTION_THRESHOLD_RATIO);
    expect(ports.savedSummaries).toHaveLength(0);
  });

  // AC: "Driving a thread past the threshold with a fake provider produces
  // a thread_summaries row and the next assembled prompt's estimated
  // tokens are below the threshold — asserted on the measured number, not
  // inferred." Exercises the full pipeline: over-threshold detection ->
  // summarizer call -> redaction -> persistence -> re-estimate.
  it("compacts once the assembled prompt is estimated over the threshold, and the new estimate drops back under it", async () => {
    // Large enough that the kept 40-message verbatim tail alone (~2900
    // estimated tokens for this fixture's message sizes) fits comfortably
    // under 0.8 * limit, but small enough that the full 80-message history
    // (~5800 tokens) crosses it before compaction runs.
    const smallLimit = 6000;
    const ports = fakePorts({
      state: { contextTokens: 0, contextLimit: smallLimit, compactedThroughMessageId: null, epoch: 0 },
      messages: fakeMessages(80),
    });
    const summarize = vi.fn(async () => "A concise summary of the earlier turns.");

    const before = await maybeCompact({
      threadId: "thread-1",
      systemPrompt: "You are a bot.",
      ports,
      summarize,
    });
    expect(before.compacted).toBe(true);
    expect(before.summary).toBeDefined();
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(ports.savedSummaries).toHaveLength(1);
    expect(ports.systemMessages).toHaveLength(1);
    expect(ports.systemMessages[0]).toMatch(/^Context compacted \(\d+ messages → summary\)$/);

    // The measured post-compaction estimate is actually below the threshold.
    expect(before.promptTokens).toBeLessThanOrEqual(smallLimit * COMPACTION_THRESHOLD_RATIO);

    // Re-running against the now-compacted state (verbatim tail only) stays a no-op.
    const after = await maybeCompact({
      threadId: "thread-1",
      systemPrompt: "You are a bot.",
      ports,
      summarize,
    });
    expect(after.compacted).toBe(false);
    expect(after.promptTokens).toBeLessThanOrEqual(smallLimit * COMPACTION_THRESHOLD_RATIO);
  });

  it("does not re-summarize messages already covered by compacted_through_message_id", async () => {
    const messages = fakeMessages(50);
    // Leave 45 messages after the cutoff so 5 are old enough to summarize
    // (45 - keepVerbatimTurns=40) without the "nothing new to fold in" path.
    const ports = fakePorts({
      state: { contextTokens: 0, contextLimit: 300, compactedThroughMessageId: messages[4]!.id, epoch: 0 },
      messages,
    });
    const summarize = vi.fn(async (transcript: string) => {
      expect(transcript).not.toContain(messages[0]!.body);
      return "rolled-forward summary";
    });

    await maybeCompact({ threadId: "thread-1", systemPrompt: "persona", ports, summarize });
    expect(summarize).toHaveBeenCalledTimes(1);
  });

  it("rolls the prior summary forward into the new one instead of dropping it", async () => {
    const priorSummary: ThreadSummary = {
      summaryId: "summary-0",
      threadId: "thread-1",
      epoch: 0,
      coversThroughMessageId: "msg-0009",
      body: "Earlier: the user asked about pricing.",
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
    };
    const messages = fakeMessages(60);
    const ports = fakePorts({
      state: { contextTokens: 0, contextLimit: 300, compactedThroughMessageId: "msg-0009", epoch: 0 },
      messages,
      summaries: [priorSummary],
    });
    const summarize = vi.fn(async (transcript: string) => {
      expect(transcript).toContain("Earlier: the user asked about pricing.");
      return "rolled-forward summary";
    });

    await maybeCompact({ threadId: "thread-1", systemPrompt: "persona", ports, summarize });
    expect(summarize).toHaveBeenCalledTimes(1);
  });

  // AC: "A summary generated from a transcript containing a fragment-
  // assembled fake credential contains no such fragment after redaction."
  it("redacts a secret-shaped summary through packages/audit before persisting", async () => {
    const fakeApiKey = ["sk", "PLACEHOLDER_FAKE_NOT_A_REAL_SECRET_KEY"].join("-");
    const ports = fakePorts({
      state: { contextTokens: 0, contextLimit: 300, compactedThroughMessageId: null, epoch: 0 },
      messages: fakeMessages(60),
    });
    const summarize = vi.fn(async () => `Notes: API key is ${fakeApiKey}.`);

    const result = await maybeCompact({ threadId: "thread-1", systemPrompt: "persona", ports, summarize });

    expect(result.compacted).toBe(true);
    expect(result.summary!.body).not.toContain(fakeApiKey);
    expect(ports.savedSummaries[0]!.body).not.toContain(fakeApiKey);
  });
});

describe("redactSummaryBody", () => {
  it("passes ordinary prose through unchanged", () => {
    expect(redactSummaryBody("Just a normal summary.")).toBe("Just a normal summary.");
  });

  it("redacts a summary containing a secret-shaped fragment", () => {
    const fakeAwsAccessKeyId = ["AKIA", "EXAMPLEFAKEKEY01"].join("");
    const redacted = redactSummaryBody(`Access key on file: ${fakeAwsAccessKeyId}`);
    expect(redacted).not.toContain(fakeAwsAccessKeyId);
  });
});

describe("createTierZeroSummarizer", () => {
  it("reports spend to the budget sink under the Tier-0 provider and returns the joined text", async () => {
    const events: readonly ProviderEvent[] = [
      { type: "text_delta", text: "A concise summary" },
      { type: "text_delta", text: " of the excerpt." },
      { type: "turn_complete", sessionId: null, costUsd: 0.0005, durationMs: 1, turns: 1 },
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
    const summarize = createTierZeroSummarizer({ provider, budgetSink: { report }, cwd: "/tmp" });

    await expect(summarize("old messages")).resolves.toBe("A concise summary of the excerpt.");
    expect(report).toHaveBeenCalledWith({ provider: "gemini", model: "tier-0-fixture", costUsd: 0.0005, tokens: null });
  });

  it("rejects a non-Tier-0 provider before ever calling it", () => {
    const provider: AgentProvider = {
      id: "claude-code",
      displayName: "Wrong provider",
      defaultModel: "x",
      availableModels: ["x"],
      capabilities: { agentic: true, resumableSessions: true, permissionPrompts: true, interruptible: true },
      async *sendPrompt() {},
      async interrupt() {},
    };
    expect(() => createTierZeroSummarizer({ provider, budgetSink: { report: vi.fn() }, cwd: "/tmp" })).toThrow(/gemini/);
  });

  it("fails closed when the provider stream ends without a completed turn", async () => {
    const provider: AgentProvider = {
      id: "gemini",
      displayName: "Incomplete fixture",
      defaultModel: "x",
      availableModels: ["x"],
      capabilities: { agentic: false, resumableSessions: false, permissionPrompts: false, interruptible: true },
      async *sendPrompt() { yield { type: "text_delta", text: "partial" }; },
      async interrupt() {},
    };
    const summarize = createTierZeroSummarizer({ provider, budgetSink: { report: vi.fn() }, cwd: "/tmp" });
    await expect(summarize("x")).rejects.toThrow(/ended before a budgeted turn completed/);
  });
});
