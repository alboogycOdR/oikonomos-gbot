# OIKONOMOS — Master Work Breakdown Structure

**Version:** 1.0
**Date:** 2026-08-13
**Owner:** Alister Witbooi, Basileia Technologies
**Purpose:** Complete, dependency-ordered work item inventory for ingestion by the DEVDepartment execution framework.
**Scope:** Full platform — Sprint 1 governance through parity review.

> **Sizing convention:** All sizes are **relative complexity** (S / M / L / XL), not durations. No calendar dates, no capacity assumptions, no sprint boundaries are specified in this document. Sequencing is expressed purely as **dependencies and gates**. Scheduling, calendar allocation, and expectation management are owned by the product owner and are explicitly out of scope for this document.
>
> **S** = single well-understood unit of work · **M** = multi-file, needs design thought · **L** = subsystem, multiple integration points · **XL** = decompose further before starting.

---

## 1. How DEVDepartment should consume this document

1. **Ingest the ticket table (§5) as the backlog.** Each row is atomic and has explicit `Depends on` and `Acceptance` fields. IDs are stable — never renumber.
2. **Respect the four gates (§4).** Gates are hard. A ticket behind a closed gate must not be scheduled, regardless of available capacity. This is the only ordering constraint that cannot be optimised away.
3. **Parallelise freely within a gate.** The dependency graph (§3) is the authority on what can run concurrently. Tracks A (governance) and B (capability) are designed to run in parallel.
4. **Every ticket must satisfy the Definition of Done (§6)** before closure, plus its own acceptance criteria.
5. **Protected-path tickets require adversarial review by a different model than the author** (§6.3). This is a scheduling constraint: allocate a second agent/model, not a second pass by the same one.
6. **Any material conflict between documents that no ADR covers halts the ticket** and is escalated to ORCH, who resolves it by updating the lower-precedence document or recording an ADR when durable rationale is needed (see precedence, §2.3; CLAUDE.md "Document precedence", amended 2026-09-01). Non-conflicting feature extension does not require an ADR.

---

## 2. Ground rules

### 2.1 Non-negotiables (build-failing, apply to every ticket)

| ID | Rule |
|---|---|
| **N1** | Broker enforcement is a `PreToolUse` hook. Never `canUseTool` alone — it is bypassable by a single allow rule (ADR-001). |
| **N2** | `bypassPermissions` and `acceptEdits` are banned platform-wide, including all subagents. CI greps for them. |
| **N3** | Fail closed everywhere. Broker unreachable, timeout, or malformed response ⇒ deny. |
| **N4** | No credentials in prompts, logs, audit payloads, or test fixtures. |
| **N5** | Scope boundary: Basileia-owned accounts only. Every connector manifest carries `account_ownership: basileia`. |
| **N6** | No circumvention of CAPTCHA, MFA, or bot protection. Steel stealth features disabled; challenges trigger human takeover. |
| **N7** | ACL filter before vector similarity, never after. |
| **N8** | Approvals are nonce-bound and single-use; consumption is one atomic SQL statement. |
| **N9** | All harness invocations go through `packages/harness-factory`. Direct `query()` calls elsewhere fail lint. |
| **N10** | Canonical JSON + digest has exactly one implementation, in `packages/shared`. |

### 2.2 Quality bar — a feature is MET only when all four hold

1. **Functional** — a real workflow completes end-to-end, not a demo path.
2. **Governed** — every action through the broker; Tier-3+ requires bound approval; denials audited.
3. **Evidenced** — the run answers: what data, what actions, what changed, what was approved, how to stop/reverse.
4. **Evaluated** — golden-task suite passes at the stated rate, and runs in CI thereafter.

### 2.3 Document precedence

ADRs > Build Handover Package v1.0 > Gap Closure Plan v0.2 > Synthesis Spec v0.1 > research document.
Superseded: Synthesis Spec §6 (5-phase roadmap) and §5.2 (`canUseTool` wiring).

---

## 3. Epic map and dependency graph

