/**
 * Namespaced provider metadata (TASK-072).
 *
 * Provider-specific extras (Claude Agent SDK session refs, Codex response
 * ids, ...) travel under a provider-keyed namespace instead of widening the
 * shared `AgentSession`/`TurnCompleteEvent` types in `types.ts`. This file
 * is purely additive: it does not modify `types.ts` (out of this task's
 * Owned_Paths anyway) — it layers a namespaced extras map on top of the
 * existing `ProviderId` union.
 */
import type { ProviderId } from "./types.js";

/** Claude Agent SDK extras: its own session identifier. */
export interface ClaudeCodeProviderExtras {
  sessionRef?: string;
}

/** Codex CLI extras: the response id of the last turn. */
export interface CodexProviderExtras {
  responseId?: string;
}

/** Grok Build CLI extras: its own session identifier. */
export interface GrokProviderExtras {
  sessionRef?: string;
}

/** Gemini REST API extras: none surfaced beyond usage metadata (handled separately). */
export interface GeminiProviderExtras {
  sessionRef?: string;
}

/** Maps each `ProviderId` to its own extras shape — the namespace keys. */
export interface ProviderExtrasMap {
  "claude-code": ClaudeCodeProviderExtras;
  codex: CodexProviderExtras;
  grok: GrokProviderExtras;
  gemini: GeminiProviderExtras;
}

/**
 * A bag of provider extras, each reachable only under its own provider key
 * — e.g. `{ claude: { sessionRef } }`-shaped data from the study, but keyed
 * by the real `ProviderId` values so it stays in sync with `PROVIDER_IDS`.
 * Every key is optional: a caller only ever populates the namespace for the
 * provider it is currently talking to.
 */
export type NamespacedProviderExtras = {
  [K in ProviderId]?: ProviderExtrasMap[K];
};

/** Reads the extras for one provider out of a namespaced bag, if present. */
export function extrasFor<K extends ProviderId>(
  extras: NamespacedProviderExtras | undefined,
  provider: K,
): ProviderExtrasMap[K] | undefined {
  return extras?.[provider];
}

/**
 * Returns a new namespaced bag with `provider`'s extras set to `value`,
 * leaving every other provider's namespace untouched. Never mutates `extras`.
 */
export function withProviderExtras<K extends ProviderId>(
  extras: NamespacedProviderExtras | undefined,
  provider: K,
  value: ProviderExtrasMap[K],
): NamespacedProviderExtras {
  return { ...extras, [provider]: value };
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  describe("namespaced provider extras", () => {
    it("extrasFor reads only the requested provider's namespace", () => {
      const bag: NamespacedProviderExtras = {
        "claude-code": { sessionRef: "abc" },
        codex: { responseId: "resp_1" },
      };

      expect(extrasFor(bag, "claude-code")).toEqual({ sessionRef: "abc" });
      expect(extrasFor(bag, "codex")).toEqual({ responseId: "resp_1" });
      expect(extrasFor(bag, "grok")).toBeUndefined();
      expect(extrasFor(undefined, "grok")).toBeUndefined();
    });

    it("withProviderExtras sets one namespace without touching others", () => {
      const before: NamespacedProviderExtras = { codex: { responseId: "resp_1" } };

      const after = withProviderExtras(before, "grok", { sessionRef: "g1" });

      expect(after).toEqual({
        codex: { responseId: "resp_1" },
        grok: { sessionRef: "g1" },
      });
      // original untouched
      expect(before).toEqual({ codex: { responseId: "resp_1" } });
    });

    it("withProviderExtras overwrites only the target provider's prior value", () => {
      const before: NamespacedProviderExtras = { grok: { sessionRef: "old" } };

      const after = withProviderExtras(before, "grok", { sessionRef: "new" });

      expect(after.grok).toEqual({ sessionRef: "new" });
    });
  });
}
