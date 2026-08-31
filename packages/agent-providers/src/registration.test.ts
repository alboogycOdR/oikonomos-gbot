import type { AgentProvider } from "./types.js";
import {
  IncompleteProviderError,
  ValidatingProviderRegistry,
  assertProviderComplete,
} from "./registration.js";

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  function completeProvider(id: AgentProvider["id"] = "claude-code"): AgentProvider {
    return {
      id,
      displayName: "Fake",
      capabilities: {
        agentic: true,
        resumableSessions: true,
        permissionPrompts: true,
        interruptible: true,
      },
      defaultModel: "fake-model",
      availableModels: ["fake-model"],
      async *sendPrompt() {},
      async interrupt() {},
    };
  }

  describe("assertProviderComplete", () => {
    it("does not throw for a fully-implemented provider", () => {
      expect(() => assertProviderComplete(completeProvider())).not.toThrow();
    });

    it("throws IncompleteProviderError naming every missing member", () => {
      const partial = { id: "codex", displayName: "Codex" };

      let caught: unknown;
      try {
        assertProviderComplete(partial);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(IncompleteProviderError);
      const err = caught as IncompleteProviderError;
      expect(err.providerId).toBe("codex");
      expect(err.missing).toEqual([
        "capabilities",
        "defaultModel",
        "availableModels",
        "sendPrompt",
        "interrupt",
      ]);
      expect(err.message).toContain("codex");
      expect(err.message).toContain("sendPrompt");
    });

    it("reports <unknown> when even id is missing", () => {
      let caught: unknown;
      try {
        assertProviderComplete({});
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(IncompleteProviderError);
      expect((caught as IncompleteProviderError).message).toContain("<unknown>");
    });

    it("treats null members as missing, not present", () => {
      const partial = { ...completeProvider(), interrupt: null };
      expect(() => assertProviderComplete(partial)).toThrow(IncompleteProviderError);
    });
  });

  describe("ValidatingProviderRegistry", () => {
    it("registers and retrieves a complete provider", () => {
      const registry = new ValidatingProviderRegistry();
      const provider = completeProvider("grok");

      registry.register("grok", provider);

      expect(registry.get("grok")).toBe(provider);
      expect(registry.has("grok")).toBe(true);
      expect(registry.all()).toEqual([provider]);
    });

    it("throws at registration time for an incomplete provider, naming the missing member", () => {
      const registry = new ValidatingProviderRegistry();

      expect(() =>
        registry.register("codex", { id: "codex", displayName: "Codex" }),
      ).toThrow(/interrupt/);
    });

    it("does not register a provider that failed validation", () => {
      const registry = new ValidatingProviderRegistry();

      try {
        registry.register("codex", { id: "codex" });
      } catch {
        // expected
      }

      expect(registry.has("codex")).toBe(false);
    });

    it("get() throws a clear error for an unregistered id", () => {
      const registry = new ValidatingProviderRegistry();
      expect(() => registry.get("grok")).toThrow(/No provider registered/);
    });
  });
}