| Epic | Name | Track | Gate | Depends on |
|---|---|---|---|---|
| **E1** | Foundation & CI | A | — | — |
| **E2** | Data layer | A | — | E1 |
| **E3** | Governance core (broker, policy, approvals, audit) | A | **G-GOV** | E1, E2 |
| **E4** | Agent runtime & harness | A | **G-GOV** | E3 |
| **E5** | Agent isolation | A | — | E1 |
| **E6** | Connector pipeline & Wave 1–2 | B | **G-CONN** per connector | E3, E4 |
| **E7** | Memory & learning | B | — | E2, E4 |
| **E8** | Browser workspace | B | **G-BROWSER** | E3, E5 |
| **E9** | Surfaces (Telegram, web, mobile) | B | — | E3 |
| **E10** | Organizational Memory Exchange & multi-agent | B | — | E7, E4 |
| **E11** | Routines, scheduling & budgets | B | — | E3, E4 |
| **E12** | Observability, ops & runbooks | A | — | E2, E3 |
| **E13** | Evals & parity verification | A/B | **G-PARITY** | all |

```
E1 ──┬── E2 ──┬── E3 ──┬── E4 ──┬── E6 ──┐
     │        │        │        │        │
     └── E5 ──┼────────┼── E8 ──┤        ├── E13
              │        │        │        │
              ├── E12  ├── E9   ├── E7 ──┴── E10
              │        │        │
              │        └── E11 ─┘
```

---

## 4. Gates

| Gate | Name | Opens when | Blocks |
|---|---|---|---|
| **G-GOV** | Governance exit | CAN-01…CAN-08 green in CI · zero banned modes in repo · Fable findings closed on broker/policy/approvals · isolation chaos test passing | **All Tier-3 (external-impact) actions, platform-wide.** Until open, every capability runs draft-only (Tier 0–2). Non-executing work (manifests authored, evals written, Steel deployed but unregistered) may proceed. |
| **G-CONN** | Per-connector unlock | That connector's manifest reviewed, scopes minimised, tiers mapped, golden evals ≥90% | Tier-3 for that connector only. Applied individually, not in bulk. |
| **G-BROWSER** | Browser workspace unlock | Stealth-disabled config test passing · egress allowlist enforced · human takeover verified · 10-run streak with trace evidence | Scheduled browser routines |
| **G-PARITY** | Parity review | All epics' quality bars MET · full-platform Fable pass complete | Declaring parity |

---

## 5. Ticket backlog

### E1 — Foundation & CI

| ID | Title | Size | Depends on | Acceptance |
|---|---|---|---|---|
| OIK-001 | Monorepo scaffold (pnpm workspaces, Node 22, TS strict) | S | — | All packages build; typecheck clean; workspace graph resolves |
| OIK-002 | CI pipeline skeleton (lint, typecheck, test, build) | S | OIK-001 | Runs on every PR; fails on any red job |
| OIK-003 | CLAUDE.md + CODEOWNERS + protected-path enforcement | S | OIK-001 | Protected-path PR without review is blocked by CI |
| OIK-004 | Banned-mode grep job (N2) | S | OIK-002 | Build fails on any `bypassPermissions` / `acceptEdits` occurrence, incl. subagent configs |
| OIK-005 | Lint rule: no direct `query()` outside harness-factory (N9) | S | OIK-001 | Violating file fails lint with actionable message |
| OIK-006 | Lint rule: `packages/policy` has zero I/O imports | S | OIK-001 | Any fs/net/db import in policy fails lint |
| OIK-007 | Secret-scanning in CI (pre-commit + pipeline) | S | OIK-002 | Known secret patterns block merge; test fixture with fake key is caught |
| OIK-008 | License-compliance scan (flag AGPL components) | S | OIK-002 | Report lists every AGPL dep; build warns, does not fail |
| OIK-009 | ADR framework + ADR-001 committed | S | OIK-001 | ADR template exists; ADR-001 in `docs/decisions/` |
| OIK-010 | Monthly SDK-drift watch job | S | OIK-009 | Scheduled job diffs Agent SDK permissions docs; opens ticket on change |

### E2 — Data layer

