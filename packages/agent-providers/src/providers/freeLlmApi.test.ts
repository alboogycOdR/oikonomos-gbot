import { FreeLlmApiProvider } from "./freeLlmApi.js";
import { isProviderId, PROVIDER_IDS, type ProviderEvent } from "../types.js";

if (import.meta.vitest) {
  const { describe, expect, it, vi } = import.meta.vitest;

  async function collect(provider: FreeLlmApiProvider): Promise<ProviderEvent[]> {
    const events: ProviderEvent[] = [];
    for await (const event of provider.sendPrompt({
      prompt: "classify this",
      cwd: "/unused",
      sessionId: null,
      model: null,
      signal: new AbortController().signal,
    })) events.push(event);
    return events;
  }

  describe("FreeLlmApiProvider", () => {
    it("is a registered non-agentic provider", () => {
      expect(PROVIDER_IDS).toContain("free-llm-api");
      expect(isProviderId("free-llm-api")).toBe(true);
      expect(new FreeLlmApiProvider({ endpoint: "http://router/v1/chat/completions", defaultModel: "cheap" }).capabilities)
        .toEqual({ agentic: false, resumableSessions: false, permissionPrompts: false, interruptible: true });
    });

    it("maps an OpenAI-compatible completion to a costed turn", async () => {
      const fetch = vi.fn(async () => new Response(JSON.stringify({
        choices: [{ message: { content: "0.8" } }],
        usage: { cost_usd: 0.0125 },
      }), { status: 200 }));
      const events = await collect(new FreeLlmApiProvider({ endpoint: "http://router/v1/chat/completions", defaultModel: "cheap", fetch }));
      expect(events).toEqual([
        { type: "text_delta", text: "0.8" },
        { type: "turn_complete", sessionId: null, costUsd: 0.0125, durationMs: null, turns: 1 },
      ]);
      expect(fetch).toHaveBeenCalledWith("http://router/v1/chat/completions", expect.objectContaining({ method: "POST" }));
    });

    it("fails closed when the router is unavailable", async () => {
      const events = await collect(new FreeLlmApiProvider({
        endpoint: "http://router/v1/chat/completions",
        defaultModel: "cheap",
        fetch: async () => { throw new Error("connection refused"); },
      }));
      expect(events).toEqual([{ type: "error", fatal: true, message: "FreeLLMAPI unavailable." }]);
    });

    it("does not expose an API key in failure messages", async () => {
      const events = await collect(new FreeLlmApiProvider({
        endpoint: "http://router/v1/chat/completions",
        defaultModel: "cheap",
        apiKey: "not-for-logs",
        fetch: async () => { throw new Error("router unavailable"); },
      }));
      expect(JSON.stringify(events)).not.toContain("not-for-logs");
    });
  });
}
