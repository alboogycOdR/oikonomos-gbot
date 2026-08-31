/**
 * Registration completeness (TASK-072).
 *
 * A provider registry that validates, at registration time, that every
 * member of the `AgentProvider` contract is actually implemented — a
 * partially-implemented provider throws a typed error enumerating the
 * missing members at startup, never failing later on first use (study
 * §Tier 2 item 20, `assertProductionLocalExecRuntime`).
 *
 * This is a standalone, opt-in registry independent of
 * `providers/index.ts`'s `ProviderRegistry` (which lives outside this
 * task's Owned_Paths) — callers that want registration-time validation
 * construct a `ValidatingProviderRegistry` and `register()` each provider
 * into it instead of (or in addition to) the existing registry.
 */
import type { AgentProvider, ProviderId } from "./types.js";

/**
 * Every member the `AgentProvider` interface declares. Kept as an explicit
 * list (rather than derived from the type, which does not exist at
 * runtime) so a contract change is a deliberate, visible edit here too.
 */
const REQUIRED_PROVIDER_MEMBERS = [
  "id",
  "displayName",
  "capabilities",
  "defaultModel",
  "availableModels",
  "sendPrompt",
  "interrupt",
] as const;

type RequiredProviderMember = (typeof REQUIRED_PROVIDER_MEMBERS)[number];

/** Raised when a provider is registered without implementing the full contract. */
export class IncompleteProviderError extends Error {
  readonly providerId: string | undefined;
  readonly missing: readonly RequiredProviderMember[];

  constructor(providerId: string | undefined, missing: readonly RequiredProviderMember[]) {
    super(
      `Provider "${providerId ?? "<unknown>"}" is missing required member(s): ${missing.join(", ")}`,
    );
    this.name = "IncompleteProviderError";
    this.providerId = providerId;
    this.missing = missing;
  }
}

/** Candidate providers are checked structurally: any object, possibly incomplete. */
export type CandidateProvider = Partial<Record<RequiredProviderMember, unknown>>;

/**
 * Throws `IncompleteProviderError` naming every missing/undefined member of
 * the `AgentProvider` contract. Narrows to `AgentProvider` on success.
 */
export function assertProviderComplete(
  candidate: CandidateProvider,
): asserts candidate is CandidateProvider & AgentProvider {
  const missing = REQUIRED_PROVIDER_MEMBERS.filter(
    (member) => candidate[member] === undefined || candidate[member] === null,
  );
  if (missing.length > 0) {
    const id = typeof candidate.id === "string" ? candidate.id : undefined;
    throw new IncompleteProviderError(id, missing);
  }
}

/**
 * A provider registry that validates completeness at `register()` time
 * rather than letting a partially-implemented provider fail later, on
 * first use, with a confusing runtime error far from the real cause.
 */
export class ValidatingProviderRegistry {
  private readonly providers = new Map<ProviderId, AgentProvider>();

  /** Validates `provider` against the full contract, throws if incomplete, else stores it. */
  register(id: ProviderId, provider: CandidateProvider): void {
    assertProviderComplete(provider);
    this.providers.set(id, provider);
  }

  get(id: ProviderId): AgentProvider {
    const provider = this.providers.get(id);
    if (!provider) {
      throw new Error(`No provider registered for id "${id}"`);
    }
    return provider;
  }

  has(id: ProviderId): boolean {
    return this.providers.has(id);
  }

  all(): AgentProvider[] {
    return Array.from(this.providers.values());
  }
}