| ID | Title | Size | Depends on | Acceptance |
|---|---|---|---|---|
| OIK-011 | PostgreSQL 16 + pgvector deployment, Tailscale-bound | M | OIK-001 | Connection refused from non-Tailscale interface; pgvector extension live |
| OIK-012 | Migration runner + schema v1 (Synthesis Spec §5.1) | M | OIK-011 | All tables/enums/indexes created; migration is idempotent and reversible |
| OIK-013 | Append-only enforcement on `audit_events` | S | OIK-012 | UPDATE and DELETE are provable no-ops in test |
| OIK-014 | Typed query layer + connection pooling (pgbouncer) | M | OIK-012 | No raw SQL outside `packages/db`; pool limits configured |
| OIK-015 | Backup + restore procedure (Postgres + evidence volume) | M | OIK-011 | Restore-from-backup drill succeeds into a clean environment |
| OIK-016 | Seed data: capabilities + role_grants for `inbox-triage` | S | OIK-012 | Seed script idempotent; tiers match connector manifests |

### E3 — Governance core ⚑ protected

| ID | Title | Size | Depends on | Acceptance |
|---|---|---|---|---|
| OIK-017 | `packages/shared`: canonical JSON (N10) | M | OIK-001 | Property tests: key order, unicode, number forms, nesting all stable; no collisions in fixture set |
| OIK-018 | `packages/shared`: sha256 action digest | S | OIK-017 | Digest reproducible across processes; documented byte-level spec |
| OIK-019 | `packages/policy`: risk-tier resolution (pure functions) | L | OIK-016, OIK-006 | 100% branch coverage; more-restrictive-wins verified; unregistered capability ⇒ deny |
| OIK-020 | `packages/policy`: role constraints (rate limits, domains) | M | OIK-019 | Rate limit and domain constraint each independently enforced and tested |
| OIK-021 | `packages/approvals`: issue + bind | M | OIK-018, OIK-014 | Approval row carries digest, render, destination, nonce, expiry; persisted before agent is told to wait |
| OIK-022 | `packages/approvals`: verify + atomic consume (N8) | L | OIK-021 | Concurrent consume attempts ⇒ exactly one success (DB-level test); expiry honoured |
| OIK-023 | `packages/approvals`: invalidation on payload mutation | M | OIK-022 | Digest mismatch ⇒ status `invalidated`, new approval required |
| OIK-024 | `packages/approvals`: expiry sweeper job | S | OIK-022 | Expired pending approvals transition to `expired`; runs idempotently |
| OIK-025 | `packages/audit`: append-only writer | M | OIK-013 | Every decision written incl. denials; write failure fails the action closed |
| OIK-026 | `packages/audit`: redaction middleware (N4) | M | OIK-025 | Secret patterns stripped pre-write; unit-tested against fixture corpus |
| OIK-027 | `packages/broker`: PreToolUse endpoint (Handover §4.1) | L | OIK-019, OIK-022, OIK-025 | All three response shapes; contract matches §4.1 exactly |
| OIK-028 | `packages/broker`: idempotency per `toolUseId` | M | OIK-027 | L1 and L3 for same call ⇒ one audit event, one decision |
| OIK-029 | `packages/broker`: fail-closed behaviour (N3) | M | OIK-027 | Timeout >10s, 500, malformed body each ⇒ deny + audit |
| OIK-030 | `packages/broker`: capability kill switch | S | OIK-027 | `capabilities.enabled=false` denies immediately, no restart required |
| OIK-031 | Fable adversarial review — broker, policy, approvals | M | OIK-027…030 | Findings documented and closed; reviewer model ≠ author model |

### E4 — Agent runtime & harness ⚑ protected

