/**
 * TASK-179 (G-03a) — rolling context compaction.
 *
 * Grok Bot's staff-confirmed gap: one unbounded thread per Bot, no
 * compaction, no meter (report §10.6). This module estimates a thread's
 * assembled prompt size and, once it crosses `context_limit * 0.8`,
 * summarises everything older than the last `KEEP_VERBATIM_TURNS` messages
 * into a new `thread_summaries` row via the Tier-0 provider — rolling
 * forward from the prior summary (if any) so earlier compacted knowledge is
 * carried into the new row rather than dropped.
 *
 * Addendum F §3.3 — "memory is not the transcript": a summary is THREAD
 * state, not the bot's long-term memory store, and nothing here writes to
 * or imports that store (see the grep assertion in
 * contextCompaction.test.ts and this module's own import list, which stops
 * at `@oikonomos/agent-providers`/`@oikonomos/audit`).
 *
 * All persistence is via injected ports (`ContextCompactionPorts`) rather
 * than a direct `@oikonomos/db` import for the thread-context tables —
 * `packages/db/src/index.ts` (which would need to re-export the new
 * `threadContext.ts`) and `services/control-api/src/ports.ts` are outside
 * this task's `Owned_Paths`, the same shape of ownership gap TASK-180 hit
 * for its live call site. Real production wiring (exporting
 * `threadContext.ts` from `@oikonomos/db` and constructing these ports
 * against Postgres) is real, valuable follow-up work — see this task's
 * dossier.
 */
import { redactPayload } from "@oikonomos/audit";
import { withBudgetSink, type AgentProvider, type BudgetSink } from "@oikonomos/agent-providers";

/** The inexpensive, non-agentic provider currently available for Tier-0 work. */
export const TIER_ZERO_PROVIDER_ID = "gemini";

/** Verbatim turns always kept out of summarisation, regardless of size. */
export const KEEP_VERBATIM_TURNS = 40;

/** Compaction triggers once estimated tokens exceed this fraction of the limit. */
export const COMPACTION_THRESHOLD_RATIO = 0.8;

export interface ContextMessage {
  readonly id: string;
  readonly role: "user" | "bot" | "system";
  readonly body: string;
}

export interface ThreadContextState {
  readonly contextTokens: number;
  readonly contextLimit: number;
  readonly compactedThroughMessageId: string | null;
  readonly epoch: number;
}

export interface ThreadSummary {
  readonly summaryId: string;
  readonly threadId: string;
  readonly epoch: number;
  readonly coversThroughMessageId: string;
  readonly body: string;
  readonly createdAt: Date;
}

/**
 * Everything compaction needs from persistence, injected so this module is
 * unit-testable without a database (matches `groupRouting.ts`'s
 * `ShouldRespondScorer` / `promptAssembly.ts`'s `SkillResolver` pattern).
 */
export interface ContextCompactionPorts {
  loadState(threadId: string): Promise<ThreadContextState>;
  loadLatestSummary(threadId: string, epoch: number): Promise<ThreadSummary | null>;
  /**
   * Messages in `epoch`, ordered oldest-first, strictly after
   * `afterMessageId` (or from the start of the epoch when `null`).
   */
  loadMessagesSince(threadId: string, epoch: number, afterMessageId: string | null): Promise<ContextMessage[]>;
  saveSummary(input: {
    threadId: string;
    epoch: number;
    coversThroughMessageId: string;
    body: string;
  }): Promise<ThreadSummary>;
  updateState(
    threadId: string,
    patch: { contextTokens: number; compactedThroughMessageId: string },
  ): Promise<void>;
  /** Emits the `system` "Context compacted (N messages -> summary)" message. */
  insertSystemMessage(threadId: string, body: string): Promise<void>;
}

/** Summarises a transcript excerpt (optionally rolled forward from a prior summary) into prose. */
export type Summarizer = (transcript: string) => Promise<string>;

/**
 * Cheap, deterministic token estimate (~4 chars/token, English-prose
 * average) — "estimate", per the spec, not an exact tokenizer. Ceil'd so a
 * non-empty string never reports zero cost.
 */
export function estimateTokens(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  return Math.ceil(trimmed.length / 4);
}

/** Full assembled-prompt size: persona + skills text, latest summary, verbatim history. */
export function estimatePromptTokens(parts: {
  systemPrompt: string;
  summary: string | null;
  messages: readonly ContextMessage[];
}): number {
  const summaryTokens = parts.summary === null ? 0 : estimateTokens(parts.summary);
  const historyTokens = parts.messages.reduce((sum, message) => sum + estimateTokens(message.body), 0);
  return estimateTokens(parts.systemPrompt) + summaryTokens + historyTokens;
}

function renderTranscript(messages: readonly ContextMessage[]): string {
  return messages.map((message) => `[${message.role}] ${message.body}`).join("\n");
}

function verbatimTail(messages: readonly ContextMessage[], keepVerbatimTurns: number): ContextMessage[] {
  return messages.slice(Math.max(0, messages.length - keepVerbatimTurns));
}

/**
 * Redacts a generated summary through the single N4 redaction
 * implementation (packages/audit) before it is ever persisted. Wrapping in
 * `{ body }` reuses `redactPayload`'s existing whole-value string check
 * rather than a second, bespoke pattern set.
 */
export function redactSummaryBody(body: string): string {
  const redacted = redactPayload({ body });
  return (redacted?.body as string | undefined) ?? body;
}

