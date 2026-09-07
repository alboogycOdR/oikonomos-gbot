/**
 * CLAUDE.md non-negotiable #6: no circumvention of CAPTCHA, MFA, or bot
 * protection; Steel Browser stealth features stay disabled; a challenge
 * triggers human takeover, never a model-driven workaround.
 *
 * The pinned steel-mcp-server's `steel_session_create` schema accepts
 * `use_proxy`, `solve_captcha`, `profile_id`, and `namespace` — and its own
 * bot-block error text names `solve_captcha: true` / `use_proxy: true` as
 * the way past it, coaching the model verbatim toward exactly what #6
 * forbids. The only thing stopping that today is the third-party server's
 * own internal self-hosted-mode guard, which itself depends on the worker
 * correctly injecting `STEEL_LOCAL=true` — a real dependency, not an
 * OIKONOMOS-owned control. This guard is the backstop: it denies the call
 * before it ever reaches steel-mcp, independent of that upstream behavior.
 *
 * TASK-207 Blocking-2 (Fable review of `d44e64a`): guardSecretPath's D3
 * backstop is the direct precedent — a fixed-floor gate ahead of the
 * six-rank resolver, immune to grant/tier/allow-rule state.
 */

export const STEEL_SESSION_AUDIT_EVENT_TYPE = "steel_session_circumvention_attempt";
export const STEEL_SESSION_DENIAL_REASON = "steel_session.circumvention_attempt";

const GUARDED_TOOL_NAME = "mcp__steel__steel_session_create";

/** Every field steel-mcp's own bot-block guidance names as a way past detection. */
const CIRCUMVENTION_FIELDS = ["use_proxy", "solve_captcha", "profile_id", "namespace"] as const;

export interface SteelSessionAuditEvent {
  readonly type: typeof STEEL_SESSION_AUDIT_EVENT_TYPE;
  readonly verdict: "deny";
  readonly reason: typeof STEEL_SESSION_DENIAL_REASON;
  /** Which field(s) triggered the denial — never the field's own value. */
  readonly fields: readonly string[];
}

export type SteelSessionGuardDecision =
  | { readonly decision: "allow" }
  | {
    readonly decision: "deny";
    readonly reason: typeof STEEL_SESSION_DENIAL_REASON;
    readonly auditEvent: SteelSessionAuditEvent;
  };

/**
 * Denies a `steel_session_create` call that sets any circumvention field to
 * anything other than `false`, independently of tier, grant, or allow rule.
 * A field's own value is never copied into the audit event — only which
 * field(s) fired, matching guardSecretPath's target-free audit convention.
 */
export function guardSteelSessionSafety(
  toolName: string,
  input: Record<string, unknown>,
): SteelSessionGuardDecision {
  if (toolName !== GUARDED_TOOL_NAME) return { decision: "allow" };

  const triggeredFields = CIRCUMVENTION_FIELDS.filter(
    (field) => field in input && input[field] !== false,
  );
  if (triggeredFields.length === 0) return { decision: "allow" };

  return {
    decision: "deny",
    reason: STEEL_SESSION_DENIAL_REASON,
    auditEvent: {
      type: STEEL_SESSION_AUDIT_EVENT_TYPE,
      verdict: "deny",
      reason: STEEL_SESSION_DENIAL_REASON,
      fields: triggeredFields,
    },
  };
}