| ID | Title | Size | Depends on | Acceptance |
|---|---|---|---|---|
| OIK-032 | Extract `packages/agent-providers` from telegram bot | M | OIK-001 | All 88 existing Vitest tests still green post-extraction |
| OIK-033 | `packages/harness-factory`: sole harness constructor (N9) | L | OIK-032, OIK-027 | Configures L1 hook + L2 `dontAsk` + allowedTools + L3 callback; no other construction path exists |
| OIK-034 | L1: PreToolUse hook adapter → broker | L | OIK-033 | Every tool call reaches broker; deny maps to hook deny with message |
| OIK-035 | L3: `canUseTool` secondary adapter → broker | M | OIK-033 | Idempotent with L1; catches AskUserQuestion / requiresUserInteraction class |
| OIK-036 | L2: `dontAsk` mode + scoped allowedTools policy (R1) | M | OIK-033 | Bare-name entries rejected by config validator unless ADR-approved |
| OIK-037 | PostToolUse hook: completion evidence (R4) | M | OIK-034 | Result digest + artifact URIs written to audit |
| OIK-038 | Run lifecycle: start, resume, fail, cancel | L | OIK-014, OIK-033 | `session_ref` persisted; resume after process kill returns to correct state |
| OIK-039 | **Canary suite CAN-01…CAN-08, CI-blocking** | L | OIK-034…037, OIK-022 | All eight pass; **CAN-02 proves bare-name allowedTools does not bypass L1** |
| OIK-040 | Subagent policy enforcement (CAN-05) | M | OIK-039 | Subagent Tier-3 attempt denied; audit attributes the subagent |
| OIK-041 | Fable adversarial review — harness-factory + hooks | M | OIK-039 | Findings closed; reviewer model ≠ author model |

### E5 — Agent isolation ⛔ SUPERSEDED IN FULL by `docs/specs/OIKONOMOS_WBS_Addendum_B_v1.0.md` §2 (OpenSandbox, 2026-08-15)

> **Do not schedule from this table.** Every row below is void: isolation is now ADOPT-OpenSandbox, not build-your-own-Docker. OIK-046 is **retired**, not deferred. The replacement tickets (OIK-042…045 rewritten, plus new OIK-045a/b/c) live in Addendum B §2. The rows are retained only so the superseded definitions remain auditable.

| ID | Title | Size | Depends on | Acceptance |
|---|---|---|---|---|
| OIK-042 | Per-agent Docker workspace image (golden image) | M | OIK-001 | Rebuild from image reproducible; profile volume survives rebuild |
| OIK-043 | Per-agent volumes, network namespace, CPU/RAM quotas | L | OIK-042 | Two agents run with fully separate FS and network views |
| OIK-044 | Isolation chaos test (CI) | M | OIK-043 | Agent A disk-fill, crash, and runaway loop each provably cannot affect Agent B |
| OIK-045 | Workspace lifecycle: create, pause, destroy, reap | M | OIK-043 | Orphaned workspaces reaped; no volume leak over 100 cycles |
| OIK-046 | Hibernating-workspace evaluation spike (Daytona vs E2B) | M | OIK-045 | Written recommendation with cost model; **decision deferred to fleet gate — do not adopt in this ticket** |

### E6 — Connector pipeline & waves

| ID | Title | Size | Depends on | Acceptance |
|---|---|---|---|---|
| OIK-047 | Connector manifest schema + validator (N5) | M | OIK-016 | `account_ownership: basileia` required; invalid manifest rejected in CI |
| OIK-048 | MCP server registration pipeline | L | OIK-047, OIK-033 | Manifest → capabilities rows → role_grants, idempotent and reversible |
| OIK-049 | Tool enumeration + capability auto-mapping | M | OIK-048 | Every MCP tool mapped to a capability with an explicit tier; unmapped ⇒ deny |
| OIK-050 | Scope-minimisation review checklist + record | S | OIK-047 | Every connector has a written scope justification in `docs/connectors/` |
| OIK-051 | Golden-eval harness for connectors | L | OIK-048 | Suite runnable per connector; pass-rate reported; wired into CI |
| OIK-052 | Wave 1 — Gmail (readonly + compose, no send until G-CONN) | M | OIK-051 | Evals ≥90%; send capability present but `enabled: false` |
| OIK-053 | Wave 1 — Google Calendar | M | OIK-051 | Evals ≥90% |
| OIK-054 | Wave 1 — Google Drive | M | OIK-051 | Evals ≥90% |
| OIK-055 | Wave 1 — Google Docs | M | OIK-051 | Evals ≥90% |
| OIK-056 | Wave 1 — Google Sheets | M | OIK-051 | Evals ≥90% |
| OIK-057 | Wave 1 — Slack (Basileia workspace) | M | OIK-051 | Evals ≥90% |
| OIK-058 | Wave 1 — GitHub | M | OIK-051 | Evals ≥90% |
| OIK-059 | Wave 1 — Notion | M | OIK-051 | Evals ≥90% |
| OIK-060 | Wave 1 — Jira | M | OIK-051 | Evals ≥90% |
| OIK-061 | Wave 1 — Telegram (formalise existing) | S | OIK-051 | Existing bot surface registered as a governed capability |
| OIK-062 | Wave 2 — remaining priority-25 (Confluence, Linear, M365 Basileia tenant, Google Tasks, draw.io via Drive, Firebase/Firestore, api.bible, YouTube Data, Xero/Sage, Canva/Figma) | XL — **decompose one ticket per connector** | OIK-052…061 | Each: manifest, scopes, tiers, evals ≥90%, onboarding record |
| OIK-063 | Read-only trading connectors (VALR, Binance) with hard tier caps | M | OIK-051 | No write/trade capability exists at any tier; verified by negative test |
| OIK-064 | MT5 relay registered as `mcp:mt5` wrapper | M | OIK-051 | Existing Flask bridge governed; decision-support only, no order execution |

