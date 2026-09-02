# google-calendar — onboarding record

**Onboarded by:** ORCH · **Date:** 2026-09-02 · **G-CONN status: CLOSED** (Tier-3 not unlocked)
Manifest: `packages/connectors/manifests/google-calendar.yaml` · Suite: `evals/golden/suites/google-calendar/` · Task: TASK-049 (OIK-053)

## 1. Account (N5)
`account_ownership: basileia` — present, enforced by the same OIK-047 `z.literal` validator as every other connector. Target is the Basileia-owned Google Calendar. No client, employer, or third-party calendar is in scope.

## 2. Scopes + justification

| Scope | Justification | Consuming capability |
|---|---|---|
| `calendar.readonly` | List/read events for scheduling and summarisation | `calendar.list`, `calendar.read` (both `T0_observe`) |
| `calendar.events` | Backs event create/update/delete — present so the tier map is complete and auditable | `calendar.create_event`/`update_event`/`delete_event` (all `T3_external`, `enabled: false`) |

No scope is present without a consuming capability. Unlike Gmail's deliberate scope/capability split (send scope withheld entirely), Calendar's write scope is present but every capability it backs is disabled at the capability layer — defence stacks at the `enabled` flag rather than at scope absence here, since a single `calendar.events` scope legitimately covers all three mutation capabilities.

## 3. Tier map + T3 rationale

| Tool | Capability | Tier | Notes |
|---|---|---|---|
| `mcp__google-calendar__list_events` | `calendar.list` | `T0_observe` | Read-only, no external effect |
| `mcp__google-calendar__get_event` | `calendar.read` | `T0_observe` | Read-only, no external effect |
| `mcp__google-calendar__create_event` | `calendar.create_event` | `T3_external` | Externally-visible — invites attendees outside the account |
| `mcp__google-calendar__update_event` | `calendar.update_event` | `T3_external` | Externally-visible — notifies attendees of changes |
| `mcp__google-calendar__delete_event` | `calendar.delete_event` | `T3_external` | Externally-visible — cancels/notifies attendees; irreversible for the recipient's view |

Per this task's ADR-010 disposition note: under Addendum F §5.3 a T3 tier no longer implies an approval card by itself — the manifest's `enabled: false` posture is the real gate here (a G-CONN gate), and these three capabilities remain the highest-risk in the manifest, flagged as candidates for a per-role Require Approval rule (Addendum F §5.4) once roles exist for this connector.

## 4. Disabled until G-CONN
`calendar.create_event`, `calendar.update_event`, `calendar.delete_event` all ship `enabled: false`. Verified at review (TASK-049): registration lands all three mutation capabilities with `enabled = false` while `calendar.list`/`calendar.read` land `enabled = true`; a second registration run produced byte-identical capability/role_grant snapshots (idempotent).

## 5. Evals
Suite: `evals/golden/suites/google-calendar/` — 4 golden tasks (`list-today`, `list-upcoming-week`, `read-event-details`, `find-free-slot`), all `T0_observe`, inside the read-only ceiling.

ORCH-verified 2026-09-02 in the review worktree via the OIK-051 runner:
- **Positive:** `pass_rate: 1` (4/4), `harness_invocations: 4`, exit 0 — ≥ `min_pass_rate: 0.90`.
- **Negative:** non-matching output ⇒ `pass_rate: 0`, `passed: false`, exit 1. Scoring confirmed live, not vacuous.

**Same caveat as Gmail (§5):** assertions are substring `contains` checks — adequate as a wiring/regression gate, not evidence of model quality on their own.

## 6. Reversal
- **Deregistration:** `deregisterConnector("google-calendar")` — same adapter-scoped deletion mechanism as every other connector (OIK-048).
- **Runtime kill:** capability kill switch (OIK-030) — `capabilities.enabled = false` denies immediately, no restart.
- **Scope revocation:** revoke the OAuth grant on the Basileia Google account.

## 7. Decision
Google Calendar is **onboarded in read-only mode**. Tier 0 (list/read) is live; all three T3 mutation capabilities remain disabled.

**G-CONN for Calendar is NOT open.** Opening it requires the same bar as Gmail (§7 of that record): a live OIK-049 enumeration run against the real MCP server with zero unmapped tools, strengthened discriminating eval assertions, deliberate scope review, live-run seams (real broker + real audit sink), and Alister's explicit decision — plus, given the finding in §3, a decision on whether a per-role Require Approval rule should gate these three capabilities even once G-CONN opens, rather than relying on the fixed enforced floor alone (none of E1–E5 currently covers "notify external calendar attendees").