export interface MaybeCompactOptions {
  readonly threadId: string;
  readonly systemPrompt: string;
  readonly ports: ContextCompactionPorts;
  readonly summarize: Summarizer;
  readonly keepVerbatimTurns?: number;
}

export interface MaybeCompactResult {
  readonly compacted: boolean;
  readonly promptTokens: number;
  readonly summary?: ThreadSummary;
}

/**
 * Runs after a chat turn completes. When the assembled prompt is estimated
 * above `context_limit * 0.8`, summarises every epoch message older than
 * the last `keepVerbatimTurns` (rolled forward from the prior summary, if
 * any) into one new `thread_summaries` row, redacts it, advances
 * `compacted_through_message_id`, and emits the "Context compacted" system
 * message. A no-op (measured, not assumed) below the threshold or when
 * there is nothing old enough to summarise yet.
 */
export async function maybeCompact(options: MaybeCompactOptions): Promise<MaybeCompactResult> {
  const keepVerbatimTurns = options.keepVerbatimTurns ?? KEEP_VERBATIM_TURNS;
  const state = await options.ports.loadState(options.threadId);
  const [latestSummary, sinceCompaction] = await Promise.all([
    options.ports.loadLatestSummary(options.threadId, state.epoch),
    options.ports.loadMessagesSince(options.threadId, state.epoch, state.compactedThroughMessageId),
  ]);

  // The pre-compaction estimate is over ALL messages since the last
  // compaction (what would actually be assembled into the prompt right
  // now) — only the post-compaction estimate below is limited to the kept
  // verbatim tail. Checking the tail alone here would make compaction
  // permanently unable to bring an over-threshold prompt back down,
  // since the tail's own size never shrinks.
  const promptTokens = estimatePromptTokens({
    systemPrompt: options.systemPrompt,
    summary: latestSummary?.body ?? null,
    messages: sinceCompaction,
  });

  if (promptTokens <= state.contextLimit * COMPACTION_THRESHOLD_RATIO) {
    return { compacted: false, promptTokens };
  }

  const toSummarize = sinceCompaction.slice(0, Math.max(0, sinceCompaction.length - keepVerbatimTurns));
  if (toSummarize.length === 0) {
    // The threshold is being crossed by verbatim growth alone — report the
    // measured size without manufacturing a summary of zero messages.
    return { compacted: false, promptTokens };
  }
  const verbatim = verbatimTail(sinceCompaction, keepVerbatimTurns);

  const transcript =
    latestSummary === null
      ? renderTranscript(toSummarize)
      : `Prior summary: ${latestSummary.body}\n\n${renderTranscript(toSummarize)}`;
  const rawSummary = await options.summarize(transcript);
  const redactedBody = redactSummaryBody(rawSummary);
  const coversThroughMessageId = toSummarize[toSummarize.length - 1]!.id;

  const summary = await options.ports.saveSummary({
    threadId: options.threadId,
    epoch: state.epoch,
    coversThroughMessageId,
    body: redactedBody,
  });

  const promptTokensAfter = estimatePromptTokens({
    systemPrompt: options.systemPrompt,
    summary: redactedBody,
    messages: verbatim,
  });

  await options.ports.updateState(options.threadId, {
    contextTokens: promptTokensAfter,
    compactedThroughMessageId: coversThroughMessageId,
  });
  await options.ports.insertSystemMessage(
    options.threadId,
    `Context compacted (${toSummarize.length} messages → summary)`,
  );

  return { compacted: true, promptTokens: promptTokensAfter, summary };
}

export interface CreateTierZeroSummarizerOptions {
  readonly provider: AgentProvider;
  readonly budgetSink: BudgetSink;
  readonly cwd: string;
}

/**
 * Builds the default summarizer through agent-providers' budgeted wrapper,
 * routed to the Tier-0 provider (CLAUDE.md budget rule: cheap model for
 * Tier-0 observation work). Fails closed on an incomplete stream so a
 * partial turn can never evade budget accounting (mirrors
 * `groupRouting.ts`'s `createTierZeroScorer`).
 */
export function createTierZeroSummarizer(options: CreateTierZeroSummarizerOptions): Summarizer {
  if (options.provider.id !== TIER_ZERO_PROVIDER_ID) {
    throw new Error(`context compaction summarizer requires ${TIER_ZERO_PROVIDER_ID}, received ${options.provider.id}.`);
  }
  const provider = withBudgetSink(options.provider, options.budgetSink);

  return async (transcript: string): Promise<string> => {
    const text: string[] = [];
    let completed = false;
    for await (const event of provider.sendPrompt({
      prompt: summarizerPrompt(transcript),
      cwd: options.cwd,
      sessionId: null,
      model: null,
      signal: new AbortController().signal,
    })) {
      if (event.type === "text_delta") text.push(event.text);
      if (event.type === "error" && event.fatal) throw new Error(`Tier-0 summarizer failed: ${event.message}`);
      if (event.type === "turn_complete") completed = true;
    }
    if (!completed) throw new Error("Tier-0 summarizer ended before a budgeted turn completed.");
    return text.join("").trim();
  };
}

function summarizerPrompt(transcript: string): string {
  return [
    "Summarise the following conversation excerpt into a short, factual prose",
    "paragraph a bot can use as its own memory of what was discussed. Do not",
    "invent facts not present in the excerpt.",
    "",
    transcript,
  ].join("\n");
}
