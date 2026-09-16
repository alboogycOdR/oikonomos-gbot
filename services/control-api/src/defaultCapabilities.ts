/**
 * TASK-264 — implements ADR-018 "Amendment 2026-09-16" (see
 * `docs/decisions/ADR-018-bot-templates.md#amendment-2026-09-16`).
 *
 * `POST /roles` used to auto-grant every capability whose `adapter` was
 * `sdk:builtin` — a filter on *implementation detail* (is this capability
 * an in-process SDK tool or an MCP server call?), not on the property that
 * actually determines whether a human's consent is needed first: does
 * invoking this capability touch one specific external account/mailbox/
 * calendar that belongs to someone, or is it a shared, sandboxed,
 * Basileia-owned tool with no personal data behind it at all?
 *
 * `DEFAULT_ROLE_CAPABILITIES` replaces that adapter-tag filter with an
 * explicit, named set. Every capability id here is granted automatically to
 * every freshly-created role, at that capability's live manifest-declared
 * `default_tier` (resolved the same way `POST /roles` already resolves it
 * today — via `CapabilityRegistry`/the `capabilities` table — never
 * hardcoded here).
 *
 * Deliberately EXCLUDED, and required to remain manual-grant-only:
 *   - `workspace.request_secret` — handing over a credential is
 *     consequential regardless of account ownership.
 *   - every Gmail / Calendar / Drive capability id — these are exactly the
 *     account-linked case that correctly requires an explicit human grant
 *     step (CLAUDE.md non-negotiable #5, scope boundary).
 *
 * `browser.interact` is included per the amendment's own explicit set
 * (see the ADR amendment text and TASK-264's dossier for the reviewer-facing
 * discussion of whether it belongs at the same weight as its read-only
 * Steel siblings — that call was deliberately left open for TASK-265's
 * adversarial review, not decided unilaterally here).
 */
export const DEFAULT_ROLE_CAPABILITIES = Object.freeze([
  // Unchanged from the original built-in floor (sdk:builtin).
  "fs.read",
  "fs.write",
  "runtime.bash",
  // New — Steel browser sandbox, Basileia-owned, no personal account behind it.
  "browser.session",
  "browser.navigate",
  "browser.read",
  "browser.interact",
  "browser.screenshot",
  // New — core product self-management, not an external account at all.
  "workspace.rename_self",
  "workspace.send_to_role",
  "workspace.create_routine",
] as const);

export type DefaultRoleCapabilityId = (typeof DEFAULT_ROLE_CAPABILITIES)[number];

/** True iff `capabilityId` is a member of the automatic role-creation floor. */
export function isDefaultRoleCapability(capabilityId: string): capabilityId is DefaultRoleCapabilityId {
  return (DEFAULT_ROLE_CAPABILITIES as readonly string[]).includes(capabilityId);
}
