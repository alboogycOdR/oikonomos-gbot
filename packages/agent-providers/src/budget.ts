/**
 * Budget hook (TASK-072).
 *
 * A `BudgetSink` is the single interception point the week-5 per-routine
 * budget broker (CLAUDE.md "Budget") will attach to: every completed turn,
 * for every provider, reports `{provider, model, costUsd, tokens}` to the
 * sink BEFORE the `turn_complete` event is surfaced to the caller.
 *
 * Fail closed: if the sink throws (or its returned promise rejects), the
 * turn does not succeed silently — the wrapped `sendPrompt` generator
 * throws instead of yielding `turn_complete`, so an unaccounted-for turn
 * always fails the caller's await/for-await, never completes quietly.
 *
 * Implemented as a decorator over an existing `AgentProvider` rather than a
 * change to the three provider implementations, per TASK-072's Owned_Paths
 * (this package's `providers/*.ts` are out of territory) and per the task
 * description's "do not modify the three existing provider implementations
 * beyond wiring" — wiring here means composing `withBudgetSink(provider, sink)`
 * at the call site, not touching provider internals.
 */
import type {
  AgentProvider,
  ProviderEvent,
  ProviderId,
  SendPromptOptions,
} from "./types.js";

/** Usage/cost report for exactly one completed turn. */
export interface BudgetReport {
  provider: ProviderId;
  model: string;
  costUsd: number;
  /**
   * Token count for the turn, when the provider surfaces one.
   * `TurnCompleteEvent` does not currently carry a token count (only
   * `costUsd`, `durationMs`, `turns`), so this is `null` until a provider
   * starts reporting it — the shape is stable now so the broker can start
   * consuming it immediately.
   */
  tokens: number | null;
}

/** Injected by the caller (the week-5 budget broker). */
export interface BudgetSink {
  report(entry: BudgetReport): Promise<void> | void;
}

/** Raised when a `BudgetSink` rejects a turn; wraps the sink's own error. */
export class BudgetSinkError extends Error {
  readonly report: BudgetReport;
  readonly cause: unknown;

  constructor(report: BudgetReport, cause: unknown) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(
      `Budget sink rejected turn for ${report.provider}/${report.model}: ${causeMessage}`,
    );
    this.name = "BudgetSinkError";
    this.report = report;
    this.cause = cause;
  }
}

/**
 * Wraps `provider` so every completed turn is reported to `sink` before the
 * `turn_complete` event reaches the caller. A throwing sink fails the turn:
 * the generator throws `BudgetSinkError` instead of yielding `turn_complete`.
 *
 * Built as a plain object (not `{...provider}`) because `AgentProvider`
 * implementations are classes whose methods live on the prototype, not as
 * own-enumerable properties — a shallow spread would silently drop them.
 */
export function withBudgetSink(provider: AgentProvider, sink: BudgetSink): AgentProvider {
  return {
    id: provider.id,
    displayName: provider.displayName,
    capabilities: provider.capabilities,
    defaultModel: provider.defaultModel,
    availableModels: provider.availableModels,
    async *sendPrompt(
      options: SendPromptOptions,
    ): AsyncGenerator<ProviderEvent, void, unknown> {
      const model = options.model ?? provider.defaultModel;
      for await (const event of provider.sendPrompt(options)) {
        if (event.type === "turn_complete") {
          const report: BudgetReport = {
            provider: provider.id,
            model,
            costUsd: event.costUsd ?? 0,
            tokens: null,
          };
          try {
            await sink.report(report);
          } catch (cause) {
            throw new BudgetSinkError(report, cause);
          }
          yield event;
          continue;
        }
        yield event;
      }
    },
    interrupt(): Promise<void> {
      return provider.interrupt();
    },
  };
}
