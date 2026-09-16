# OIKONOMOS Grok Bot Parity — Remaining Work (2026-09-16)

Written 2026-09-16 (ORCH), at the user's explicit request, after two live
failures during real user testing (weather lookup, bot-to-bot messaging)
exposed that `specs/OIKONOMOS_GROKBOT_PARITY_DISPOSITION_v1.0.md`'s 22-row
table was incomplete and that its `Status: done` tasks in PLAN.md had not
been functionally verified against real usage — only reviewed and
unit-tested at build time.

This is the raw output of a full re-read of every Grok Bot research
document, both templates/Project ADRs, and the templates/project-workspace
specs, cross-checked against PLAN.md and the real codebase (not assumed).
It supersedes the original disposition doc's `DEFER`/gap sections where
they disagree — this list is the more complete and more current account.

Excluded from this list (already confirmed genuinely live this session,
not just "done" in PLAN.md): skills, routines, context hygiene, secret
intake, browser lane, charter template, and TASK-065–079's approval/policy
hardening.

Status tags used below:
- **NOT BUILT** — no code exists anywhere for this.
- **BUILT-NOT-VERIFIED** — real code is wired into the live path, but
  nothing has actually exercised it with a real scenario.
- **DESIGNED-ONLY** — an ADR or spec describes it and has been accepted,
  but zero implementation exists.
- **PARTIALLY BUILT** — some of it is real and live; a specific named part
  is missing.

---

## Bot-to-bot & group interaction

- **Recipient "wake" on message delivery** — NOT BUILT. The source
  material's actual design: a sent message gets an immediate delivery
  acknowledgement, then the recipient wakes on a *later hidden turn* to
  process it. This is precisely TASK-273's finding — sending now works,
  nothing wakes the recipient.
- **Group routing exercised live** — BUILT-NOT-VERIFIED. Code is wired
  (`groupRouting.ts`/`groupFanout.ts`) but no real multi-bot group message
  has been run this session.
- **Priority-interrupt with protected user-lane** — NOT BUILT, no task
  filed. Needed once multiple routines/handoffs can run concurrently, so a
  priority peer message can preempt a background run without ever
  interrupting an active user turn.
- **Bounded-room anti-runaway caps** — NOT BUILT beyond the 6-member cap.
  Missing: round cap, per-turn message cap, total-message cap, rolling
  history window, "zero new messages ends the room."
- **"Workforce checker" bot pattern** — NOT BUILT, no task filed (a bot
  whose job is catching group chatter/loops).

## Templates & chief-of-staff / manager bot

- **`packages/templates` package** (manifest schema, projection, digest) —
  DESIGNED-ONLY (ADR-018 / OIKONOMOS_TEMPLATES_v1.0 T-1), zero code exists.
- **Template export API + 5-class credential scan** — DESIGNED-ONLY (T-2).
- **Template install API + grant checklist** — DESIGNED-ONLY (T-2).
- **Mobile template UI** (share-as-template, library, install, drift
  badge) — DESIGNED-ONLY (T-3).
- **Dashboard template UI** — DESIGNED-ONLY (T-4).
- **Project entity** (the shared workspace table, bound to a group
  thread) — DESIGNED-ONLY (ADR-019), no `projects` table exists.
- **Project board** (`project_tasks`, work items with owner/state/blocked
  reason) — DESIGNED-ONLY.
- **Project artifact register** (`project_artifacts`) — DESIGNED-ONLY.
- **Project decision log** (`project_decisions`) — DESIGNED-ONLY.
- **Manager role + `project.*` capabilities** — DESIGNED-ONLY. This is the
  literal "chief of staff creates/retires bots" feature; the design
  explicitly ships those two capabilities *disabled by default*, with a
  still-unbuilt broker invariant (`CapabilityEnabledDriftError`) that must
  land first, before any manager tool exists.
- **Two new budget axes** (per-project, per-role) with an atomic
  reservation protocol — DESIGNED-ONLY.
- **Four new handoff kinds** (`task.assigned/completed/blocked`,
  `status.requested`) — DESIGNED-ONLY.

## Sandbox & security hardening

- **Process identity binding** for long-lived agent processes (generation
  token, PID never trusted) — NOT BUILT, no task filed; relevant now that
  the worker supervises real sandbox lifecycles.
- **Content-addressed sandbox staging + ownership labels** — NOT BUILT.
- **Docker hardening deltas**: cap-drop, non-root sandbox user, tighter
  network restriction beyond today's egress allowlist — PARTIALLY BUILT
  (egress allowlist itself is done; the container-hardening anti-patterns
  were flagged and never fixed).
- **Protocol-breach state machine** for worker↔control-api long-lived
  streams — NOT BUILT, no task filed.

## Model routing & cost

- **Pure-function Tier-0 model routing** (explicit inputs: routine kind,
  budget remaining, override, default) — DEFERRED, no task filed despite
  multiple providers already existing.

## Deferred by original design (lower priority, worth knowing about)

- **Teach-by-demonstration → draft skill** — DEFERRED, no task.
- **Public template marketplace / signed index / external import** —
  explicitly out of scope for now by design, not just unbuilt.

---

## Not covered by this pass

Live functional verification of G-04 (group routing), G-06 (browser
lane), G-07 (human takeover), and G-08 (egress allowlist) — flagged by an
earlier audit this session as wired-but-never-actually-exercised, not
re-tested here. Treat those as open questions, not confirmed-working.
