# OIKONOMOS — Work Breakdown Addendum A

**Version:** 1.0 · **Date:** 2026-08-13
**Extends:** OIKONOMOS_Master_Work_Breakdown_v1.0.md
**Trigger:** Review of the official Grok Bot announcement (x.ai/news/introducing-grok-bot, 11 Aug 2026) against the WBS.
**Finding:** The WBS covers Grok Bot's *capabilities* well and its *interaction model* poorly. Five gaps identified. This addendum adds Epic E14 and extends E9, E10, and E11.

> Sizing is relative complexity (S/M/L/XL). No durations, no calendar, no capacity assumptions.

---

## 1. What the official announcement changed

| Source claim | WBS status before | Assessment |
|---|---|---|
| "Other AI tools may ask you to set up and build workflows and routines first. With Grok Bot, simply message a Bot to take on a task." | **Not covered.** WBS is role- and routine-centric throughout. | **Gap A1.** This is positioned directly against architectures like ours. Setup burden is the product's chosen battleground. |
| Bots independently message each other, share context in threads, and can be placed in a group chat where they coordinate, pass work, and assign ownership. | **Partial.** E10 covers typed handoffs and OME facts — mechanical transfer, not conversation or self-organisation. | **Gap A2.** No agent-to-agent messaging, no group coordination, no chief-of-staff orchestrator. |
| A Bot learns by being asked to follow along while you do a job; it watches the steps and saves the workflow as a routine. | **Partial.** OIK-113 records the *agent's* own browser session. | **Gap A3.** Watching the *human* work is a different mechanism and a far better onboarding experience. |
| Bots follow up on dropped threads, nudge stalled handoffs, and become proactive — picking up work before being asked. | **Not covered.** Everything in the WBS is task- or schedule-triggered. | **Gap A4.** No agent-initiated work exists in the design. |
| Message a Bot from phone or desktop and pick up the same thread later on either surface. | **Partial.** Three surfaces exist (E9); no shared thread across them. | **Gap A5.** |
| "Bots **share** a computer of their own in the cloud." | Per-agent Docker isolation (OIK-042–044). | **Not a gap — OIKONOMOS is stronger.** The reference product shares one environment across Bots; ours isolates per agent with a chaos test. Update the parity scorecard to MET+ and say so in positioning. |

**Design consequence:** OIKONOMOS's governance advantage is real, but a platform that demands role definitions, manifests, and routine specs before it does anything useful loses to one you can simply message. **The governance must be invisible at the point of delegation and visible at the point of consequence.** Every ticket below is subordinate to that principle — and none of them relax the §2.1 non-negotiables or the gates.

---

## 2. New Epic — E14: Conversational delegation & initiative

| Epic | Track | Gate | Depends on |
|---|---|---|---|
| **E14** | B | G-GOV for any Tier-3 action; no gate for draft-only | E4, E9, E11 |

### E14.1 — Zero-setup delegation (Gap A1)

| ID | Title | Size | Depends on | Acceptance |
|---|---|---|---|---|
| OIK-129 | Free-text task intake — no role or routine required | L | OIK-084, OIK-038 | A plain message ("sort out the Play Console listing for the church app") creates a task and starts a run. No manifest, role definition, or routine authored by the user first. |
| OIK-130 | Implicit role resolution from task intent | L | OIK-129, OIK-019 | Task text resolves to an existing role, or to a **default general role** with a conservative tier ceiling. Resolution is audited and shown to the user, never silent. |
| OIK-131 | Default general role with conservative ceiling | M | OIK-130 | Ceiling is T1_draft. Any T2+ need triggers an explicit user grant. Cannot be widened by the agent. |
| OIK-132 | Just-in-time capability request | L | OIK-131, OIK-086 | When a task needs an ungranted capability, the agent requests it through the approval surface with a stated reason; user grants for this run, for this role permanently, or denies. Grants are audited. |
| OIK-133 | Progressive scope escalation guardrail | M | OIK-132 | Repeated JIT grants within a run cannot compound into an effective tier above the role ceiling. Negative test: an agent cannot walk itself from T1 to T3 through successive small asks. |
| OIK-134 | Clarification loop for underspecified tasks | M | OIK-129 | Ambiguous task asks at most a bounded number of questions, then proceeds with stated assumptions rather than stalling. |
| OIK-135 | Routine promotion from ad-hoc run | M | OIK-129, OIK-108 | After a successful ad-hoc run, the user is offered "do this regularly" — producing a routine spec from the completed run. Routines become an **output** of use, not a prerequisite for it. |

