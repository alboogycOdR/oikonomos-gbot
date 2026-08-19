# gmail — onboarding record

**Onboarded by:** ORCH · **Date:** 2026-08-19 · **G-CONN status: CLOSED** (Tier-3 not unlocked)
Manifest: `packages/connectors/manifests/gmail.yaml` · Suite: `evals/golden/suites/gmail/` · Task: TASK-048 (OIK-052)

## 1. Account (N5)
`account_ownership: basileia` — present and enforced by the OIK-047 validator as a `z.literal`, not a free string. Target is the Basileia-owned Gmail account. No client, employer, or third-party mailbox is in scope; a non-`basileia` value is rejected in CI (proven: a planted manifest exits 1 naming the field).

## 2. Scopes + justification

| Scope | Justification | Consuming capability |
|---|---|---|
| `gmail.readonly` | Read inbox/threads to triage and summarise | `email.list` (T0_observe) |
| `gmail.compose` | Create drafts for human review; does **not** grant send | `email.create_draft` (T1_draft) |

`gmail.send` is **deliberately absent** from `oauth_scopes` in Wave 1 (WBS OIK-052; Handover §4.4). The `email.send` capability exists in the manifest so the tier map is complete and auditable, but no OAuth scope backs it — a defence-in-depth pairing: even if the capability were enabled by mistake, the token cannot send.

No scope is present without a consuming capability.

## 3. Tier map + T3 rationale

| Tool | Capability | Tier | Notes |
|---|---|---|---|
| `mcp__gmail__list_messages` | `email.list` | `T0_observe` | Read-only, no external effect |
| `mcp__gmail__create_draft` | `email.create_draft` | `T1_draft` | Produces reviewable artifact; nothing leaves the account |
| `mcp__gmail__send_message` | `email.send` | `T3_external` | **Irreversible external effect** — mail sent cannot be recalled and reaches third parties. T3 is correct and must never be softened |

Unmapped tools deny by default (Handover §4.2, proven by TASK-045's enumeration check driving the real `resolveCapabilityTier` to a deny). Run the OIK-049 enumeration against the live MCP server before G-CONN opens, to confirm the server exposes no tool outside this map.

## 4. Disabled until G-CONN
`email.send` ships `enabled: false`. Verified live at review: registration lands the capability row with `enabled = false` while the other two land `enabled = true`.

**Known interaction, recorded deliberately:** the OIK-048 registration pipeline cross-products each `role_grant` across every tool, so `inbox-triage` holds a grant row against `email.send` at `max_tier: T1_draft`. That grant does not confer send — the capability's `enabled: false` gates it, and tier resolution takes the more-restrictive of capability default and grant ceiling (Handover §4.2, ADR-003). Flagged so no future reader mistakes the grant row for an unlock.

## 5. Evals
Suite: `evals/golden/suites/gmail/` — 4 golden tasks (`list-unread`, `summarize-thread`, `draft-reply`, `draft-followup`), all `T0_observe`/`T1_draft`, inside the draft-only ceiling.

ORCH-verified 2026-08-19 in the review worktree via the OIK-051 runner:
- **Positive:** `pass_rate: 1` (4/4), `harness_invocations: 4`, exit 0 — ≥ `min_pass_rate: 0.90`.
- **Negative:** non-matching output ⇒ `pass_rate: 0`, `passed: false`, exit 1. Scoring is live, not vacuous.

**Caveat for live runs:** assertions are substring `contains` checks, so an output that emits all the boilerplate phrases would pass every task regardless of prompt. Adequate as a wiring/regression gate; strengthen with discriminating assertions before treating an eval pass as evidence of model quality.

## 6. Reversal
- **Deregistration:** `deregisterConnector("gmail")` removes only rows whose adapter is `mcp:gmail` (OIK-048; verified — a second connector's rows stay byte-identical, and the mutation widening the `WHERE` is caught by tests).
- **Runtime kill:** capability kill switch (OIK-030) — `capabilities.enabled = false` denies immediately, no restart.
- **Scope revocation:** revoke the OAuth grant on the Basileia Google account.

## 7. Decision
Gmail is **onboarded in draft-only mode**. Tiers 0–1 are live; `email.send` (T3) remains disabled.

**G-CONN for Gmail is NOT open.** Opening it is Alister's explicit decision, not an automatic consequence of evals passing. Before it opens, require: (a) the OIK-049 enumeration run against the live MCP server with zero unmapped tools, (b) strengthened discriminating eval assertions per §5, (c) the `gmail.send` OAuth scope added deliberately with its own review, and (d) live-run seams injected — both a real `pretooluse` broker and a real `auditSink` (carried from TASK-046; the runner's defaults are deny-and-discard, safe for evals but not evidence-producing for a governed live run).
