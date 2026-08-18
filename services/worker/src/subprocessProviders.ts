import { CodexProvider, GrokProvider, type CodexProviderOptions, type GrokProviderOptions } from "@oikonomos/agent-providers";
import type { SubprocessProviderFactories } from "@oikonomos/harness-factory/compose";

export type GatedCodexOptions = Omit<CodexProviderOptions, "gateSpawn">;
export type GatedGrokOptions = Omit<GrokProviderOptions, "gateSpawn">;

/**
 * Production Codex/Grok factories. The gate argument is the one
 * `composeHarness` binds to L1 — callers must not construct these
 * providers with a missing or locally-invented spawn gate.
 */
export function createGatedSubprocessProviders(
  options: { readonly codex: GatedCodexOptions; readonly grok: GatedGrokOptions },
): SubprocessProviderFactories<CodexProvider, GrokProvider> {
  if (typeof options !== "object" || options === null) {
    throw new Error("createGatedSubprocessProviders requires provider options");
  }
  return {
    createCodex: (gate) =>
      new CodexProvider({
        ...options.codex,
        gateSpawn: gate,
      }),
    createGrok: (gate) =>
      new GrokProvider({
        ...options.grok,
        gateSpawn: gate,
      }),
  };
}