### E14.2 — Agent-initiated work (Gap A4)

| ID | Title | Size | Depends on | Acceptance |
|---|---|---|---|---|
| OIK-136 | Initiative policy model | L | OIK-019 | A distinct, explicit policy axis from risk tiers: `reactive` (default), `suggest` (may propose work), `act_draft` (may start T0–T1 work unprompted), `act_governed` (may start work, all consequence still tier-gated). Per role, per user, default `reactive`. |
| OIK-137 | Stalled-work detection | M | OIK-038, OIK-105 | Runs awaiting approval beyond a threshold, dropped threads, and stalled handoffs are detected and surfaced. |
| OIK-138 | Proactive nudge delivery | M | OIK-137, OIK-085 | Nudges delivered to the user's surface; rate-limited; user can mute per role. |
| OIK-139 | Self-initiated task proposal | L | OIK-136, OIK-137 | At `suggest`, agent proposes a task with reasoning; user accepts, edits, or declines. Proposal itself is an audited event. |
| OIK-140 | Initiative budget accounting | M | OIK-139, OIK-110 | Self-initiated work draws from the same per-routine and platform budgets. An agent cannot spend its way past the ceiling on its own initiative. |
| OIK-141 | Initiative audit trail + kill switch | M | OIK-139, OIK-030 | Every self-initiated action distinguishable in audit from user-requested. Initiative disableable platform-wide in one operation. |
| OIK-142 | Fable adversarial review — initiative model ⚑ protected | M | OIK-141 | Reviewer model ≠ author model. Attack focus: can initiative + JIT grants combine to escalate scope or spend? |

### E14.3 — Learning by watching the human (Gap A3)

| ID | Title | Size | Depends on | Acceptance |
|---|---|---|---|---|
| OIK-143 | "Follow along" observation session mode | L | OIK-074, OIK-078 | User works in the shared browser workspace with the agent observing; session bounded, explicitly started and stopped by the user. |
| OIK-144 | Consent + redaction boundary for observation (N4) | M | OIK-143 | Observation is opt-in per session, visibly indicated throughout, and pauses automatically on credential entry, MFA, and password fields. Nothing observed enters model context without passing redaction. |
| OIK-145 | Step extraction from observed session | L | OIK-143 | Observed actions become a candidate step sequence with inputs, preconditions, and assertions. |
| OIK-146 | Observed-session → routine spec draft | L | OIK-145, OIK-108 | Draft routine presented for human review; never auto-activated. |
| OIK-147 | Correction capture on first supervised replay | M | OIK-146 | User corrections during the first agent-run replay update the routine spec, versioned in Git. |
| OIK-148 | Observation evidence retention policy | S | OIK-144, OIK-118 | Observation recordings carry a shorter retention than run evidence; expiry enforced by job. |

### E14.4 — Agent-to-agent conversation & orchestration (Gap A2)

