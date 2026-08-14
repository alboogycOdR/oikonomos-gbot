# OIKONOMOS — DEVDepartment Handover Prompt

Paste the block below into DEVDepartment to generate the consolidated plan and begin execution.

---

```
PROJECT: OIKONOMOS — AI teammate control plane for Basileia Technologies.
Repository: basileia/oikonomos
Stack: TypeScript, Node 22, pnpm workspaces, PostgreSQL 16 + pgvector, Fastify, Vitest, Docker.

SOURCE DOCUMENTS — ingest in this order. Precedence is highest-first; where they conflict, the higher document wins:
  1. docs/decisions/ADR-001-broker-enforcement-point.md   — authoritative security contract
  2. docs/architecture/OIKONOMOS_Master_Work_Breakdown_v1.0.md — THE BACKLOG (epics E1-E13, tickets OIK-001..OIK-128)
  2b. docs/architecture/OIKONOMOS_WBS_Addendum_A_v1.0.md — Epic E14 (conversational
      delegation, initiative, observation learning, agent messaging, thread continuity).
      Extends the Master Work Breakdown; does not replace it. Ticket amendments in
      Addendum §3 apply (OIK-113, OIK-114, OIK-102, OIK-127 are modified).
  3. docs/architecture/OIKONOMOS_Build_Handover_Package_v1.0.md — repo scaffold §3, interface contracts §4, DoD §6
  4. docs/architecture/OIKONOMOS_Gap_Closure_Plan_v0.2.md — gap closures, quality-bar rule §2
  5. docs/architecture/OIKONOMOS_Platform_Synthesis_Spec_v0.1.md — DB schema §5.1 ONLY. Its §6 roadmap and §5.2 canUseTool wiring are SUPERSEDED — ignore both.
  6. CLAUDE.md — build-failing non-negotiables

YOUR TASK
Build a consolidated execution plan from the Master Work Breakdown, then execute it.

PLANNING RULES
- The backlog is authoritative (Master Work Breakdown + Addendum A combined = full backlog). Do not invent, merge, or renumber tickets. IDs are stable.
- Apply Addendum A's ticket amendments: OIK-113 is narrowed to agent-session recording only; OIK-114 now depends on OIK-146 instead of OIK-113; OIK-102 is extended by OIK-149; OIK-127 is extended to cover Gaps A1-A5.
- E14 (Addendum A) is not schedulable ahead of E4 and E9. Draft-only E14 work (Tiers 0-2) may proceed before gate G-GOV; only initiative that acts and any Tier-3 path waits for the gate.
- OIK-142 and OIK-155 (Addendum A) are protected-path tickets requiring adversarial review by a different model, same as E3/E4.
- Order work by the dependency graph (WBS §3) and the four gates (WBS §4). Gates are hard: a ticket behind a closed gate is not schedulable regardless of available capacity.
- Critical path is E1 -> E2 -> E3 -> E4 (OIK-039 canary suite) -> gate G-GOV. Optimise this first.
- Parallelise freely within a gate. E5, E7, and early E9 do not block on E3.
- Decompose OIK-062 (Wave 2 connectors) into one ticket per connector, and OIK-113 into one per recording stage, before scheduling either.
- OIK-046 and OIK-097 are evaluation spikes producing recommendations only. Do not adopt anything in those tickets.
- Sizes in the backlog are RELATIVE COMPLEXITY (S/M/L/XL), not durations. Do not convert them to calendar dates. Do not assume team capacity. Timeline and expectation management are owned by the product owner — surface sequencing and readiness, not deadlines.

EXECUTION RULES — these fail the build if violated
1. Broker enforcement is a PreToolUse hook. Never canUseTool alone; a single allow rule bypasses it. See ADR-001.
2. bypassPermissions and acceptEdits are banned platform-wide including subagents. CI greps for them.
3. Fail closed everywhere: broker unreachable, timeout >10s, or malformed response = deny.
4. No credentials in prompts, logs, audit payloads, or test fixtures.
5. Basileia-owned accounts only. Every connector manifest carries account_ownership: basileia. No client, employer, or third-party contract systems are in scope.
6. No circumvention of CAPTCHA, MFA, or bot protection. Steel Browser stealth features disabled; challenges trigger human takeover.
7. ACL filter before vector similarity, never after.
8. Approvals are nonce-bound and single-use; consumption is one atomic SQL statement.
9. All harness invocations go through packages/harness-factory. Direct query() calls elsewhere fail lint.
10. Canonical JSON + digest has exactly one implementation, in packages/shared.

DEFINITION OF DONE
Per ticket: acceptance criteria demonstrated, tests written, strict types, Conventional Commit with ticket ID, docs updated on contract change.
Per feature, all four must hold: Functional (real workflow end-to-end), Governed (every action through the broker), Evidenced (what data, what actions, what changed, what approved, how to stop/reverse), Evaluated (golden-task suite passing in CI).

ADVERSARIAL REVIEW — SCHEDULING CONSTRAINT
Protected paths (packages/broker, packages/policy, packages/approvals, packages/harness-factory, infra/ci, docs/decisions, all settings and subagent configs) require adversarial review by a DIFFERENT MODEL than the author — Codex CLI or Grok Build via AgentProvider. Self-review does not satisfy this. Allocate a second agent, not a second pass. Tickets OIK-031, OIK-041, OIK-104, OIK-126.

MOST IMPORTANT TEST IN THE PROJECT
OIK-039 / CAN-02: add a bare-name allowedTools entry for a Tier-3 tool and prove the broker STILL denies it. This is the regression test against the flaw the original architecture contained. Write it early; it is CI-blocking.

CONFLICT HANDLING
If two source documents disagree and no ADR covers it, HALT that ticket and raise an ADR. Do not choose between them.

START BY
Produce the consolidated plan: dependency-ordered work packages, gate mapping, parallelisation strategy, and the decomposition of OIK-062 and OIK-113. Present it for approval before executing any ticket.
```