### E7 — Memory & learning

| ID | Title | Size | Depends on | Acceptance |
|---|---|---|---|---|
| OIK-065 | `packages/memory`: profile_facts CRUD + provenance | M | OIK-014 | Every fact carries source, confidence, expiry; user-editable and deletable |
| OIK-066 | Embedding + retrieval with ACL pre-filter (N7) | L | OIK-065 | Query-shape test proves ACL filter precedes similarity, never after |
| OIK-067 | Honcho integration (user/dialectic modelling) | L | OIK-066 | Runs against pgvector store; AGPL flagged in license scan |
| OIK-068 | Memory A/B eval harness | M | OIK-066 | Measurable difference in draft quality vs no-memory baseline |
| OIK-069 | Fact correction flow (false fact corrected, correction sticks) | M | OIK-065 | Corrected fact supersedes; old version retained with linkage |
| OIK-070 | Claude Code skills: initial Basileia skill set | M | OIK-033 | Skills for doc conventions, spec/ADR format, triage rubric, connector onboarding record |
| OIK-071 | Post-task skill proposal (Hermes pattern) | L | OIK-070 | Agent drafts skill after complex run; human review required before versioning |
| OIK-072 | Skill versioning + review workflow in Git | M | OIK-071 | No skill enters use without review commit |
| OIK-073 | Consolidation job (integrate existing dream-setup.md pipeline) | M | OIK-065 | Scope guard, secrets redaction, report rotation preserved |

### E8 — Browser workspace

| ID | Title | Size | Depends on | Acceptance |
|---|---|---|---|---|
| OIK-074 | Steel Browser self-hosted deployment (Tailscale-bound) | M | OIK-043 | Reachable only over Tailscale; sessions persist across restarts |
| OIK-075 | **Stealth/anti-detection disabled — config assertion test (N6)** | S | OIK-074 | Test fails build if any stealth or CAPTCHA-solving feature is enabled |
| OIK-076 | Browser capabilities registered with broker | M | OIK-074, OIK-048 | Every browser action (navigate, click, type, extract) is a tiered capability |
| OIK-077 | Egress allowlist per routine (block RFC1918 + metadata endpoints) | L | OIK-076 | Off-allowlist request blocked and audited; SSRF negative test passes |
| OIK-078 | Human takeover via live session viewer | M | OIK-074 | Operator takes control mid-run; handback resumes cleanly |
| OIK-079 | MFA/CAPTCHA challenge → takeover handoff (N6) | M | OIK-078 | Challenge detected ⇒ run parks and notifies; never auto-solved |
| OIK-080 | Trace + screenshot evidence capture to store | M | OIK-076 | Every browser run produces retrievable trace; encrypted at rest |
| OIK-081 | "Connect account" human sign-in flow | M | OIK-078 | Human authenticates; session persists; credentials never enter model context |
| OIK-082 | First browser-only routine, 10-run streak (G-BROWSER) | L | OIK-077…081 | 10 consecutive scheduled runs, trace evidence, zero policy violations |
| OIK-083 | Computer-use lane for desktop apps (broker-gated) | L | OIK-076 | Screenshot→action loop governed identically to browser capabilities |