| ID | Title | Size | Depends on | Acceptance |
|---|---|---|---|---|
| OIK-149 | Agent-to-agent message channel (governed) | L | OIK-102, OIK-100 | Agents exchange typed messages over pg-boss. Messages are audited events. **A message can request work; it can never authorize an action** — authorization remains solely in Postgres approvals. |
| OIK-150 | Multi-agent thread with human visibility | L | OIK-149, OIK-088 | A thread involving several agents is readable by the user in one view, with per-agent attribution. |
| OIK-151 | Orchestrator role ("chief of staff") | L | OIK-149, OIK-131 | An orchestrator may decompose tasks and assign to specialist roles. **Its own tier ceiling is not the union of its subordinates'** — it cannot borrow their capabilities. |
| OIK-152 | Ownership assignment + handoff protocol | M | OIK-151, OIK-102 | Work items carry a single owning role at all times; handoff transfers ownership atomically; orphaned items are detected. |
| OIK-153 | Loop and amplification guards | L | OIK-149 | Agent-to-agent message depth, fan-out, and total per-task message budget are capped. Negative test: two agents cannot sustain an unbounded exchange or amplify spend. |
| OIK-154 | Injection containment across agents | L | OIK-149, OIK-128 | Content ingested by agent A (webpage, email) cannot cause agent B to take a governed action. Explicit adversarial test. |
| OIK-155 | Fable adversarial review — multi-agent model ⚑ protected | M | OIK-153, OIK-154 | Reviewer model ≠ author model. Attack focus: privilege escalation through orchestration; injection propagation; spend amplification. |

### E14.5 — Cross-surface thread continuity (Gap A5)

| ID | Title | Size | Depends on | Acceptance |
|---|---|---|---|---|
| OIK-156 | Conversation thread model (surface-agnostic) | M | OIK-084 | Threads persist independently of the surface they originated on. |
| OIK-157 | Thread continuity across Telegram, web, mobile | L | OIK-156, OIK-086, OIK-089, OIK-092 | Start a task on mobile, continue on web, review on Telegram — one thread, correct ordering, no context loss. |
| OIK-158 | Per-surface identity binding | M | OIK-157 | The same human is bound across surfaces; approvals attribute to one principal regardless of surface used. |

---

## 3. Changes to existing tickets

| Ticket | Change |
|---|---|
| OIK-113 (browser routine recording) | **Narrowed.** Now covers agent-session recording only. Human-observation learning moves to OIK-143–148. |
| OIK-114 (non-engineer routine creation) | **Re-pointed** to depend on OIK-146 rather than OIK-113 — the realistic path for a non-engineer is demonstration, not trace review. |
| OIK-102 (typed handoffs) | **Extended** by OIK-149; handoffs remain the authorization-bearing mechanism, messaging carries only requests and context. |
| OIK-127 (parity review) | **Extended** to cover Gaps A1–A5. Also update the scorecard: per-agent isolation is **MET+**, since the reference product shares one environment across Bots. |
| Gap Closure Plan §5 (quality inversion) | **Add a fifth item:** stronger per-agent isolation than the reference product. |

---

## 4. Dependency and gating notes for DEVDepartment

- **E14 is not schedulable ahead of E4 and E9.** Conversational delegation needs a working run lifecycle and at least one surface.
- **Draft-only E14 work may proceed before G-GOV.** Zero-setup delegation, observation learning, thread continuity, and agent messaging can all be built and tested at Tiers 0–2. Only initiative that *acts* (OIK-139+ at `act_*` levels) and any Tier-3 path waits for the gate.
- **Four protected-path tickets added:** OIK-142, OIK-155, plus OIK-133 and OIK-153 by nature of what they guard. All require a second model for adversarial review — a scheduling constraint, not a checklist item.
- **Decompose before scheduling:** none of the new tickets are XL, but OIK-151 (orchestrator) should be re-examined for decomposition once OIK-149 lands.
- **New risks for the register:**

| ID | Risk | Control | Ticket |
|---|---|---|---|
| R9 | JIT capability grants compound into effective privilege escalation | Ceiling cannot be exceeded by accumulation; negative test | OIK-133 |
| R10 | Agent initiative consumes budget unattended | Initiative draws on the same ceilings; platform-wide kill switch | OIK-140, OIK-141 |
| R11 | Agent-to-agent messaging amplifies prompt injection | Messages request, never authorize; containment test | OIK-149, OIK-154 |
| R12 | Observation mode captures credentials or personal data | Auto-pause on credential fields; redaction; shorter retention | OIK-144, OIK-148 |
| R13 | Orchestrator accrues union of subordinate privileges | Orchestrator ceiling is independent, not derived | OIK-151 |
