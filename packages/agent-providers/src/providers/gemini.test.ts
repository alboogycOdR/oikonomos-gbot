import { GeminiProvider, type GeminiQueryFn, type GeminiQueryResult } from "./gemini.js";
import { isProviderId, PROVIDER_IDS } from "../types.js";
import type { ProviderEvent } from "../types.js";
import { loadConfig } from "../config.js";

/**
 * In-source test file under src/ — this package's vitest.config.ts scopes
 * `include` to `test/**` and relies on `includeSource: ["src/**\/*.ts"]` for
 * colocated src suites (see src/budget.test.ts, src/pricing.test.ts). Those
 * only run guarded by `import.meta.vitest`; an unguarded top-level
 * describe/it here is silently never collected.
 */
if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  const baseEnv = {
    TELEGRAM_BOT_TOKEN: "123456:ABC-DEF1234567890abcdefghijklmno",
    TELEGRAM_ALLOWED_USER_IDS: "111111111",
  };

  const makeProvider = (queryFn?: GeminiQueryFn): GeminiProvider =>
    new GeminiProvider({ defaultModel: "gemini-3.7-flash", queryFn });

  const collect = async (
    provider: GeminiProvider,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<ProviderEvent[]> => {
    const events: ProviderEvent[] = [];
    for await (const event of provider.sendPrompt({
      prompt: "hello",
      cwd: "/tmp/proj",
      sessionId: null,
      model: null,
      signal,
    })) {
      events.push(event);
    }
    return events;
  };

  describe("ProviderId: gemini", () => {
    it("is included in PROVIDER_IDS and recognized by isProviderId", () => {
      expect(PROVIDER_IDS).toContain("gemini");
      expect(isProviderId("gemini")).toBe(true);
      expect(isProviderId("not-a-provider")).toBe(false);
    });
  });

  describe("GeminiProvider", () => {
    it("declares itself non-agentic, non-resumable, no permission prompts, interruptible", () => {
      const provider = makeProvider();
      expect(provider.capabilities).toEqual({
        agentic: false,
        resumableSessions: false,
        permissionPrompts: false,
        interruptible: true,
      });
    });

    it("fails closed with a fatal error when no query function was injected", async () => {
      const events = await collect(makeProvider());
      expect(events).toEqual([
        {
          type: "error",
          fatal: true,
          message: "Gemini query function was not injected. Wire it through packages/harness-factory (OIK-033).",
        },
      ]);
    });

    it("translates a successful governed response into text_delta + turn_complete with a real computed cost", async () => {
      const result: GeminiQueryResult = {
        text: "Hello from Gemini",
        denied: false,
        usageMetadata: { promptTokenCount: 1_000_000, candidatesTokenCount: 1_000_000, totalTokenCount: 2_000_000 },
        sessionId: "gemini-session-1",
      };
      const queryFn: GeminiQueryFn = async () => result;
      const events = await collect(makeProvider(queryFn));

      expect(events).toEqual([
        { type: "text_delta", text: "Hello from Gemini" },
        { type: "turn_complete", sessionId: "gemini-session-1", costUsd: 0.75 + 3.75, durationMs: null, turns: 1 },
      ]);
    });

    it("computes costUsd from known usage values via TASK-096's calculator, not a placeholder", async () => {
      const queryFn: GeminiQueryFn = async () => ({
        text: "ok",
        denied: false,
        usageMetadata: { promptTokenCount: 500_000, candidatesTokenCount: 200_000, totalTokenCount: 700_000 },
        sessionId: null,
      });
      const events = await collect(makeProvider(queryFn));
      const turnComplete = events.find((e) => e.type === "turn_complete");
      expect(turnComplete).toMatchObject({ costUsd: (500_000 / 1_000_000) * 0.75 + (200_000 / 1_000_000) * 3.75 });
    });

    it("treats missing usageMetadata as zero cost, never null and never a placeholder", async () => {
      const queryFn: GeminiQueryFn = async () => ({ text: "ok", denied: false, sessionId: null });
      const events = await collect(makeProvider(queryFn));
      const turnComplete = events.find((e) => e.type === "turn_complete");
      expect(turnComplete).toMatchObject({ costUsd: 0 });
    });

    it("omits text_delta when the response text is empty", async () => {
      const queryFn: GeminiQueryFn = async () => ({ text: "", denied: false, sessionId: null });
      const events = await collect(makeProvider(queryFn));
      expect(events.filter((e) => e.type === "text_delta")).toHaveLength(0);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("turn_complete");
    });

    it("emits a fatal error carrying the denial reason when the governed loop denies the turn", async () => {
      const queryFn: GeminiQueryFn = async () => ({
        text: "",
        denied: true,
        deniedReason: "Gemini API key is unavailable",
        sessionId: null,
      });
      const events = await collect(makeProvider(queryFn));
      expect(events).toEqual([{ type: "error", fatal: true, message: "Gemini API key is unavailable" }]);
    });

    it("emits a generic fatal error when denied without a reason", async () => {
      const queryFn: GeminiQueryFn = async () => ({ text: "", denied: true, sessionId: null });
      const events = await collect(makeProvider(queryFn));
      expect(events).toEqual([{ type: "error", fatal: true, message: "Gemini turn was denied." }]);
    });

    it("emits a fatal error (not thrown) when the query function rejects", async () => {
      const queryFn: GeminiQueryFn = async () => {
        throw new Error("network exploded");
      };
      const events = await collect(makeProvider(queryFn));
      expect(events).toEqual([{ type: "error", fatal: true, message: "network exploded" }]);
    });

    it("emits a non-fatal interrupted error when the caller's signal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();
      const queryFn: GeminiQueryFn = async () => ({ text: "too late", denied: false, sessionId: null });
      const events = await collect(makeProvider(queryFn), controller.signal);
      expect(events).toEqual([{ type: "error", message: "Interrupted by user.", fatal: false }]);
    });

    it("never receives an L1/broker port — its query function signature structurally cannot accept one", async () => {
      // The test double below is the entire injectable surface: prompt/cwd/model/
      // sessionId/signal in, a Promise<GeminiQueryResult> out. There is no
      // parameter for an L1 PreToolUseHookPort, unlike packages/harness-factory's
      // createGeminiAdapter which requires one. This asserts that shape by
      // construction: the double below satisfies GeminiQueryFn without ever
      // touching a broker/L1 concept, and GeminiProvider calls nothing else.
      let calledWith: unknown;
      const queryFn: GeminiQueryFn = async (input) => {
        calledWith = input;
        return { text: "fine", denied: false, sessionId: null };
      };
      await collect(makeProvider(queryFn));
      expect(calledWith).toEqual({
        prompt: "hello",
        cwd: "/tmp/proj",
        model: "gemini-3.7-flash",
        sessionId: null,
        signal: expect.any(AbortSignal),
      });
    });
  });

  describe("config.ts: GEMINI_API_KEY / GEMINI_MODEL loading", () => {
    it("is undefined when absent, same as the other optional provider keys", () => {
      const config = loadConfig(baseEnv);
      expect(config.GEMINI_API_KEY).toBeUndefined();
      expect(config.GEMINI_MODEL).toBe("gemini-3.7-flash");
    });

    it("loads a present, non-empty GEMINI_API_KEY verbatim", () => {
      const config = loadConfig({ ...baseEnv, GEMINI_API_KEY: "YOUR_KEY" });
      expect(config.GEMINI_API_KEY).toBe("YOUR_KEY");
    });

    it("treats an empty-string GEMINI_API_KEY the same as absent (never a blank credential)", () => {
      const config = loadConfig({ ...baseEnv, GEMINI_API_KEY: "" });
      expect(config.GEMINI_API_KEY).toBeUndefined();
    });

    it("never surfaces the API key value in a thrown ConfigError message", () => {
      try {
        loadConfig({ ...baseEnv, GEMINI_API_KEY: "YOUR_KEY", DEFAULT_PROVIDER: "not-a-provider" });
        expect.unreachable();
      } catch (err) {
        expect(String(err)).not.toContain("YOUR_KEY");
      }
    });

    it("accepts a GEMINI_MODEL override", () => {
      const config = loadConfig({ ...baseEnv, GEMINI_MODEL: "gemini-3.7-pro" });
      expect(config.GEMINI_MODEL).toBe("gemini-3.7-pro");
    });

    it("accepts 'gemini' as a valid DEFAULT_PROVIDER", () => {
      const config = loadConfig({ ...baseEnv, DEFAULT_PROVIDER: "gemini" });
      expect(config.DEFAULT_PROVIDER).toBe("gemini");
    });
  });
}
