# OIKONOMOS Gap Closure Plan — Path to Full Parity

**Version:** 0.2 (supersedes the parity scorecard in Synthesis Spec v0.1 §comparison)
**Date:** 2026-08-13
**Owner:** Alister Witbooi, Basileia Technologies
**Mandate:** Full feature parity with Grok Bot, at production quality. No checkbox matching. No feature declared "met" unless it clears a measurable quality bar. Infrastructure is not a constraint.

---

## 1. Honest re-audit

The v0.1 scorecard contained two flattering grades. Corrected:

| v0.1 claim | v0.2 correction | Why |
|---|---|---|
| "Desktop app + iOS access — **Built** (Telegram, functionally equivalent reach)" | **Partial.** Telegram is reach, not product parity. A teammate platform needs its own surfaces: approval inbox with push, live run view, evidence gallery, task intake. | "Functionally equivalent" was doing too much work. A shared chat channel is not a product surface. |
| "Own dedicated cloud/VM instance — **Built** (clawsrv)" | **Partial.** One shared host running every agent under one PM2 tree is not "each Bot receives its own dedicated instance." No per-agent disk, network, or crash isolation. | A shared host wearing a dedicated instance's badge. |

Corrected v0.2 baseline: **2 Built · 3 Partial · 5 Designed · 2 Gap.** Every one of the 12 rows now gets a closure architecture, a quality bar, and a date. Section 8 is the resulting scorecard with zero unresolved rows.

---

## 2. What "parity" means here — the quality bar rule

A feature is **MET** only when all four hold:

1. **Functional:** a real user completes the real workflow end-to-end, not a demo path.
2. **Governed:** every action flows through the capability broker; Tier-3+ requires bound approval; everything audited including denials.
3. **Evidenced:** the run answers the decisive test — what data, what actions, what changed, what was approved, how to stop/reverse.
4. **Evaluated:** a repeatable eval suite (golden tasks) passes at a stated success rate before the feature is declared, and on every change after.

A feature that works but is ungoverned is not MET. A feature that is governed but fails its evals is not MET. This rule is what separates "quality platform product" from checkbox parity.

---

## 3. Gap closures

### G1 — Connector breadth (was: Gap. Grok Bot: 25+ tools day one. OIKONOMOS: zero live.)

**Reframe that closes it:** stop treating connectors as engineering. The MCP ecosystem already contains production servers for effectively every tool Grok Bot lists — Gmail, Google Calendar/Drive/Docs/Sheets, Slack, Notion, GitHub, Jira, Confluence, Linear, HubSpot, monday.com, Outlook, Zendesk and hundreds more, discoverable via the official MCP registry and vendor-published remote servers. The Claude Code harness speaks MCP natively. **A connector is therefore a configuration + governance artifact, not code.**

What OIKONOMOS builds is the one thing the ecosystem does not provide — the **Connector Onboarding Pipeline**:

```
MCP server manifest
  → tool enumeration
  → capability mapping   (each tool → capabilities row: id, adapter='mcp:<server>', default risk tier)
  → scope minimization   (OAuth scopes reviewed against role need; e.g. gmail.compose without gmail.send)
  → role_grants          (which roles may call it, with what ceiling and constraints)
  → eval suite           (3–5 golden tasks per connector, run in draft-only mode)
  → REGISTERED           (audit-covered, kill-switchable via capabilities.enabled)
```

Per-connector quality bar: minimal scopes; every tool tier-mapped and reviewed; eval suite ≥ 90% on golden tasks; evidence artifacts written; onboarding decision recorded in Git.

**Scope boundary (binding):** OIKONOMOS is a **Basileia Technologies product**. It operates exclusively on Basileia-owned accounts, systems, and data. No connector, routine, workspace, or credential touches any client, employer, or third-party contract environment. This is a product-scope statement, not a risk mitigation — those systems are simply not in scope for this platform.

