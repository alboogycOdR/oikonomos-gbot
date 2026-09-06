/**
 * Describe-or-deny (TASK-067, study §Tier 1.2).
 *
 * Every tool call is mapped to a human-readable `{action, target}` by a
 * **whitelist** describer. Unknown tool shapes return `undefined`, and
 * undefined MUST deny: "if we cannot render it to a human, we cannot
 * ask about it, therefore we do not run it." A target longer than
 * {@link TARGET_MAX_CHARS} is refused as unpresentable.
 *
 * This is the ADR-004 describe step: the `{action, target}` pair is
 * derived from the tool-call payload by a registered function, never
 * accepted as caller-supplied prose. The stored approval render for a
 * later issuance path comes from {@link formatDescribedAction} of that
 * pair, so what the operator sees is what this step bound.
 *
 * Fail-closed on any approval-requiring tier (T3_external and above,
 * matching L1's approval threshold). N3: the same default applies on
 * lower tiers — we never run what we cannot render.
 *
 * Wired into L1 `handlePreToolUse` (TASK-194): an undescribable tool
 * is denied before `issueApproval` / `verifyAndConsume` run. The
 * approval card itself remains ADR-004 `actionRender` in approvals —
 * this module is the gate, not the card formatter.
 */

import { riskTiers, type RiskTier } from "@oikonomos/policy";

import { denyDecision, type DenyDecision } from "./decision.js";

/** Grok Bot `SAND_LOCAL_TOOL_TARGET_MAX_CHARS`. Past this, the card cannot be shown. */
export const TARGET_MAX_CHARS = 10_000;

/** Same threshold L1 uses before issuing an approval (`APPROVAL_TIER` in index.ts). */
export const APPROVAL_TIER: RiskTier = "T3_external";

export interface ToolCall {
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
  /** Digest-bound destination (Handover §4.3 / ADR-004); describers may include it. */
  readonly destination?: string;
}

/** Human-readable approval-card fields. Produced only by a registered describer. */
export interface ActionDescription {
  readonly action: string;
  readonly target: string;
}

/**
 * Whitelist entry. Returning `undefined` (or throwing, or a malformed
 * object) means the shape is unknown — the caller MUST deny.
 */
export type Describer = (call: ToolCall) => ActionDescription | undefined;

export type DescriberRegistry =
  | ReadonlyMap<string, Describer>
  | Readonly<Record<string, Describer>>;

export type DescribeDecision =
  | { readonly decision: "allow"; readonly description: ActionDescription; readonly tier: RiskTier }
  | DenyDecision;

export function requiresHumanApproval(tier: RiskTier): boolean {
  const rank = riskTiers.indexOf(tier);
  const approvalRank = riskTiers.indexOf(APPROVAL_TIER);
  // Unknown tier ⇒ treat as approval-requiring (N3 fail closed).
  if (rank === -1) return true;
  return rank >= approvalRank;
}

function lookupDescriber(
  registry: DescriberRegistry,
  toolName: string,
): Describer | undefined {
  if (registry instanceof Map) {
    const found = registry.get(toolName);
    return typeof found === "function" ? found : undefined;
  }
  if (typeof registry === "object" && registry !== null && Object.hasOwn(registry, toolName)) {
    const found = (registry as Record<string, Describer>)[toolName];
    return typeof found === "function" ? found : undefined;
  }
  return undefined;
}

function isDescription(value: unknown): value is ActionDescription {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ActionDescription>;
  return typeof candidate.action === "string"
    && candidate.action.length > 0
    && typeof candidate.target === "string";
}

/**
 * Run the registered describer for `call.toolName`. Unknown names,
 * non-function entries, throws, and malformed returns are `undefined`.
 * Oversized targets are still returned so {@link describeOrDeny} can
 * refuse them as unpresentable rather than collapsing into undescribable.
 */
export function describeToolCall(
  call: ToolCall,
  describers: DescriberRegistry,
): ActionDescription | undefined {
  if (typeof call.toolName !== "string" || call.toolName.length === 0) {
    return undefined;
  }
  const describer = lookupDescriber(describers, call.toolName);
  if (describer === undefined) {
    return undefined;
  }
  let raw: unknown;
  try {
    raw = describer(call);
  } catch {
    return undefined;
  }
  if (!isDescription(raw)) {
    return undefined;
  }
  return Object.freeze({ action: raw.action, target: raw.target });
}

/**
 * Format the described `{action, target}` for an approval card. Pure
 * function of the describe-step output — no caller-supplied prose
 * channel (ADR-004).
 */
export function formatDescribedAction(description: ActionDescription): string {
  return `action: ${description.action}\ntarget: ${description.target}`;
}

/**
 * Fail-closed gate: a tool call we cannot render, or cannot present,
 * does not run.
 *
 * MUTATION target: if the undefined-description branch falls through
 * to allow, `describe.test.ts` goes red.
 */
export function describeOrDeny(
  call: ToolCall,
  options: { readonly describers: DescriberRegistry; readonly tier: RiskTier },
): DescribeDecision {
  const tier = options.tier;
  const description = describeToolCall(call, options.describers);
  if (description === undefined) {
    // Study §Tier 1.2 / N3: undefined MUST deny, on every approval-requiring
    // tier and as the fail-closed default on every other tier. Do not fall
    // through to allow. MUTATION: returning allow here reddens describe.test.ts.
    return denyDecision("describe.undescribable");
  }
  if (description.target.length > TARGET_MAX_CHARS) {
    return denyDecision("describe.unpresentable");
  }
  return { decision: "allow", description, tier };
}

function stringInput(call: ToolCall, key: string): string | undefined {
  const value = call.input[key];
  return typeof value === "string" ? value : undefined;
}

function targetOf(call: ToolCall, ...keys: string[]): string {
  for (const key of keys) {
    const value = stringInput(call, key);
    if (value !== undefined && value.length > 0) return value;
  }
  return call.destination ?? "";
}

function describeAs(action: string, ...keys: string[]): Describer {
  return (call) => ({ action, target: targetOf(call, ...keys) });
}

/**
 * Default whitelist used by `handlePreToolUse` when the caller does not
 * inject `describers`. Unknown names are still undescribable — this is
 * not a generic fallback.
 *
 * Covers Agent SDK builtins plus the T3 tools existing L1 / canary
 * suites already issue approvals for (gmail send/draft, office act).
 * A tool not listed here is denied before any approval is issued.
 */
export const builtinDescribers: Readonly<Record<string, Describer>> = Object.freeze({
  Read: describeAs("read file", "file_path", "path"),
  Glob: describeAs("glob files", "pattern", "path"),
  Grep: describeAs("grep files", "pattern", "path"),
  Edit: describeAs("edit file", "file_path", "path"),
  Write: describeAs("write file", "file_path", "path"),
  Bash: describeAs("run command", "command"),
  mcp__workspace__send_to_role: describeAs("send to role", "toRoleId"),
  mcp__workspace__rename_self: describeAs("rename self", "name"),
  mcp__gmail__send_message: describeAs("send email", "to"),
  mcp__gmail__create_draft: describeAs("create draft", "to"),
  mcp__gmail__list_messages: describeAs("list messages", "q"),
  mcp__office__act: describeAs("office action", "target"),
});

/** Audit payload type emitted when the describe gate denies on the L1 path. */
export const DESCRIBE_DENIED_AUDIT_TYPE = "describe.denied" as const;
