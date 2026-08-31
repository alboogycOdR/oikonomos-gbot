/**
 * Closed error registry with payload allowlist (TASK-069, study §Tier 2).
 *
 * Modeled on Grok Bot's `shared/errors/registry.ts`: every error the
 * platform wants to reason about in logs/audit/metrics is a *registered*
 * error — `{code, domain, retryable, summary, payload}` — minted only
 * through {@link defineRegisteredError}, which is the sole way to add an
 * entry to the closed registry (a second `defineRegisteredError` call
 * reusing an existing `code` throws at module-load time, so the taxonomy
 * cannot silently fork).
 *
 * The single emit-boundary function, {@link emitErrorTags}, is the only
 * place an `Error` becomes loggable/audit-safe tags, and it is fail-closed
 * on both axes the study flagged:
 *
 *  - **Unregistered error** (anything not minted via a generated
 *    constructor) -> the fixed {@link GENERIC_ERROR_CODE}, payload dropped
 *    entirely. No message text, no stack, no ad-hoc fields ever escape.
 *  - **Registered error** -> only the fields its definition's `payload`
 *    array declares are considered, and only string values that match the
 *    bounded safe charset ({@link SAFE_VALUE}) are kept. Anything else
 *    (wrong type, out-of-charset, oversized) is dropped whole, never
 *    truncated-and-kept — a truncated credential fragment is still a
 *    credential fragment.
 *
 * This solves three problems in one structure (study §Tier 2): PII/credential
 * leakage into audit payloads (Directive §4 N4), unbounded metric label
 * cardinality (payload values are charset- and length-bounded), and
 * retryability decisions scattered across catch blocks (`retryable` lives
 * on the definition, read once at the boundary).
 *
 * Zero runtime dependencies, matching packages/shared's existing constraint.
 */

/** `/^[0-9A-Za-z._|:-]{1,64}$/` — the bounded safe charset from the reference implementation. */
export const SAFE_VALUE = /^[0-9A-Za-z._|:-]{1,64}$/;

/** The fixed code every unregistered error maps to. Never present as a registry entry's own `code`. */
export const GENERIC_ERROR_CODE = "ERR_GENERIC_UNREGISTERED";

/** A closed-registry error definition. `payload` is the exhaustive allowlist of field names this error may ever emit. */
export interface ErrorDefinition<P extends string = string> {
  /** Stable machine code. Must be unique across the whole registry. */
  readonly code: string;
  /** Coarse subsystem grouping (e.g. "broker", "approvals"). */
  readonly domain: string;
  /** Whether the caller may safely retry the action that raised this error. */
  readonly retryable: boolean;
  /** Human-readable, credential-free description of the error family. */
  readonly summary: string;
  /** Exhaustive allowlist of payload field names this error definition may emit. */
  readonly payload: readonly P[];
}

/** The audit/log/metric-safe shape every error — registered or not — is reduced to at the emit boundary. */
export interface EmittedErrorTags {
  readonly code: string;
  readonly domain: string;
  readonly retryable: boolean;
  readonly summary: string;
  /** Only declared fields, only safe-charset string values. Frozen and empty for unregistered errors. */
  readonly payload: Readonly<Record<string, string>>;
}

const EMPTY_PAYLOAD: Readonly<Record<string, string>> = Object.freeze({});

/** The generic tags emitted for anything not minted via {@link defineRegisteredError}. */
const GENERIC_TAGS: EmittedErrorTags = Object.freeze({
  code: GENERIC_ERROR_CODE,
  domain: "generic",
  retryable: false,
  summary: "Unregistered error; payload dropped for audit/log safety.",
  payload: EMPTY_PAYLOAD,
});

const registry = new Map<string, ErrorDefinition>();

/**
 * A registered error instance. Never constructed directly — only via the
 * function {@link defineRegisteredError} returns for a given definition, so
 * the registry is the sole taxonomy for minting one.
 */
export class RegisteredError<P extends string = string> extends Error {
  /** The registry code this instance was minted against. */
  readonly registryCode: string;
  /**
   * The raw, UNFILTERED payload as supplied by the caller. May contain
   * anything, including credential-shaped strings — {@link emitErrorTags}
   * is what applies the allowlist and charset filter, never this field
   * directly.
   */
  readonly rawPayload: Readonly<Partial<Record<P, unknown>>>;

  constructor(definition: ErrorDefinition<P>, payload: Partial<Record<P, unknown>>, message?: string) {
    super(message ?? definition.summary);
    this.name = "RegisteredError";
    this.registryCode = definition.code;
    this.rawPayload = Object.freeze({ ...payload });
  }
}

/** The typed constructor returned by {@link defineRegisteredError} for one definition. */
export type RegisteredErrorConstructor<P extends string> = (
  payload: Partial<Record<P, unknown>>,
  message?: string,
) => RegisteredError<P>;

/**
 * Register one error definition and return its typed constructor — the
 * only way to mint an error carrying that `code`. Throws synchronously if
 * `code` is already registered (including `GENERIC_ERROR_CODE`, which is
 * reserved) or if `payload` names are not distinct, so a copy-paste
 * duplicate is caught at import time, not silently overwritten.
 */
export function defineRegisteredError<const P extends string>(
  definition: ErrorDefinition<P>,
): RegisteredErrorConstructor<P> {
  if (definition.code === GENERIC_ERROR_CODE) {
    throw new Error(`error registry: code "${GENERIC_ERROR_CODE}" is reserved for unregistered errors`);
  }
  if (registry.has(definition.code)) {
    throw new Error(`error registry: duplicate code "${definition.code}"`);
  }
  const seen = new Set<string>();
  for (const field of definition.payload) {
    if (seen.has(field)) {
      throw new Error(`error registry: duplicate payload field "${field}" on code "${definition.code}"`);
    }
    seen.add(field);
  }

  const frozen: ErrorDefinition<P> = Object.freeze({
    ...definition,
    payload: Object.freeze([...definition.payload]) as readonly P[],
  });
  registry.set(definition.code, frozen);

  return (payload, message) => new RegisteredError<P>(frozen, payload, message);
}

/** Read-only lookup of a registered definition by code, or `undefined` if unregistered. Does not expose a way to mutate the registry. */
export function lookupErrorDefinition(code: string): ErrorDefinition | undefined {
  return registry.get(code);
}

/**
 * The single emit boundary: converts any thrown value into loggable/audit-safe
 * tags. Fail-closed — anything not a {@link RegisteredError} minted against a
 * still-registered code collapses to the fixed generic tags with an empty,
 * frozen payload.
 */
export function emitErrorTags(error: unknown): EmittedErrorTags {
  if (!(error instanceof RegisteredError)) {
    return GENERIC_TAGS;
  }
  const definition = registry.get(error.registryCode);
  if (!definition) {
    // Defensive: a RegisteredError instance whose code is no longer in the
    // registry (should be unreachable since defineRegisteredError is the
    // only minting path) is still treated as unregistered, never trusted.
    return GENERIC_TAGS;
  }

  const payload: Record<string, string> = {};
  for (const field of definition.payload) {
    const value = error.rawPayload[field as keyof typeof error.rawPayload];
    if (typeof value === "string" && SAFE_VALUE.test(value)) {
      payload[field] = value;
    }
    // Non-string, missing, out-of-charset, or oversized values are dropped
    // entirely — never truncated-and-kept.
  }

  return Object.freeze({
    code: definition.code,
    domain: definition.domain,
    retryable: definition.retryable,
    summary: definition.summary,
    payload: Object.freeze(payload),
  });
}
