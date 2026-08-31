import type { AgentProvider, ProviderEvent } from "./types.js";
import { BudgetSinkError, withBudgetSink } from "./budget.js";

if (import.meta.vitest) {
  const { describe, expect, it, vi } = import.meta.vitest;

  function fakeProvider(events: ProviderEvent[]): AgentProvider {
    return {
      id: "claude-code",
      displayName: "Fake",
      capabilities: {
        agentic: true,
        resumableSessions: true,
        permissionPrompts: true,
        interruptible: true,
      },
      defaultModel: "fake-model",
      availableModels: ["fake-model"],
      async *sendPrompt() {
        for (const event of events) {
          yield event;
        }
      },
      async interrupt() {},
    };
  }

  async function drain(
    gen: AsyncGenerator<ProviderEvent, void, unknown>,
  ): Promise<ProviderEvent[]> {
    const out: ProviderEvent[] = [];
    for await (const event of gen) {
      out.push(event);
    }
    return out;
  }

  const baseOptions = {
    prompt: "hi",
    cwd: "/tmp",
    sessionId: null,
    model: null,
    signal: new AbortController().signal,
  };

  describe("withBudgetSink", () => {
    it("invokes the sink exactly once per completed turn with cost+model", async () => {
      const provider = fakeProvider([
        { type: "text_delta", text: "hi" },
        {
          type: "turn_complete",
          sessionId: "s1",
          costUsd: 0.42,
          durationMs: 10,
          turns: 1,
        },
      ]);
      const report = vi.fn().mockResolvedValue(undefined);
      const wrapped = withBudgetSink(provider, { report });

      const events = await drain(wrapped.sendPrompt({ ...baseOptions, model: "m1" }));

      expect(report).toHaveBeenCalledTimes(1);
      expect(report).toHaveBeenCalledWith({
        provider: "claude-code",
        model: "m1",
        costUsd: 0.42,
        tokens: null,
      });
      expect(events.at(-1)?.type).toBe("turn_complete");
    });

    it("falls back to the provider default model when none is requested", async () => {
      const provider = fakeProvider([
        { type: "turn_complete", sessionId: null, costUsd: 0.1, durationMs: 1, turns: 1 },
      ]);
      const report = vi.fn().mockResolvedValue(undefined);
      const wrapped = withBudgetSink(provider, { report });

      await drain(wrapped.sendPrompt(baseOptions));

      expect(report).toHaveBeenCalledWith(
        expect.objectContaining({ model: "fake-model" }),
      );
    });

    it("fails the turn when the sink throws, never yielding turn_complete", async () => {
      const provider = fakeProvider([
        { type: "turn_complete", sessionId: "s1", costUsd: 1, durationMs: 1, turns: 1 },
      ]);
      const sinkError = new Error("budget exceeded");
      const wrapped = withBudgetSink(provider, {
        report: () => {
          throw sinkError;
        },
      });

      await expect(drain(wrapped.sendPrompt(baseOptions))).rejects.toThrow(BudgetSinkError);
    });

    it("fails the turn when the sink's returned promise rejects", async () => {
      const provider = fakeProvider([
        { type: "turn_complete", sessionId: "s1", costUsd: 1, durationMs: 1, turns: 1 },
      ]);
      const wrapped = withBudgetSink(provider, {
        report: () => Promise.reject(new Error("nope")),
      });

      await expect(drain(wrapped.sendPrompt(baseOptions))).rejects.toThrow(BudgetSinkError);
    });

    it("passes through non-turn_complete events untouched, without invoking the sink", async () => {
      const provider = fakeProvider([
        { type: "text_delta", text: "hello" },
        { type: "error", message: "boom", fatal: true },
      ]);
      const report = vi.fn().mockResolvedValue(undefined);
      const wrapped = withBudgetSink(provider, { report });

      const events = await drain(wrapped.sendPrompt(baseOptions));

      expect(report).not.toHaveBeenCalled();
      expect(events).toEqual([
        { type: "text_delta", text: "hello" },
        { type: "error", message: "boom", fatal: true },
      ]);
    });

    it("interrupt() delegates to the wrapped provider", async () => {
      const provider = fakeProvider([]);
      const interruptSpy = vi.spyOn(provider, "interrupt");
      const wrapped = withBudgetSink(provider, { report: vi.fn() });

      await wrapped.interrupt();

      expect(interruptSpy).toHaveBeenCalledTimes(1);
    });

    it("treats a missing costUsd as 0 rather than null/undefined", async () => {
      const provider = fakeProvider([
        { type: "turn_complete", sessionId: "s1", costUsd: null, durationMs: 1, turns: 1 },
      ]);
      const report = vi.fn().mockResolvedValue(undefined);
      const wrapped = withBudgetSink(provider, { report });

      await drain(wrapped.sendPrompt(baseOptions));

      expect(report).toHaveBeenCalledWith(expect.objectContaining({ costUsd: 0 }));
    });
  });
}