### E9 — Surfaces

| ID | Title | Size | Depends on | Acceptance |
|---|---|---|---|---|
| OIK-084 | `services/control-api` (Fastify): tasks, runs, approvals, evidence | L | OIK-014, OIK-027 | OpenAPI spec published; all surfaces consume this, not the DB |
| OIK-085 | Telegram: task intake + run status commands | M | OIK-084 | `/task`, `/runs`, `/approvals` functional |
| OIK-086 | Telegram: approval inline-keyboard flow | L | OIK-084, OIK-022 | Approve/Edit/Reject; edit invalidates prior approval and re-enters cycle |
| OIK-087 | Telegram: evidence delivery | M | OIK-080, OIK-084 | Screenshots/diffs delivered with the approval request |
| OIK-088 | Web dashboard: run list, run detail, live status | L | OIK-084 | Real-time run view; no direct DB access |
| OIK-089 | Web dashboard: approval inbox | L | OIK-088 | Same nonce-binding as Telegram; one approval service, many surfaces |
| OIK-090 | Web dashboard: evidence gallery + audit browser | M | OIK-088 | Any run reconstructible from UI alone |
| OIK-091 | PWA packaging | S | OIK-088 | Installable; offline shell |
| OIK-092 | Flutter mobile: approval inbox + FCM push | L | OIK-084 | Push-to-approval round trip under 30s |
| OIK-093 | Flutter mobile: task intake + run status | M | OIK-092 | Feature parity with Telegram intake |
| OIK-094 | Flutter mobile: live workspace view (Steel viewer via WebView) | M | OIK-078, OIK-092 | Watch agent work; takeover on tap |
| OIK-095 | Flutter mobile: evidence gallery | M | OIK-092 | Evidence viewable on device |
| OIK-096 | Cross-surface nonce parity test | M | OIK-086, OIK-089, OIK-092 | Identical binding semantics proven across all three surfaces |
| OIK-097 | Tauri desktop shell go/no-go spike | S | OIK-091 | Written recommendation; no adoption in this ticket |

### E10 — Organizational Memory Exchange & multi-agent

| ID | Title | Size | Depends on | Acceptance |
|---|---|---|---|---|
| OIK-098 | `org_facts` schema + migration | M | OIK-012 | Versioning, `superseded_by`, ACL array, provenance all present |
| OIK-099 | OME publish API (explicit publish only) | M | OIK-098 | No ambient transcript sharing possible; publish is an audited event |
| OIK-100 | OME read API with ACL enforcement | L | OIK-099, OIK-066 | **Negative test:** agent cannot read facts outside its ACL scope |
| OIK-101 | Fact versioning + conflict resolution | M | OIK-099 | Conflicting fact creates new version; "why do you believe this, since when" answerable |
| OIK-102 | Typed handoff objects over pg-boss | L | OIK-038 | `research.complete`, `draft.ready_for_review` carry fact references, not payload copies |
| OIK-103 | Two-role handoff end-to-end (research → drafting) | L | OIK-100, OIK-102 | Completes without privilege expansion; proven by negative test |
| OIK-104 | Fable adversarial review — OME ACL model | M | OIK-103 | Findings closed; reviewer model ≠ author model |

### E11 — Routines, scheduling & budgets

