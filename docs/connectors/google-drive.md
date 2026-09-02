# google-drive — onboarding record

**Onboarded by:** ORCH · **Date:** 2026-09-02 · **G-CONN status: CLOSED** (Tier-3 not unlocked)
Manifest: `packages/connectors/manifests/google-drive.yaml` · Suite: `evals/golden/suites/google-drive/` · Task: TASK-050 (OIK-054)

## 1. Account (N5)
`account_ownership: basileia` — present, enforced by the same OIK-047 `z.literal` validator as every other connector. Target is the Basileia-owned Google Drive. No client, employer, or third-party Drive is in scope.

## 2. Scopes + justification

| Scope | Justification | Consuming capability |
|---|---|---|
| `drive.readonly` | List/search/read/download files for research and summarisation | `drive.list`, `drive.search`, `drive.read_metadata`, `drive.read_content`, `drive.download`, `drive.get_permissions` (all T0–T1) |
| `drive.file` | Backs create/update/copy/trash and the disabled share capability — scoped to files the app creates or opens, not full Drive | `drive.create_file`/`update_file`/`copy_file`/`trash_file` (T2_internal), `drive.share_file` (T3_external, `enabled: false`) |

No scope is present without a consuming capability. `drive.file` (rather than the broader `drive` scope) is the deliberate minimisation choice — it cannot reach files never created or explicitly opened by this connector, narrowing the mutation surface even before the capability-tier gate.

## 3. Tier map + T3 rationale

| Tool | Capability | Tier | Notes |
|---|---|---|---|
| `mcp__google-drive__list_recent_files` | `drive.list` | `T0_observe` | Read-only |
| `mcp__google-drive__search_files` | `drive.search` | `T0_observe` | Read-only |
| `mcp__google-drive__get_file_metadata` | `drive.read_metadata` | `T0_observe` | Read-only |
| `mcp__google-drive__read_file_content` | `drive.read_content` | `T0_observe` | Read-only |
| `mcp__google-drive__download_file_content` | `drive.download` | `T0_observe` | Read-only, no external effect (local to the run) |
| `mcp__google-drive__create_file` | `drive.create_file` | `T2_internal` | Mutation, but internal — no external party notified |
| `mcp__google-drive__update_file` | `drive.update_file` | `T2_internal` | Mutation, internal |
| `mcp__google-drive__copy_file` | `drive.copy_file` | `T2_internal` | Mutation, internal |
| `mcp__google-drive__trash_file` | `drive.trash_file` | `T2_internal` | Mutation, internal, reversible (Drive trash) |
| `mcp__google-drive__share_file` | `drive.share_file` | `T3_external` | **Externally-visible** — grants access to and notifies parties outside the account; the highest-risk capability in this manifest |
| `mcp__google-drive__get_file_permissions` | `drive.get_permissions` | `T1_draft` | **Read-only lookup**, deliberately distinguished from the *change* action (`share_file`) it sits next to — checking who has access is not itself a mutation |

Same ADR-010 note as Calendar's record: a T3 tier no longer implies an approval card by itself under Addendum F §5.3 — `share_file`'s `enabled: false` is the real gate, and it remains a candidate for a per-role Require Approval rule (§5.4) once roles exist, since no enforced-floor class (E1–E5) currently covers "grant external access to a file."

## 4. Disabled until G-CONN
`drive.share_file` ships `enabled: false`. Verified at review (TASK-050): registration lands it with `enabled = false` while all ten other capabilities land `enabled = true`, matching the manifest's authored tiers exactly.

## 5. Evals
Suite: `evals/golden/suites/google-drive/` — 5 golden tasks (`list-recent-files`, `search-budget-docs`, `read-file-content`, `create-draft-note`, `check-file-permissions`), spanning `T0_observe` through `T2_internal`/`T1_draft` — the first Wave-1 connector suite to exercise a mutation tier (`create-draft-note`, T2) rather than read-only tasks alone.

ORCH-verified 2026-09-02 in the review worktree via the OIK-051 runner:
- **Positive:** `pass_rate: 1` (5/5), `harness_invocations: 5`, exit 0 — ≥ `min_pass_rate: 0.90`.
- **Negative:** non-matching output ⇒ `pass_rate: 0`, `passed: false`, exit 1. Scoring confirmed live, not vacuous.

**Same caveat as Gmail/Calendar (§5):** assertions are substring `contains` checks — adequate as a wiring/regression gate, not evidence of model quality on their own.

## 6. Reversal
- **Deregistration:** `deregisterConnector("google-drive")` — same adapter-scoped deletion mechanism as every other connector (OIK-048).
- **Runtime kill:** capability kill switch (OIK-030) — `capabilities.enabled = false` denies immediately, no restart.
- **Scope revocation:** revoke the OAuth grant on the Basileia Google account.

## 7. Decision
Google Drive is **onboarded with read (T0) and internal-mutation (T2) capabilities live**; `drive.share_file` (T3) remains disabled.

**G-CONN for Drive is NOT open.** Opening it requires the same bar as Gmail/Calendar: a live OIK-049 enumeration run against the real MCP server with zero unmapped tools, strengthened discriminating eval assertions, deliberate scope review, live-run seams (real broker + real audit sink), Alister's explicit decision, and — per §3 — a decision on a per-role Require Approval rule for `share_file` specifically, since sharing a file externally has no dedicated enforced-floor class today.

---

**This closes TASK-047 (OIK-050 scope-minimisation checklist).** All three Wave-1 connectors — Gmail (TASK-048), Google Calendar (TASK-049), Google Drive (TASK-050) — now have onboarding records answering all seven checklist items, and every merged connector's `enabled: false` mutation-gate posture has been independently verified at review, not just asserted.