**Priority-25 connector list** (mapped to Basileia's own products and operations): Gmail, Google Calendar, Google Drive, Google Docs, Google Sheets, Google Tasks, Notion, Slack (Basileia workspace), GitHub, Jira, Confluence, Linear, Telegram (existing), Microsoft 365 (Basileia tenant only), draw.io files via Drive, Firebase/Firestore (SKUL, LekkerSwot, church app), Google Play Console (browser lane — no API), api.bible, YouTube Data (ICT Wiki Engine), VALR (ARBITER — read-only tier caps), Binance (read-only tier caps), MT5 relay (existing Flask bridge, registered as `mcp:mt5` wrapper), Xero or Sage (Basileia admin), LinkedIn (browser lane — no adequate API), Canva or Figma (Basileia design assets).

**Timeline:** Wave 1 (10 connectors) by end of week 2. Wave 2 (15 more) by end of week 4. Achievable precisely because the marginal connector is pipeline throughput, not development.

### G2 — Universal app operation / "uses any app, even without APIs" (was: Designed-only, Phase 3, weeks out)

**Outside-the-box move: do not hand-roll the Playwright + noVNC container.** Adopt **Steel Browser** (Apache 2.0, self-hostable via a single Docker image) as the browser workspace core. It provides, out of the box, exactly what v0.1 scheduled weeks to build: persistent sessions with cookies/localStorage/auth state across API calls, a REST/WebSocket API, full CDP access so existing Playwright routine code runs unchanged, a **live session viewer** (which is the human-takeover requirement, solved), and per-session proxy configuration for the egress policy. It even ships a Hermes plugin supporting self-hosted endpoints via `STEEL_BASE_URL` — confirming ecosystem fit with the rest of the stack.

**Compliance override, non-negotiable:** Steel bundles anti-detection/stealth features and its cloud offers CAPTCHA solving. OIKONOMOS **disables all of it.** Platform policy (Synthesis Spec §8) prohibits circumventing bot protections, CAPTCHAs, or MFA — a challenge triggers human takeover through the live viewer, full stop. Steel is adopted for session management, viewer, and CDP; not for evasion.

Second lane: **Claude computer use** (screenshot → action loop) inside the workspace for true desktop applications, gated behind the broker like every other capability, with the MT5-relay Tailscale pattern reused for any Windows-only target.

**Pulled forward:** browser workspace moves from "Phase 3, sequential" to Capability Track weeks 2–4, running in parallel with governance hardening (see §7). Quality bar: one real browser-only routine (Google Play Console publishing checks, or LinkedIn research draft-only) completing 10 consecutive scheduled runs with trace evidence and zero policy violations.

### G3 — Cross-agent shared context (was: Gap, no equivalent designed)

Grok Bot: "Bots can share context with each other" — opaque mechanism. OIKONOMOS designs the quality version: the **Organizational Memory Exchange (OME)** — shared context with provenance, ACLs, and audit, which Grok Bot's public materials do not claim.

**Design:**

```sql
CREATE TABLE org_facts (
    fact_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    text NOT NULL DEFAULT 'basileia',
    published_by text NOT NULL,               -- role_id of publishing agent
    acl_scope    text[] NOT NULL,             -- role_ids permitted to read; '*' = all roles
    kind         text NOT NULL,               -- 'fact' | 'artifact_ref' | 'style_profile' | 'account_nuance'
    key          text NOT NULL,
    value        jsonb NOT NULL,
    provenance   jsonb NOT NULL,              -- source run_id, evidence_uri, derivation note
    confidence   real NOT NULL,
    version      int  NOT NULL DEFAULT 1,     -- versioned, never silently overwritten
    superseded_by uuid,
    expires_at   timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now()
);
```

Rules: (1) agents **publish** facts explicitly — no ambient transcript sharing, per the research doc's warning against open-ended agent chat; (2) reads are ACL-filtered *before* retrieval reaches any model; (3) conflicting facts create a new version with `superseded_by` linkage — an agent can always answer "why do you believe this and since when"; (4) every publish and read is an audit event; (5) cross-agent handoffs remain typed work objects over pg-boss (`research.complete`, `draft.ready_for_review`) carrying `org_facts` references, not payload copies.

Interop note: the A2A (Agent2Agent) protocol is tracked for future external-agent interop; internally, typed objects + OME are tighter and fully auditable. **Timeline:** weeks 5–6. Quality bar: a two-role handoff (research → drafting) where the drafting agent consumes only ACL-permitted facts, proven by a negative test.

### G4 — Live memory that improves over time (was: Designed schema only; Grok Bot claims live)

Accelerate by adoption instead of construction: integrate **Honcho** (Plastic Labs — the same dialectic user-modeling layer Hermes uses in production) on top of the existing `profile_facts`/pgvector schema, plus Hermes's curation triggers (post-task memory-persistence nudges, periodic consolidation) — which also composes with the existing Claude Code "dreaming" consolidation pipeline already hardened in `dream-setup.md`. License note: Honcho is AGPL — acceptable for internal Basileia deployment; re-review before any client-hosted distribution.

Quality bar (this is where "not substandard" bites): memory is MET when (a) a style-profile fact demonstrably changes a draft (A/B against no-memory baseline), (b) every fact shows provenance and is user-editable/deletable from the surface, (c) retrieval is ACL-filtered pre-similarity, and (d) a false fact can be corrected and the correction sticks. **Timeline:** live in weeks 2–4, not Phase-4.

### G5 — Product surfaces: desktop + mobile (was: overclaimed as Built via Telegram)

**The outside-the-box move is recognizing the in-house advantage:** Flutter is a core Basileia competency (church app, SKUL, LekkerSwot are all Flutter/Firebase). Build **OIKONOMOS Mobile** — a Flutter control-plane client, exactly what the research doc prescribes for mobile (control/approval client; execution stays remote):

- Approval inbox with FCM push — approve/edit/reject with full evidence inline
- Task intake and live run status
- Live workspace view — Steel's session viewer embedded via WebView (watch your agent work from your phone; takeover on tap)
- Evidence gallery and audit browser
- Routine schedule management

Desktop: responsive web dashboard + PWA first (week 3, alongside the Phase-2 dashboard already planned); Tauri shell harvested from OpenWorker's `surfaces/gui` at week 6 if a native shell earns its keep. Telegram remains a first-class surface — it becomes one of three, not the alibi for the other two.

Quality bar: push-to-approval round trip under 30 seconds; approval actions in the app are nonce-bound identically to Telegram (one approval service, many surfaces). **Timeline:** Flutter alpha weeks 3–6.

### G6 — Genuinely dedicated compute per agent (was: overclaimed as Built via shared clawsrv)

Three rungs, first rung immediate:

1. **Now (week 1–2):** per-agent Docker containers on clawsrv — own filesystem volume, own network namespace, CPU/RAM quotas, own Steel session pool. This alone makes "own computer" honest at current fleet size.
2. **Fleet gate (>5 concurrent agents or first external user):** evaluated adoption of hibernating workspaces. Candidates researched: **Daytona** (AGPL-3.0; pause/resume persistence with a persistent filesystem — the best semantic match for a teammate that sleeps between tasks, and economically *superior* to Grok Bot's always-on VM: near-zero idle cost) vs **E2B self-hosted** (Apache-2.0 including the production `infra` repo; Firecracker microVM-per-agent — strongest isolation, but a real infrastructure project: Nomad/Consul control plane, GCP-oriented, and hosted sessions are short-lived which mismatches persistent teammates). Current lean: Daytona semantics on rented metal, with E2B/Firecracker reserved for the multi-tenant future the research doc's §isolation table anticipated.
3. **Multi-tenant future:** Firecracker-grade isolation becomes mandatory at first external tenant — already a ratified research-doc decision.

Quality bar for rung 1: one agent's crash, disk-fill, or runaway loop provably cannot touch another agent's workspace (chaos test in CI).

### P1 — Harness→broker wiring (was: Partial — engine built, integration missing)

Not a design gap; an execution item with a deadline. **Week 1, Governance Track, day 1–3:** wire Claude Code's permission callback (`--permission-prompt-tool` / SDK `canUseTool`) to the broker endpoint; land the canary test that attempts a direct Tier-3 tool call and fails the build unless intercepted; pin the contract in `ADR-001`. Nothing else in this plan is trustworthy until this line is green.

### P2 — Learning by demonstration (was: Phase 4, "furthest out")

Pulled forward in three steps so it is never a distant promise:

1. **Day 1:** Claude Code skills are live in the harness today — author the first OIKONOMOS skills immediately (Basileia doc conventions, spec/ADR format, inbox triage rubric, connector onboarding record). "Teach it once" exists from the first week, in skill form.
2. **Week 4:** Hermes-pattern post-task skill proposal — after a complex run, the agent drafts a skill; human reviews; versioned in Git.
3. **Weeks 6–8:** browser routine recording — Steel session traces + Playwright codegen → routine specification (inputs, preconditions, steps, assertions, allowed domains, action-tier policy) → human review → versioned, evaluated, schedulable. The research doc's five-step routine-extraction design, unchanged, just earlier.

Quality bar: the Iansha test — a non-engineer converts a demonstrated workflow into a reviewed, scheduled routine without engineering help.

---

## 4. New component adoptions (delta to Synthesis Spec §3)

| Component | License | Role | Caveats |
|---|---|---|---|
| **Steel Browser** (self-hosted) | Apache 2.0 | Browser workspace core: persistent sessions, live viewer/takeover, CDP | Stealth/anti-detection/CAPTCHA features **disabled by policy** |
| **MCP registry + vendor remote servers** | per-server | Connector supply chain for the onboarding pipeline | Each server's license/ToS reviewed at onboarding |
| **Honcho** | AGPL-3.0 | User/dialectic modeling atop pgvector | Internal use fine; re-review before client-hosted distribution |
| **Daytona** (evaluation) | AGPL-3.0 | Hibernating per-agent workspaces at fleet gate | Self-hosting is Kubernetes-weight; adopt only at gate |
| **E2B infra** (evaluation) | Apache 2.0 | Firecracker microVM isolation at multi-tenant gate | Nomad/Consul control plane; real ops project |
| **Flutter + FCM** | BSD/free | OIKONOMOS Mobile | In-house competency; reuse church-app/SKUL patterns |
| **A2A protocol** | Apache 2.0 | Tracked for external agent interop | Watch, don't adopt yet |

---

## 5. What OIKONOMOS will do that Grok Bot does not (the quality inversion)

Parity is the floor. Four properties exceed the target:

1. **Cryptographic action governance** — nonce-bound, digest-verified, one-time-consumed approvals with append-only audit. Grok Bot describes approvals; it does not describe replay-proof binding.
2. **Provenanced shared context** — OME facts carry source, confidence, version history, and ACLs. Grok Bot's "Bots share context" is opaque.
3. **Hibernation economics** — Daytona-style pause/resume beats an always-on VM per Bot on cost, materially, at Rand-denominated budgets.
4. **Model sovereignty** — AgentProvider + FreeLLMAPI routing means no single-vendor lock; Grok Bot is Grok-only.

---

## 6. The sequencing fix

v0.1 sequenced safety strictly before surface area. v0.2 runs **two parallel tracks** with one absolute gate:

> **The gate:** no Tier-3 (external-impact) action executes anywhere until Governance Track exit (end week 3). Until then, every capability — all connectors, browser workspace, memory, surfaces — operates in draft-only mode (Tiers 0–2). Breadth builds at full speed; consequence waits for the broker.

This preserves the safety property that justified the original sequencing while deleting the calendar cost of it.

---

## 7. Revised roadmap — two tracks, eight weeks

| Week | Track A — Governance | Track B — Capability |
|---|---|---|
| 1 | Broker + policy module + approval invariants; **P1 harness wiring + canary (day 1–3)**; Postgres live; per-agent Docker isolation (G6 rung 1) | Connector pipeline built; Wave-1 connectors begin; first Claude Code skills authored (P2 step 1) |
| 2 | Telegram approval flow; audit writer; Fable review of broker | Wave-1 = 10 connectors registered (G1); Steel Browser deployed, stealth disabled (G2); Honcho integration starts (G4) |
| 3 | **Governance exit:** replay/mutation/tenant-denial tests green; Tier-3 gate opens for `inbox-triage` only | Web dashboard + PWA (G5); Flutter alpha starts; memory A/B eval harness |
| 4 | Tier-3 rollout per-connector as eval suites pass | Wave-2 = 25 total connectors (G1); memory MET per quality bar (G4); post-task skill proposals live (P2 step 2) |
| 5 | Budget policies per routine; kill-switch drills | OME schema + publish/read + ACL negative tests (G3); first browser-only routine drafting |
| 6 | Chaos test: agent isolation (G6 quality bar) | OME MET; Flutter beta with push approvals (G5); Tauri shell go/no-go |
| 7 | Audit browser in surfaces; retention policies | Two-role handoff over OME (G3 quality bar); routine recording begins (P2 step 3) |
| 8 | Full-platform Fable adversarial pass | Routine recording MET (Iansha test); browser routine at 10-run streak (G2 quality bar); **parity review against §8** |

---

## 8. Parity scorecard v0.2 — every row has a path

| Grok Bot feature | Closure | Status now → Week 8 target | Quality bar |
|---|---|---|---|
| Own dedicated instance | G6: per-agent Docker → hibernating workspaces at gate | Partial → **MET+** (isolation chaos-tested; idle-cost superior) | Cross-agent breach impossible in test |
| Signs into 25+ tools | G1: MCP onboarding pipeline, priority-25 list | Gap → **MET** (wk 4) | Per-connector: min scopes, tiers, ≥90% evals |
| Operates apps without APIs | G2: Steel self-hosted + computer use, compliance-constrained | Designed → **MET** (wk 8) | 10-run streak with trace evidence, zero violations |
| End-to-end multi-step tasks | P1 wiring + G1 breadth | Partial → **MET** (wk 3–4) | Canary green; real triage workflow governed |
| 24/7, laptop closed | Existing + G6 isolation | Built → **MET+** | Survives host reboot; runs resume |
| Finished work or asks approval | Approval service, all surfaces | Designed → **MET** (wk 3) | Replay/mutation attacks fail in CI |
| Show once → routine | P2 three-step pull-forward | Designed → **MET** (wk 8) | Iansha test passes |
| Memory that improves | G4: Honcho + Hermes patterns on pgvector | Designed → **MET** (wk 4) | A/B memory effect; provenance; user-editable |
| Multi-Bot teams | Typed handoffs + OME | Designed → **MET** (wk 7) | Handoff without privilege expansion |
| Bots share context | G3: OME | Gap → **MET+** (wk 6) | Provenance + ACL + negative test — exceeds target |
| Desktop + iOS apps | G5: Flutter mobile + PWA/Tauri desktop | Partial → **MET** (wk 6 beta) | Push-to-approval < 30 s; nonce parity across surfaces |
| Approval-focused interaction | Broker + tiers + binding | Designed → **MET+** (wk 3) | Cryptographic binding — exceeds target |

Zero gaps without a path. Four rows targeted to exceed the reference product. Nothing declared MET without its bar.

---

## 9. Immediate actions

1. Ratify the two-track model and the Tier-3 gate (§6).
2. Day 1–3: P1 wiring + canary — the whole plan's credibility rests on it.
3. Stand up the connector pipeline and start Wave 1 in parallel.
4. Deploy Steel (stealth disabled) on clawsrv behind Tailscale; confirm live-viewer takeover works end-to-end.
5. Fable pass on this plan — priority attack surfaces: OME ACL model (G3) and the claim that 25 connectors clear quality bars in 4 weeks (G1).