| ID | Title | Size | Depends on | Acceptance |
|---|---|---|---|---|
| OIK-105 | pg-boss integration + job definitions | M | OIK-014 | Retries, singleton jobs, archival configured |
| OIK-106 | Durable resume: kill worker mid-run | L | OIK-105, OIK-038 | Run resumes correctly from persisted state |
| OIK-107 | Durable resume: kill worker mid-approval-wait | L | OIK-106, OIK-022 | Resumes into `waiting_approval`, never re-executes |
| OIK-108 | Routine specification format (versioned YAML in Git) | M | OIK-105 | Inputs, preconditions, steps, assertions, allowed domains, tier policy |
| OIK-109 | Routine scheduling (cron + NL description) | M | OIK-108 | Schedule stored structurally; delivery target is a platform address |
| OIK-110 | Per-routine token/cost budgets via FreeLLMAPI routing | L | OIK-105 | Routine halts itself on budget breach; audited |
| OIK-111 | Platform-wide spend ceiling enforcement | M | OIK-110 | Hard ceiling honoured; Tier-0 work routed to cheap models |
| OIK-112 | Kill-switch drill (documented + rehearsed) | S | OIK-030 | Operator stops all runs within one command; drill recorded in runbook |
| OIK-113 | Browser routine recording → routine spec | XL — decompose | OIK-082, OIK-108 | Steel trace + codegen → spec → human review → versioned, evaluated |
| OIK-114 | Non-engineer routine creation test | M | OIK-113 | A non-engineer converts a demonstrated workflow into a reviewed scheduled routine unaided |

### E12 — Observability, ops & runbooks

| ID | Title | Size | Depends on | Acceptance |
|---|---|---|---|---|
| OIK-115 | Structured JSON logging across services | M | OIK-025 | Correlation by `run_id` and `toolUseId`; no secrets |
| OIK-116 | OpenTelemetry traces + Grafana dashboards | L | OIK-115 | Run latency, tool decisions, approval wait times visible |
| OIK-117 | Alerting: broker unreachable, approval backlog, budget breach | M | OIK-116 | Alerts delivered to Telegram; tested by fault injection |
| OIK-118 | Evidence retention policy + encrypted volume | M | OIK-080 | Retention field per artifact; expiry job enforces |
| OIK-119 | Environment definitions: local / dev / prod | M | OIK-011 | Prod = real accounts, Tailscale-only; dev = sandbox accounts, Tier-3 permanently disabled |
| OIK-120 | Secrets: age + systemd credentials | M | OIK-119 | No secret in repo, prompt, log, or fixture; rotation documented |
| OIK-121 | OpenBao adoption (session keys, OAuth leases) | L | OIK-081, OIK-120 | Leasing and revocation exercised; migration from age documented |
| OIK-122 | Runbooks: incident, restore, kill-switch, connector onboarding | M | OIK-112, OIK-015 | Each rehearsed at least once and recorded |
| OIK-123 | POPIA posture review | M | OIK-118 | Data inventory, retention, subject-rights path documented |

### E13 — Evals & parity verification

| ID | Title | Size | Depends on | Acceptance |
|---|---|---|---|---|
| OIK-124 | Platform eval suite (golden tasks across capabilities) | L | OIK-051 | Runs in CI; scorecard published per run |
| OIK-125 | `inbox-triage` role: 10 consecutive real sessions | L | OIK-052, OIK-086 | Zero unsanctioned sends; every action reconstructible from audit + evidence |
| OIK-126 | Full-platform Fable adversarial pass | L | all epics | Findings closed or explicitly accepted with rationale |
| OIK-127 | Parity review vs Gap Closure Plan §8 scorecard | M | OIK-126 | Every row MET per its quality bar, or explicitly re-scoped with reason |
| OIK-128 | Threat model document (prompt injection, escalation, exfiltration) | M | OIK-126 | Each threat mapped to a control and a test |

---

## 6. Definition of Done

### 6.1 Every ticket
- Acceptance criteria met and demonstrated
- Unit tests for new branches; integration test where a contract crosses a package boundary
- No `any` in protected packages; strict types
- No secrets in code, logs, or fixtures
- Conventional Commit with ticket ID
- Docs updated if a contract changed; ADR raised if a decision conflicts with an existing document

### 6.2 Every feature (the four-part bar, §2.2)
Functional · Governed · Evidenced · Evaluated. All four, or it is not done.

### 6.3 Protected-path tickets (E3, E4, plus OIK-100, OIK-104)
Adversarial ("Fable") review by a **different model than the author** — Codex CLI or Grok Build via AgentProvider. Self-review does not satisfy this. Findings closed before merge.

---

## 7. Risk register

