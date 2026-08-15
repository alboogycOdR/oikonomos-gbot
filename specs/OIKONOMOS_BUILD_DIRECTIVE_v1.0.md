# OIKONOMOS Build Directive v1.0 — spec entry point for /devteam-decompose

> **Changelog:** v1.1 (2026-08-15, ORCH) — registered `docs/specs/OIKONOMOS_WBS_Addendum_B_v1.0.md` (OpenSandbox) as source document 4c. E5 is superseded in full, OIK-046 is retired, and OIK-076 / OIK-077 / OIK-121 are narrowed. See §1 and §2a. Applied at the user's mid-flight scope-change instruction; reconciliation path (a) — E5 had not been started.

> This is the single spec entry point for DEVDEPARTMENT planning. The substantive
> specifications live in `docs/architecture/` and `docs/decisions/` (canonical,
> single-copy — do not duplicate them into this folder). ORCH must read every
> source document listed in §1 end to end before decomposing. `Spec_References`
> in PLAN.md should cite the source documents' ticket IDs and section numbers
> (e.g. `WBS OIK-014`, `Build Handover §4.2`), with this directive cited only
> for the planning rules below (`Directive §2`, `§3`, …).

## §1 Source documents — read in this order; higher wins on conflict

1. `docs/decisions/ADR-001-broker-enforcement-point.md` — authoritative security contract
2. `docs/decisions/ADR-002-permission-bypass-ban-scope.md` — scope of the permission-bypass ban (product runtime vs. dev tooling)
3. `docs/architecture/OIKONOMOS_Master_Work_Breakdown_v1.0.md` — THE BACKLOG (epics E1–E13, tickets OIK-001..OIK-128)
4. `docs/architecture/OIKONOMOS_WBS_Addendum_A_v1.0.md` — Epic E14 (conversational delegation, initiative, observation learning, agent messaging, thread continuity). Extends the Master WBS; does not replace it. Its §3 ticket amendments apply (OIK-113, OIK-114, OIK-102, OIK-127 are modified).
4c. `docs/specs/OIKONOMOS_WBS_Addendum_B_v1.0.md` — **OpenSandbox. SUPERSEDES Epic E5 IN FULL.** Ranks with Addendum A, above the Build Handover Package. Its §2 replaces every original E5 ticket definition; **OIK-046 is RETIRED — never schedule it**; OIK-045a/b/c are new. Its §3–§4 narrow OIK-076, OIK-077 and OIK-121 (see §2a below). Its §5 adds risks R14–R16.
5. `docs/architecture/OIKONOMOS_Build_Handover_Package_v1.0.md` — repo scaffold §3, interface contracts §4, DoD §6. **Note:** its §3 scaffold lists `infra/images/` for a hand-rolled per-agent golden image — that is E5 work and is now superseded by Addendum B; do not scaffold it.
6. `docs/architecture/OIKONOMOS_Gap_Closure_Plan_v0.2.md` — gap closures, quality-bar rule §2
7. `docs/architecture/OIKONOMOS_Platform_Synthesis_Spec_v0.1.md` — DB schema §5.1 ONLY. Its §6 roadmap and §5.2 canUseTool wiring are SUPERSEDED by ADR-001 — ignore both.
8. `CLAUDE.md` — build-failing non-negotiables (top section, above the DEVDEPARTMENT appendix)

## §2 Planning rules

- The backlog is authoritative (Master WBS + Addendum A combined = full backlog). Do not invent, merge, or renumber tickets. IDs are stable. PLAN.md task IDs (TASK-NNN) map 1-to-1 or 1-to-many onto OIK tickets; every task's `Spec_References` names its OIK ticket(s).
- Apply Addendum A's ticket amendments: OIK-113 narrowed to agent-session recording only; OIK-114 depends on OIK-146 instead of OIK-113; OIK-102 extended by OIK-149; OIK-127 extended to cover Gaps A1–A5.
- E14 (Addendum A) is not schedulable ahead of E4 and E9. Draft-only E14 work (Tiers 0–2) may proceed before gate G-GOV; only initiative that acts and any Tier-3 path waits for the gate.
- Order work by the dependency graph (WBS §3) and the four gates (WBS §4). Gates are hard: a ticket behind a closed gate is not schedulable regardless of available capacity.
- Critical path is E1 → E2 → E3 → E4 (OIK-039 canary suite) → gate G-GOV. Optimise this first.
- Parallelise freely within a gate. E5, E7, and early E9 do not block on E3.
- Decompose OIK-062 (Wave 2 connectors) into one task per connector, and OIK-113 into one per recording stage, before scheduling either.
- OIK-046 and OIK-097 are evaluation spikes producing recommendations only. Do not adopt anything in those tickets.
- Sizes in the backlog are RELATIVE COMPLEXITY (S/M/L/XL), not durations. Do not convert to calendar dates or assume team capacity. Surface sequencing and readiness, not deadlines.

