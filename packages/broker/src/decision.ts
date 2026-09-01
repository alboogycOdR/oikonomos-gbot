/**
 * Model-directed deny decisions (TASK-067, study §Tier 1.5).
 *
 * Grok Bot writes twelve distinct refusal texts *to the model*: what
 * happened, do-not-retry, what to do instead. A denial without that
 * guidance burns agent turns on retries. This module is the broker's
 * closed catalog of the same shape: `{code, humanReason, modelGuidance}`.
 *
 * Additive: existing L1 `{decision:"deny", reason}` responses are
 * unchanged. Callers that want guidance mint it here via
 * {@link denyDecision} — the only constructor, so a denial without
 * guidance is unrepresentable.
 *
 * `packages/broker/src/index.ts` is outside TASK-067 Owned_Paths; this
 * module is not re-exported from the package root. TASK-073 (refusal
 * memory) and later L1 wiring import it directly.
 */

import { ALLOWLIST_MISS_REASON } from "./recheck.js";

/** Stable deny codes. Twelve entries — the SAND_LOCAL_TOOLS_* reference count. */
export const denyCodes = [
  "describe.undescribable",
  "describe.unpresentable",
  "allowlist.miss",
  "capability.unregistered",
  "capability.disabled",
  "approval.not_granted",
  "approval.expired",
  "approval.unavailable",
  "approval.cancelled",
  "refusal.abandoned",
  "refusal.stale_run",
  "refusal.saturated",
] as const;

export type DenyCode = (typeof denyCodes)[number];

/**
 * Operator-facing reason plus model-facing guidance. `code` is the
 * stable audit/reason token (matches existing dotted deny reasons
 * where those already exist, e.g. {@link ALLOWLIST_MISS_REASON}).
 */
export interface DenyDecision {
  readonly decision: "deny";
  readonly code: DenyCode;
  readonly humanReason: string;
  readonly modelGuidance: string;
}

interface DenialCopy {
  readonly humanReason: string;
  readonly modelGuidance: string;
}

/**
 * Closed catalog. Every `modelGuidance` states (1) what happened,
 * (2) do not retry, (3) an alternative. Phrasing is OIKONOMOS's, not
 * a paste of Grok Bot's "user's computer" / Shell/Read copy — the
 * reference is the *shape*, not the product surface.
 */
const DENIALS: { readonly [C in DenyCode]: DenialCopy } = {
  "describe.undescribable": {
    humanReason:
      "The broker could not render this tool call into a human-readable action and target, so it cannot be approved and did not run.",
    modelGuidance:
      "The broker could not describe that tool call to the operator, so it could not ask permission and did not run it. Do not retry it. Use a registered tool that has a describer, or ask the operator in chat to handle it.",
  },
  "describe.unpresentable": {
    humanReason:
      "The action target exceeds 10,000 characters and cannot be presented for approval, so the call did not run.",
    modelGuidance:
      "That action is too long to show the operator for approval, so it was not run. Do not retry it with the same payload. Split it into smaller steps, or ask the operator in chat to handle it.",
  },
  [ALLOWLIST_MISS_REASON]: {
    humanReason:
      "This tool is not on the derived allowlist / connector-manifest map, so the call did not run.",
    modelGuidance:
      "This tool is not on the current allowlist, so it did not run. Do not retry it. Use a tool that is on the allowlist, or ask the operator to add it to the connector manifest.",
  },
  "capability.unregistered": {
    humanReason: "No capability is registered for this tool name, so the call did not run.",
    modelGuidance:
      "This tool is not a registered capability, so it did not run. Do not retry it. Use a registered tool, or ask the operator to register the capability.",
  },
  "capability.disabled": {
    humanReason: "The capabilities kill switch is off, so the call did not run.",
    modelGuidance:
      "Capabilities are disabled for this control plane, so the tool did not run. Do not retry it while the kill switch remains off. Ask the operator to re-enable capabilities, or continue without this tool.",
  },
  "approval.not_granted": {
    humanReason: "No live approval covers this action, so the call did not run.",
    modelGuidance:
      "That action was not approved, so nothing ran. Do not retry it. Ask the operator to approve it, or continue with work that does not need this tool.",
  },
  "approval.expired": {
    humanReason: "The approval request expired unanswered, so the call did not run.",
    modelGuidance:
      "The request for operator approval went unanswered, so nothing ran. Do not retry the same call. Tell the operator you are waiting on their approval, or continue with work that does not need this tool.",
  },
  "approval.unavailable": {
    humanReason: "There is nowhere to ask for operator approval in this conversation, so the call did not run.",
    modelGuidance:
      "This action needs operator permission and this conversation has nowhere to ask for it. Do not retry it. Continue with work that does not need this tool, or raise it in a channel where the operator can approve.",
  },
  "approval.cancelled": {
    humanReason: "The approval request was cancelled before the operator answered, so the call did not run.",
    modelGuidance:
      "The request for operator approval was cancelled before they answered, so nothing ran. Do not retry it. Ask the operator whether they still want this action, or continue without it.",
  },
  "refusal.abandoned": {
    humanReason:
      "This exact action was already refused in this run and will not be re-asked, so the call did not run.",
    modelGuidance:
      "The operator was already asked about this exact action and did not approve it, so it will not run and will not be asked again for this run — a later permission change does not authorize it. Do not retry it. If it still needs to happen, say so in chat and let the operator ask for it.",
  },
  "refusal.stale_run": {
    humanReason:
      "Earlier requests in this run were not approved and the operator has moved on, so nothing further from this run will be asked.",
    modelGuidance:
      "Earlier requests in this run were not approved and the operator has since moved on, so nothing from this run will be asked again. Do not retry. If it still needs to happen, say so in chat and let the operator ask for it.",
  },
  "refusal.saturated": {
    humanReason:
      "This run's refusal memory is saturated, so further tool calls in the run are denied rather than forgetting a refusal.",
    modelGuidance:
      "This run has hit the refusal-memory cap, so further tool calls in it are denied. Do not retry them. Finish in chat, or wait for a new run.",
  },
};

Object.freeze(DENIALS);

const DENY_CODE_SET: ReadonlySet<string> = new Set(denyCodes);

export function isDenyCode(value: unknown): value is DenyCode {
  return typeof value === "string" && DENY_CODE_SET.has(value);
}

/**
 * The only way to mint a {@link DenyDecision}. Unknown codes fail
 * closed to `describe.undescribable` rather than emitting empty
 * guidance (N3).
 */
export function denyDecision(code: DenyCode): DenyDecision {
  const entry = Object.hasOwn(DENIALS, code) ? DENIALS[code] : DENIALS["describe.undescribable"];
  const resolved: DenyCode = Object.hasOwn(DENIALS, code) ? code : "describe.undescribable";
  return Object.freeze({
    decision: "deny",
    code: resolved,
    humanReason: entry.humanReason,
    modelGuidance: entry.modelGuidance,
  });
}

/** Look up catalog copy without constructing a decision (tests / TASK-073). */
export function denialCopy(code: DenyCode): DenialCopy {
  const entry = Object.hasOwn(DENIALS, code) ? DENIALS[code] : DENIALS["describe.undescribable"];
  return Object.freeze({
    humanReason: entry.humanReason,
    modelGuidance: entry.modelGuidance,
  });
}