| ID | Risk | Control | Ticket |
|---|---|---|---|
| R1 | Agent SDK permission pipeline changes upstream, invalidating ADR-001 | Monthly drift watch; canary suite fails loudly | OIK-010, OIK-039 |
| R2 | Unmetered inference spend | Per-routine budgets + platform ceiling + cheap-model routing for Tier-0 | OIK-110, OIK-111 |
| R3 | Connector scope creep beyond Basileia-owned accounts | `account_ownership` required field + onboarding review | OIK-047, OIK-050 |
| R4 | Prompt injection escalating privileges | Authorization lives in Postgres, not context; broker ignores model-originated approval claims | OIK-027, OIK-128 |
| R5 | Evidence artifacts leak sensitive data | Encrypted volume, retention policy, redaction | OIK-118, OIK-026 |
| R6 | Solo-developer self-review blind spot | Different-model adversarial review mandated on protected paths | OIK-031, OIK-041, OIK-104, OIK-126 |
| R7 | AGPL components constrain future commercial distribution | License scan + flagged inventory; decision deferred, not ignored | OIK-008 |
| R8 | pg-boss outgrows workflow complexity | Temporal adoption gate reviewed at OIK-113 | OIK-105 |
| R9 | JIT capability grants compound into effective privilege escalation | Ceiling cannot be exceeded by accumulation; negative test | OIK-133 |
| R10 | Agent initiative consumes budget unattended | Initiative draws on the same ceilings; platform-wide kill switch | OIK-140, OIK-141 |
| R11 | Agent-to-agent messaging amplifies prompt injection | Messages request, never authorize; containment test | OIK-149, OIK-154 |
| R12 | Observation mode captures credentials or personal data | Auto-pause on credential fields; redaction; shorter retention | OIK-144, OIK-148 |
| R13 | Orchestrator accrues union of subordinate privileges | Orchestrator ceiling is independent, not derived | OIK-151 |
| R14 | OpenSandbox is a young, fast-moving project — API or config surface may shift | Pin a specific release; extend the monthly SDK-drift watch (OIK-010) to cover OpenSandbox release notes, not just the Agent SDK | OIK-042 |
| R15 | Sandbox-layer egress/credential controls create a false sense of complete coverage if the application-layer checks are dropped | OIK-045b and OIK-077 are **both** required — defence in depth is explicit in acceptance criteria, not optional | OIK-045b, OIK-077 |
| R16 | Kubernetes backend (fleet-scale path) is materially more operational surface than Docker | Do not adopt the Kubernetes backend until a real multi-tenant or high-concurrency trigger exists — the Docker backend is sufficient at current scale | OIK-042 |

> **Changelog:** v1.0+ (2026-08-15, ORCH) — R9–R13 folded in from Addendum A §4, R14–R16 from Addendum B §5, so this table is the single tracked register rather than three tables in three documents. Ticket definitions themselves are unchanged here; E5's rows in §5 above are **superseded in full by Addendum B §2** (and OIK-046 is retired) — read that document, not §5 E5, when scheduling isolation work.

---

## 8. Scheduling guidance for DEVDepartment

- **Critical path:** E1 → E2 → E3 → E4 (OIK-039 canaries) → **G-GOV**. Everything downstream of a Tier-3 action waits on this. Optimise this path first.
- **Genuinely parallel, no cross-dependency:** E5 (isolation) runs alongside E3. E7 (memory) and E9 (surfaces up to OIK-085) need only E2/E4. E6 manifest and eval authoring (OIK-047, OIK-050, OIK-051) can complete entirely before G-GOV opens — only Tier-3 *enablement* is gated.
- **Decompose before scheduling:** OIK-062 (Wave 2 connectors) and OIK-113 (routine recording) are XL. Split one ticket per connector and one per recording stage.
- **Do not schedule adoption spikes as adoption:** OIK-046 (Daytona/E2B) and OIK-097 (Tauri) produce recommendations only. Adoption requires a new ticket and an ADR.
- **Gate discipline over throughput:** if capacity is idle behind a closed gate, pull non-executing work forward (manifests, evals, docs, runbooks) rather than opening the gate early. A bypassable broker early is a compromised platform late.
- **Estimates in this document are relative complexity only.** Calendar allocation, sequencing across time, and expectation management are owned by the product owner.
