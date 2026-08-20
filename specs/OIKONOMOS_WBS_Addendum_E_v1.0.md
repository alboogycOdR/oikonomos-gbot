# OIKONOMOS — Work Breakdown Addendum E

**Version:** 1.0 · **Date:** 2026-08-17
**Extends:** Master WBS + Addenda A–D. Strengthens E5/OpenSandbox integration (Addendum B), E14.4 orchestrator design, E11 durability.
**Source:** elie222/rakazo — "Open-source Grok Bot alternative. Choose your own model and sandbox." Apache-2.0 confirmed, TypeScript, self-hostable with no required vendor control plane ("this repository is the complete core product — it runs without a Rakazo-operated control plane"). Tiered sandbox providers (Docker / E2B / direct-host / native macOS), explicit "Chief of Staff" orchestrator role convention, bot-spawns-peer-bot hierarchy, session/data durability decoupled from sandbox provider, Composio plugin integration (optional). ~456★, single primary maintainer, last commit within 24h of review.

---

## 1. Strategic finding

Rakazo is the most architecturally mature of the three OSS Grok-Bot alternatives reviewed (own project, OpenMausBot, Rakazo) — it is the first to acknowledge the isolation-strength tradeoff explicitly, to decouple durable state from the sandbox provider, and to name an orchestrator convention matching our own design independently. It remains, like OpenMausBot, **entirely without a governance layer**: no approvals, no risk tiers, no audit trail, no egress policy engine — only a README warning not to run the least-isolated mode publicly. This confirms the pattern established in Addendum D: **the interaction and computer-provisioning layer is now commodity, built to a converging shape by multiple independent teams within days of Grok Bot's launch. The governed control plane remains unclaimed territory.** No change to that strategic position — this addendum reinforces it and harvests three concrete patterns.

**Adoption stance:** do not adopt Rakazo as a foundation (single maintainer, days-old, no governance seam to graft a broker onto — same reasoning as Addendum D §1 for OpenMausBot). Harvest three patterns; fold one invariant into existing design language; add to the standing monthly watch.

---

## 2. Findings and closures

**Finding 1 — sandbox tier selection should be policy-driven, not merely operator-chosen.** Rakazo lets the operator pick Docker / E2B / direct-host / native-Mac per deployment, with an explicit risk statement per tier ("do not use it on a public or shared server" for direct-host). Our OIK-045c already assigns isolation strength by capability tier (Tier 0-1 lighter, Tier 3-4 strongest) as a policy decision, not a user preference — Rakazo's tier menu is a useful UX reference for *how to present* that choice where a human override is legitimate (e.g., local dev vs. production), without weakening the rule that Tier 3-4 execution cannot be user-downgraded to an unsafe backend.

**Finding 2 — "the provider machine is not the durable source of truth" is a sharper statement of an invariant we already hold implicitly.** Rakazo checkpoints workspace and browser-profile data into its own `DATA_DIR`, independent of whatever sandbox provider is running the bot. Our design already puts Postgres (`runs`, `session_ref`) and the evidence store as the durable record, with OpenSandbox sandboxes being disposable compute — but this hasn't been stated as an explicit named invariant anywhere in the specs. Worth promoting to a first-class rule, since it directly governs how OIK-045 (sandbox lifecycle: create/pause/destroy/reap) must behave under failure.

**Finding 3 — "Chief of Staff" as a named, user-facing orchestrator convention validates OIK-151, and its constraint story is instructive by omission.** Rakazo's orchestrator can spawn peer bots (own thread, own computer) or short-lived subagents (turn-scoped, no independent thread) — the same two-tier distinction as our OIK-151/152. Rakazo does **not** appear to constrain the orchestrator's effective privilege relative to its spawned peers — there is no stated equivalent of our R13 rule (orchestrator ceiling is independent, not the union of subordinates'). This is a gap in their design, not a pattern to harvest — it strengthens the case for keeping R13/OIK-151's acceptance criterion exactly as specified, since the obvious naive implementation (the one a second independent team appears to have shipped) is the one that leaks privilege.

**Finding 4 (confirms, no action) — Composio again.** Rakazo offers Composio as an optional plugin channel, same as OpenMausBot. No new information; OIK-164's evaluation spike already covers this pattern across both sightings.

---

## 3. Tickets

| ID | Title | Size | Depends on | Acceptance |
|---|---|---|---|---|
| OIK-168 | Promote "sandbox is disposable, Postgres is durable" to a named invariant (N11) | S | OIK-042, OIK-045 | Added to CLAUDE.md non-negotiables and Synthesis Spec design language; OIK-045 (create/pause/destroy/reap) acceptance criteria re-checked against it explicitly — a sandbox destroyed mid-run must not lose any state not already persisted to Postgres/evidence store |
| OIK-169 | Sandbox-tier presentation UX reference (Rakazo tier menu → operator-facing config, not user-facing at runtime) | S | OIK-045c | Design note only: how Rakazo surfaces tier tradeoffs informs `infra/compose` deployment docs (local Docker vs. stronger backend); explicit re-statement that this is an **operator/deployment-time** choice, never a runtime user or agent choice for Tier 3-4 |
| OIK-170 | Negative test: orchestrator privilege independence (harden R13/OIK-151 given Finding 3) | M | OIK-151 | Explicit test that an orchestrator's own broker-checked tier ceiling is unaffected by the tiers granted to any bot/subagent it spawns — written specifically because a comparable open-source implementation appears not to enforce this |
| OIK-171 | Monthly watch: Rakazo maturity + governance-layer emergence | S | OIK-167 (Addendum D watch job) | Folded into the existing OpenMausBot watch cadence — one combined "OSS Grok-Bot alternatives" watch rather than a second parallel job; ticket auto-raised if either project adds an approval/audit layer |

---

## 4. Risk register

| ID | Risk | Control | Ticket |
|---|---|---|---|
| R20 | A second independent implementation (Rakazo) shipping unconstrained orchestrator-to-subordinate privilege suggests this is an easy mistake to make, not a one-off oversight | Explicit negative test rather than relying on the general broker tests to catch it incidentally | OIK-170 |
| R21 | Sandbox-tier operator choice, if exposed carelessly, could let a user or misconfigured deployment downgrade Tier 3-4 execution to an unsafe backend | OIK-045c policy mapping remains authoritative; OIK-169 explicitly scopes tier choice to deployment-time, not runtime | OIK-169 |

---

## 5. Scheduling note

Four tickets, all S/M, none blocking, no epic superseded, no gate affected. OIK-168 is worth doing early since it's a naming/documentation change that clarifies behaviour already assumed elsewhere (E5, E11). OIK-170 should land alongside OIK-151/152 in E14.4 rather than deferred, since it's a negative test guarding a design decision already made — cheap now, and Finding 3 gives a concrete reason it matters. OIK-171 simply merges into the existing Addendum D watch cadence — no new recurring job.