## §2a Addendum B reconciliation — binding at the next decompose

Recorded by ORCH 2026-08-15 after checking actual state. **Reconciliation path (a) applied: E5 had not been started** — no OIK-042…046 appeared in PLAN.md or REVIEW.md, no `infra/images/` existed, and `infra/compose/` contained only TASK-002's Postgres stack (data layer, not agent isolation). Nothing was discarded, salvaged, or migrated, because nothing existed.

1. **E5 is Addendum B §2, verbatim.** OIK-042 (OpenSandbox server, Tailscale-bound), OIK-043 (sandbox lifecycle in `harness-factory`), OIK-044 (isolation chaos test — **acceptance bar unchanged** from the original E5), OIK-045 (lifecycle policy), plus OIK-045a (Credential Vault), OIK-045b (per-role egress), OIK-045c (isolation strength per tier). The original "hand-roll per-agent Docker isolation" definitions are void.
2. **OIK-046 is retired.** Do not create a task for it under any wording. If a future decompose emits one, that is a defect in the decompose, not a scheduling choice.
3. **Sequencing (Addendum B §6):** put OIK-042/043 early, in parallel with E2, so E4's harness work lands *on* the isolated runtime instead of being retrofitted onto it. E3/E4 protected-path work should run inside a sandbox once OIK-043 lands.
4. **Narrowed tickets — none of these has been built or scheduled, so the narrowing applies cleanly at decompose time:**
   - **OIK-076** (browser capabilities → broker): now depends on OIK-045a and OIK-045b. Egress and credential controls are *inherited from the sandbox layer*; do not build a browser-specific version.
   - **OIK-077** (egress allowlist / SSRF): **narrowed, not removed.** Keeps the application-layer allowlist inside Steel's session config as defence in depth *alongside* OIK-045b's network-layer control. R15 exists precisely because dropping one layer once the other lands is the tempting mistake — both are required, and that requirement belongs in the acceptance criteria.
   - **OIK-121** (OpenBao): narrowed to **browser-session OAuth leasing only** (Steel/E8). General credential injection into agent sandboxes is OIK-045a's job.
5. **Protected-path note:** OIK-043 modifies `packages/harness-factory`, which is a protected path — it inherits the different-model adversarial review rule in §3 below, exactly like E3/E4 work.

## §3 Protected-path tickets — assignment constraint

Work touching `packages/broker/**`, `packages/policy/**`, `packages/approvals/**`, `packages/harness-factory/**`, `infra/ci/**`, `docs/decisions/**`, or any settings/subagent config requires adversarial review by a DIFFERENT model than the author (CLAUDE.md; WBS tickets OIK-031, OIK-041, OIK-104, OIK-126; Addendum tickets OIK-142, OIK-155). In DEVDEPARTMENT terms: assign these tasks to GB (Grok) or CX (Codex) so the opus-4-8 ORCH review satisfies the different-model rule — or, if built by S5, route the review through a non-Anthropic reviewer. Never let S5 build AND an Anthropic-only pass review the same protected-path task. Record the arrangement in the task's Description.

## §4 Execution rules (fail the build if violated — full text in CLAUDE.md)

Broker = PreToolUse hook (never canUseTool alone) · no `bypassPermissions`/`acceptEdits` in product paths per ADR-002 §1 · fail closed (unreachable/timeout >10s/malformed ⇒ deny) · no credentials in prompts, logs, audit payloads, or fixtures · Basileia-owned accounts only (`account_ownership: basileia`) · no CAPTCHA/MFA/bot-protection circumvention · ACL filter before vector similarity · approvals nonce-bound, single-use, one atomic SQL consume · all harness invocations via `packages/harness-factory` · canonical JSON + digest only in `packages/shared`.

## §5 Definition of Done

Per ticket: acceptance criteria demonstrated, tests written, strict types, Conventional Commit with ticket ID, docs updated on contract change. Per feature: Functional (real workflow end-to-end), Governed (every action through the broker), Evidenced (what data, what actions, what changed, what approved, how to stop/reverse), Evaluated (golden-task suite passing in CI).

## §6 Most important test in the project

OIK-039 / CAN-02: add a bare-name `allowedTools` entry for a Tier-3 tool and prove the broker STILL denies it. This is the regression test against the flaw the original architecture contained. Schedule it early; it is CI-blocking. CAN-03's grep implementation must follow ADR-002 §4 (includes the `--dangerously-skip-permissions` flag form; allowlist for dev-tooling paths).

## §7 Conflict handling

If two source documents disagree and no ADR covers it, HALT that task (`Status: blocked`, `Blocked_Reason: SPEC_AMBIGUITY`) and raise an ADR request to Alister. Do not choose between them.
