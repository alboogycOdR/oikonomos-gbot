# Grok Bot (x.ai/bot) — Evidence-Based Technical Report and Replication Blueprint

| Field | Value |
|---|---|
| Document | `GROKBOT-TR-2026-09` |
| Version | 1.0.0 |
| Date | 2026-09-05 (Saturday) |
| Prepared for | Basileia Technologies — OIKONOMOS programme |
| Subject | SpaceXAI / Cursor **Grok Bot** (public beta since 2026-08-11) |
| Evidence cut-off | Vendor docs last updated 2026-09-03; independent reports through 2026-09-02 |
| Author | Claude (research synthesis); all claims graded and sourced in §15 |

---

## 0. Executive summary

1. **Grok Bot is a Cursor-built product wearing a Grok label.** Downloads, checkout, sales, help pages, iOS publisher (Anysphere), authentication, privacy settings and billing all run on Cursor infrastructure. SpaceX closed its ~$60B all-stock acquisition of Anysphere (Cursor) on 14 August 2026 — three days *after* Grok Bot launched. The product was Cursor's internal "Sand" project. Every architectural and governance decision below is therefore a Cursor decision. [E1/E3]
2. **The core unit is a "Bot": a named, persistent agent** with a title, a natural-language description (standing rules), memory, skills, routines and connectors. Bots run on a **persistent cloud computer** (browser + filesystem + terminal) and finish work inside real tools rather than producing drafts in chat. [E1]
3. **One computer per *user*, not per Bot.** Each user gets a dedicated Firecracker microVM; all of that user's Bots share its files, cookies, logins and shell credentials. Each Bot gets its own *screen*, not its own security boundary. The vendor states this plainly and it is the single most consequential design fact for anyone replicating or evaluating the product. [E1]
4. **Bots have no identity of their own.** They act as the signed-in human; connector OAuth tokens live on Cursor's backend and are never placed on the computer; passwords/2FA/CAPTCHA/payments are handed back to the human via "take over". [E1]
5. **Governance is layered:** explicit boundaries in the request → Bot description → personal Auto-Review rules (Require-Approval beats Always-Allow) → team Auto-Review allow/block instructions → Team Rules → Enterprise-only network egress allowlist, MCP allowlist, Action Recording, audit logs, SCIM. Auto Review is an independent review model that evaluates shell, plugin, computer-use, automation-write and delegation actions before they run. [E1]
6. **Extensibility is Cursor's plugin + MCP system, inherited wholesale.** Connectors surface as "Plugins", follow the team's existing Cursor connector/MCP policy, and there are no Grok-Bot-specific plugin controls. Plugins are Cursor-marketplace bundles (`.cursor-plugin/plugin.json` + `skills/` + `rules/` + `mcp.json`). Grok Bot does **not** load local plugins; only marketplace-published ones. Templates (shared Bots) deliberately strip custom MCP servers, scripts and secrets. [E1/E3/E4]
7. **Three separate "MCP surfaces" exist in the SpaceXAI stack and are frequently conflated:** (a) Grok Bot's Cursor-policy plugin layer; (b) Grok Build (the coding CLI) with `grok mcp add`, `~/.grok/config.toml` and its own `.grok-plugin` marketplace format; (c) the Grok **API** Remote MCP Tools (`type: "mcp"` in the Responses API). Only (c) is programmatically consumable by a third-party platform today. [E1]
8. **Real-world usage is concentrated in operational review loops**: overnight research → scored draft → human approval. The best-evidenced deployment is a six-Bot mobile-game studio (self-reported CPI $15→$1, D7 retention ~4×). Independent hands-on tests show competent multi-step browser work but also label misreads, unbounded per-Bot context threads with no compaction, opaque weekly quotas, and a staff-confirmed outage where one stuck shared computer took every Bot on the account down. [E2/E3/E4]
9. **Hard limits documented:** ≤50 Bots + group chats per account; ≤50 routines per Bot; 20 retained run records per routine; 2–6 Bots per group chat; ≤10-minute teach-by-demonstration recordings; one computer-use task per Bot screen at a time; US-only compute; no on-prem, BYO-image, VPN or private link; no model picker. [E1]
10. **Replication verdict:** the product is reproducible with open components (microVM/containers, Playwright persistent contexts, virtual X screens, an MCP client, a scheduler, a two-layer policy gate, a handoff bus). The defensible differentiators for OIKONOMOS are exactly Grok Bot's documented gaps: per-Bot isolation as an *option*, context compaction and a visible context meter, transparent usage metering, multi-channel reach (Telegram/Slack/email), model choice with failover logging, and self-hosted data residency (POPIA-relevant). §12–§13 give the blueprint and roadmap.

---

## 1. Scope, method and evidence grading

**In scope:** documented and observable capabilities; bot construction model; instruction/personality/identity system; use cases; connectors and integrations; MCP-related extensibility; governance/security; real-world deployments; replication architecture and roadmap.

**Out of scope:** benchmarking model quality; the Grok chat app; Grok Build internals beyond their MCP/plugin surfaces.

**Method:** primary fetches of x.ai/bot and every Grok Bot documentation page on docs.x.ai (overview, bots, chat-and-collaboration, computer-and-apps, skills/routines, approvals, security, teams-and-enterprises, FAQ), the five official guides, the public Bot Marketplace and individual template pages, the xAI plugin-marketplace repository, Grok Build and Grok API MCP docs; cross-checked against independent hands-on write-ups (Flavio Copes, DataCamp, Composio, Vellum, eesel, CellCog, LLM Rumors, Nervegna), business press (9to5Mac, TNW, Runtime Wire, Trending Topics) and community catalogues (awesome-grok-bot).

**Evidence grades used throughout:**

| Grade | Meaning |
|---|---|
| **E1** | Vendor primary documentation (docs.x.ai, cursor.com/docs, official repos) |
| **E2** | Vendor marketing, launch posts, official guides, marketplace listings |
| **E3** | Independent hands-on testing with screenshots/transcripts, or business press citing filings |
| **E4** | Community reports, forum posts, single-user anecdotes, reverse-engineered figures |

"Observable" in this report means observable through third-party hands-on artefacts and public marketplace/template metadata; the author did not operate the application directly.

---

## 2. Corporate and product context

### 2.1 Timeline (verified)

| Date | Event | Grade |
|---|---|---|
| 2026-02-02 | SpaceX announces it has acquired xAI (valuation reported ~US$250B); entity later rebrands to **SpaceXAI** (July 2026) | E3 |
| 2026-04 | SpaceX signs an option/partnership with Anysphere (Cursor); compute sharing and joint model training begin | E3 |
| 2026-06-16 | SpaceX agrees to acquire Anysphere for ~US$60B in stock (largest venture-backed startup acquisition on record); expected Q3 close | E3 |
| 2026-07 | Grok 4.5 released, jointly trained by Cursor and SpaceXAI — Cursor's first model aimed at knowledge work outside software | E3 |
| 2026-08-11 | **Grok Bot public beta** (internal codename "Sand"). Eligible: SuperGrok Heavy, Cursor Ultra, Cursor Teams Premium | E1/E3 |
| 2026-08-14 | Acquisition closes (Cursor announcement; 8-K filing; some outlets date it 15 Aug). Cursor becomes a subsidiary inside SpaceXAI | E3 |
| 2026-08-21 | Access expanded to SuperGrok Plus, Cursor Pro+, all Cursor Teams; one-time trial for others | E2 |
| 2026-08-28 | Bot **Templates** (share-as-template) announced | E2 |
| 2026-08-29 | Native **X connector** + X plugin; Grok Bot creates an X developer account for the user; paid users receive starter X API credits | E1 |
| late 2026-08 | Access extended to all SuperGrok and Cursor Pro subscribers; weekly limits reset; **Stripe Link** purchasing (US only, single-use cards) | E3 |
| 2026-09-03 | Docs refresh: teams/enterprise, security, identity and private-network pages | E1 |

### 2.2 Product family disambiguation

| Product | What it is | MCP/plugin surface |
|---|---|---|
| **Grok** (grok.com, X, mobile) | Chat assistant | Consumer "Connectors" (SuperGrok tiers) |
| **Grok Build** | Terminal coding agent (CLI/TUI), later open-sourced; AGENTS.md, worktrees, plan mode, subagents, hooks | `grok mcp add`, `~/.grok/config.toml`, `.grok-plugin` marketplace |
| **Grok Bot** | Persistent named agents on a cloud computer; general knowledge work | Cursor plugin/MCP marketplace and policy |
| **Grok API** | api.x.ai (Responses API, native SDK, gRPC) | Remote MCP Tools (`type: "mcp"`) |
| **Cursor** | IDE, Agent, Cloud Agents, Bugbot, Origin (code hosting) | Cursor Marketplace, MCP trust management |

### 2.3 Distribution and pricing (as observed on x.ai/bot, 2026-09-05)

- Download links resolve to `api2.cursor.sh`; sales/enterprise waitlist to `cursor.com/contact-sales?product=grok-bot`; onboarding at `cursor.com/bot/onboarding`. Sign-in is a **Cursor account** (SuperGrok subscriptions are *linked* to it). [E1]
- Plan cards shown: Cursor Pro **$20/mo** (Pro / Pro+ / Ultra tabs), SuperGrok **$30/mo** (SuperGrok / Plus / Heavy), Cursor Teams **$40/seat/mo** (Standard / Premium). Higher tiers (Ultra ≈$200, Heavy ≈$300, Premium Teams ≈$120/seat) are reported by third parties. [E1/E4]
- Grok Bot usage is **separate** from Grok/Cursor plan usage: a weekly allowance whose numeric size is not published, plus optional on-demand usage billed from model and token cost. If a user has both Cursor and SuperGrok, Grok Bot draws on whichever has more usage. No standalone Grok Bot SKU. [E1]
- Requires cloud data storage; **Cursor Legacy Privacy Mode blocks the product entirely.** Training opt-out follows Cursor account/team privacy settings. [E1]

---

## 3. Platform architecture (documented)

### 3.1 Component view

```
┌──────────────────────────────────────────────────────────────────────────┐
│  THIN CLIENTS  (macOS / Windows / Linux desktop; iOS / Android)          │
│  chat · review · approvals · "Agent Computer" live view · take-over      │
└───────────────┬──────────────────────────────────────────────────────────┘
                │ Cursor auth (SSO/SAML), Cursor privacy + billing settings
┌───────────────▼──────────────────────────────────────────────────────────┐
│  CURSOR CONTROL PLANE                                                    │
│  Bot registry · conversations/threads/groups · routines scheduler        │
│  Auto Review (independent review model) · Team Rules · Network Controls  │
│  Connector backend (OAuth tokens never leave here) · usage metering      │
│  Model routing (no customer picker; automatic failover; per-request log) │
└───────────────┬──────────────────────────────────────────────────────────┘
                │ one per USER
┌───────────────▼──────────────────────────────────────────────────────────┐
│  PERSISTENT CLOUD COMPUTER  = Firecracker microVM (own kernel/memory)    │
│  Linux · Chromium browser (shared cookies/sessions) · shell · /workspace │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐   each Bot = its own SCREEN         │
│  │ Bot A   │ │ Bot B   │ │ Bot C   │   (parallel), NOT its own boundary  │
│  │ screen  │ │ screen  │ │ screen  │                                     │
│  └─────────┘ └─────────┘ └─────────┘                                     │
│  shared static egress IPs · optional Team Setup (Tailscale/CF Tunnel)    │
└───────────────┬──────────────────────────────────────────────────────────┘
                │ optional delegation
┌───────────────▼──────────────────────────────────────────────────────────┐
│  CURSOR CLOUD AGENTS (separate computers) for coding tasks               │
└──────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Documented design principles (E1)

1. **Per-user isolation** — hardware-level separation between users via Firecracker microVMs; one user cannot reach another's computer.
2. **No access by default** — a Bot can use only the accounts and plugins the user or team grants.
3. **Human approval gates** — sensitive actions stop for approval, evaluated by the Auto Review model.
4. **Administrative control** — Team Rules, Cloud Agent delegation, template sharing (Teams+); Network Controls, Team Setup, Action Recording, org-wide enable switch (Enterprise only).

### 3.3 Persistence semantics (E1)

| Durable across sessions/updates | Treated as replaceable |
|---|---|
| `/workspace` files, browser state and supported sign-ins, Bot memory, routines | temp directories, manually installed packages, uncommitted app state |
| Idle computers **hibernate** (not deleted); image updates recreate the VM with files preserved | **Reset** returns to last durable snapshot and can discard unsynced work |
| Daily encrypted backups of the control plane, replicated off-site | Per-org retention policy and customer-driven point-in-time restore: **not available** |

### 3.4 Local execution (E1)

Distinct from the cloud computer. The desktop app can run commands, read files and move files between the local machine and the cloud computer. Policy: **Ask every time** (default) / Always allow / Never. Vendor recommends **Never** unless there is a specific reason. Team-level ceiling is enforced via settings; no dashboard control yet.

---

## 4. Capability inventory — documented vs observed

| # | Capability | Documented (E1) | Observed / independently confirmed | Notes & limits |
|---|---|---|---|---|
| C1 | Persistent named Bots | Yes | Yes (E3: DataCamp, Copes) | ≤50 Bots + groups per account |
| C2 | Persistent cloud computer (browser, files, shell) | Yes; Firecracker microVM per user | Yes (E3); "managed Linux VM" | US-only; Cursor-hosted only |
| C3 | Computer use on sites without API/MCP | Yes | Yes (E3: Meta Ads UI upload learned by demonstration) | Datacenter-IP blocks, CAPTCHAs, session expiry reported (E3/E4) |
| C4 | Connectors ("Plugins") with structured tools | Yes | Yes (E3: Notion, Gmail multi-account, Neon, Coolify, X) | Account-wide, not per-Bot |
| C5 | Skills (reusable procedures) | Yes | Yes (E3) | Cross-Bot; enable per Bot under Settings → Plugins → Yours; `/` to invoke |
| C6 | Routines (schedule / event trigger) | Yes | Yes (E3: Monday routine, 08:00 daily) | ≤50 per Bot; 20 run records kept; may auto-pause after long inactivity |
| C7 | Teach a task (record ≤10 min browser demo → draft skill) | Yes, gradual rollout | Yes (E2: Ryan Perry; E3: some accounts lack the control) | No audio; secrets must use secure hand-off |
| C8 | Bot-to-Bot async messaging and handoffs | Yes | Yes (E2/E3) | Group handoffs text-only; images must be sent Bot→Bot directly |
| C9 | Group chats (2–6 Bots), `@`/`@everyone`, threads, reactions | Yes | Yes (E3) | Host wakes each member in turn → usage cost per member (E4) |
| C10 | Memory (stable preferences, facts, summaries) | Yes | Yes; also **unbounded single thread per Bot, no compaction, no context meter** (E4, staff-confirmed) | Vendor: keep changing facts in source systems |
| C11 | Approvals (Allow once / Always allow / Deny) | Yes | Yes (E3) | Approval does not undo completed work |
| C12 | Auto Review (independent model gate) | Yes; covers shell, plugin calls, computer use, automation writes, delegation | Not independently characterised | Does not review memory writes / most settings changes |
| C13 | Secure secret request (masked, out of transcript, hidden from model) | Yes | Yes (E4: praised vs. Codex/Claude flows) | Not a password manager |
| C14 | Take-over for password/2FA/CAPTCHA/payment | Yes | Yes (E3) | — |
| C15 | Cloud Agent delegation for coding | Yes | Yes (E4: Lovin, Palmer) | Admin can disable |
| C16 | Templates / public share links | Yes | Yes (E3: x.ai/bot/<id> pages) | Excludes history, logins, custom MCP, scripts, secrets |
| C17 | Marketplace of public Bots | Yes | 69 Bots, 43 creators, 10 categories (2026-09-05) | Deep link `grokbot://app/v1/bot-template?id=…` |
| C18 | Stripe Link purchases with per-payment approval, single-use card | Announced (E2) | E3 secondary | US only at launch |
| C19 | Native X connector (search, timeline, mentions, trends, bookmarks) | Yes | E3 secondary | Auto-creates X developer account; separate X credit pool |
| C20 | Mobile (iOS 18+, Android 9+) | Yes | iOS confirmed (E3) | Some admin (routine editing, teach) is desktop-only (E3) |
| C21 | Enterprise: SSO/SAML, SCIM, Network Controls, Team Setup, Action Recording, OTel export, audit logs | Yes | Not independently tested | Most are Enterprise-only; self-serve Teams do not see them |
| C22 | Model selection | **No picker**; managed routing with failover; usage analytics show serving model | Confirmed (E3) | Grok 4.6 available; mix can change |

---

## 5. Bot construction model

### 5.1 Object model

```
Account (Cursor user; optional linked SuperGrok)
 ├── Computer (1 per user; Firecracker microVM; /workspace; browser; shell)
 ├── Plugins/Connectors (account-wide; OAuth tokens on backend)
 ├── Skills (account-wide library; enabled per Bot)
 ├── Auto-review rules (personal; stored per desktop, synced to its computer)
 ├── Bots (≤50 incl. groups)
 │    ├── Profile: name · title · description · avatar
 │    ├── Conversation (single long-lived thread; threads/reactions inside)
 │    ├── Memory (stable preferences, facts, summaries — Bot-scoped)
 │    ├── Enabled skills
 │    ├── Routines (≤50; owner = this Bot; 20 run records each)
 │    └── Screen on the shared computer
 └── Group chats (2–6 Bots + the human)
```

### 5.2 Lifecycle operations (E1)

| Operation | Behaviour |
|---|---|
| **Create** | New → "Create new agent" → Bot named *New Agent* → Bot actions → **Edit Profile** (name, title, description, avatar) → first concrete task. Existing Bots may propose/create a focused Bot when a job needs a long-lived owner. |
| **Edit** | Change name/description as durable preferences, boundaries or responsibilities are discovered. |
| **Pin / Hide** | Hiding removes from sidebar without deleting; **does not pause routines**. |
| **Duplicate** | Copies profile, settings, enabled skills, routines, avatar. Does **not** copy conversation history, learned memory or attachments. Named `<name> copy`. |
| **Share (link)** | Public preview on x.ai; recipient adds a *copy* (identity, description, skills, routines). No computer/logins/history. Accepting adds third-party bot terms. |
| **Share as template** | Bot reviews own config, prepares an *unpublished* template (instructions, selected memories, skills, routines, first-party integrations); publisher inspects, then publishes to team or public. Custom MCP servers, scripts, code and secrets are excluded by design. |
| **Delete** | Removes profile, conversation, routines. Shared computer files and sign-ins **remain**. |

### 5.3 The canonical role specification (six-part pattern)

Two independent sources converge on the same construction pattern: the official docs (description = rules that stay true; message = this week's task) and the official mobile-development guide, whose author writes each Bot as a six-part job description. Generalised:

| Part | Purpose | Where it lives |
|---|---|---|
| 1. Job description | The lane it owns *and the work it refuses* (e.g., "the only Bot allowed to declare a finding"; "never buys media") | Bot description |
| 2. Connections | Named accounts/tools it may use; rule for missing tools ("ask before working around it") | Bot description + connectors |
| 3. Computer | Do the work on its own computer; run on schedule regardless of laptop state | Implicit / description |
| 4. Routines | Standing schedule with timezone and expected output | Routine objects |
| 5. Skills | Recorded or written playbooks to replay | Skill objects |
| 6. Handoffs | Who receives findings/specs; what requires the human ("check with me before anything that spends money") | Bot description + group/DM |

**Original example — an operational-readiness reviewer (structure only; adapt sources):**

```markdown
# Bot: Release Readiness Reviewer
Title: Weekly release-readiness reviewer for Platform X

## Non-negotiable rules
- Read-only against Jira, Confluence, the change calendar and the runbook repo.
- Never edit a ticket, page or runbook; never message stakeholders; never accept terms.
- Every claim links to its source. Unknown = "not verified", never a guess.

## Recurring job
- Each Friday 14:00 Africa/Johannesburg: for every change scheduled next week,
  verify (a) RACI owner present, (b) rollback step documented, (c) comms plan
  linked, (d) access requests approved. Produce a table with a status per item.
- Save /workspace/readiness/YYYY-WW.md; post a 10-line summary in this chat.

## Current assignment
- Focus on the IAP cut-over changes; treat anything tagged "SCIM" as high risk.

## Handoffs
- Send blocked items to @Comms-Drafter as a spec (owner, gap, evidence).
- Ask me before opening any ticket.
```

Design rationale from the vendor and testers: a narrow job improves what the Bot stores in memory, which sources it trusts and when it stops; a "General Helper" degrades all three. [E1/E3]

### 5.4 What a Bot remembers, and what it should not (E1/E3)

- Retains stable working preferences, important facts and summaries of prior work. Memory is *advisory*; vendor guidance is to keep changing facts in the source system and to ask the Bot to reopen current data for consequential decisions.
- Observed failure modes: a profile written as instructions was treated as a live task until explicit "wait for a separate message" rules were added (E3, DataCamp); long threads mix projects and sensitive material, and there is no fresh-session, manual compaction or context meter (E4, staff-confirmed).

---

## 6. Instruction, personality and identity system

### 6.1 Instruction precedence stack (synthesised from E1)

```
 highest ─┐  Enterprise Network Controls (egress allowlist)        deterministic
          │  Enterprise MCP allowlist / Teams connector policy    deterministic
          │  Team Rules (always required; scoped Cursor | Grok Bot | both)
          │  Auto Review TEAM allow/block instructions             model-based
          │  Auto Review PERSONAL rules  (Require-Approval > Always-Allow)
          │  Per-action approval prompt (Allow once / Always allow / Deny)
          │  Bot description  (standing rules, approval boundaries, refusals)
          │  Skill body       (procedure, validation, output, approvals)
          │  Routine text     (schedule, inputs, no-data policy, boundary)
          │  Message          (this task; a direct human message pre-empts background work;
 lowest  ─┘                    "Stop now" halts but does not undo)
          +  Memory (learned; advisory) and external content (marked UNTRUSTED to the model)
```

Key semantics (E1):
- **Require Approval wins** whenever both a Require-Approval and an Always-Allow rule match. Always-Allow proceeds only if Auto Review finds no other reason to stop.
- Auto Review enforcement is on for all users; each member's own setting is the off switch; no org-level lock exists.
- Team Rules are enforced as always-on context; for *enforcement* the vendor points to Auto Review instructions instead.
- Personal Auto-review rules are stored on the desktop that created them and synced to *that* desktop's computer — a second desktop needs its own rules.

### 6.2 Personality

There is no separate "personality" field. Persona emerges from (a) the description, (b) the Bot's memories (marketplace listings expose these under *"Facts it already knows"*, e.g. one template stores a working-style mode, publish-routing rules and its own name/version), and (c) skills. Testers report the **name is cosmetic** — it organises the sidebar and does not change behaviour; the title is the one-line job; the description carries operating instructions. [E3/E4]

### 6.3 Identity

- A Bot **has no identity or credentials of its own**; it acts as the signed-in member, can never exceed that member's access, and every action is attributable to a named human. Team-managed connectors are the one exception (team/service-account credentials). [E1]
- Inside the computer, members sign in to SaaS apps through their own IdP in the browser — "comparable to enrolling a new laptop"; IdP session policies and revocation apply. [E1]
- Connector OAuth tokens remain on Cursor's connector backend; Bots invoke tools without receiving tokens. [E1]
- Bot-to-Bot messages are first-class, asynchronous, and visible in the conversation; a receiving Bot *wakes* to handle the request. [E1]
- Marketplace metadata exposes a Bot's public identity surface as three lists: **memories** ("Facts it already knows"), **skills** ("Playbooks it can run"), **integrations** ("Apps it can use"). [E2]

### 6.4 Observed behavioural traits (E3/E4)

| Trait | Evidence |
|---|---|
| Self-extends its remit | A Bot recognised an ad-hoc nightly request should be a routine and created it (official guide, screenshot) |
| Pushes back on micromanagement | Launch testimonial: Bots asked a user why she kept checking in |
| Conservative when rules bind | DataCamp routine returned "Total: 0" rather than pad a plan that violated its validation rules |
| Source-fidelity errors | Wrote "Beginner" where the page printed "Basic"; read a duration range as a fixed total |
| Leaves gaps explicit when told to | Blog-review Bot marked a locked analytics source as unverified instead of reusing stale data |
| Group chatter cost | Unconstrained multi-Bot rooms repeat each other and spend usage discussing instead of doing |


---

## 7. Use cases and real-world deployments

### 7.1 Official taxonomy (x.ai/bot/use-cases, 2026-09-05) [E2]

56 catalogued jobs across 10 categories: General 6 · Sales 10 · Marketing 13 · Customer Success & Support 4 · Recruiting & People 4 · Operations & Finance 5 · Product 5 · Engineering 5 · Life & Leverage 4.

Representative entries (each ends at a human approval point): Chief of Staff (scans Slack/email/calendar/notes → sourced read-out), Sales Outbound (overnight research → intent scoring → drafts "in your voice"), Paid Media (live channel data → recommended reallocation → hold for approval), Bug Reproduction (click the path in staging → repro pack with steps, screenshots, network notes), Product Performance (log into observability tools → walk flamegraphs → hotspots with screenshots), Security Questionnaire Filler (portal login → pull answers from trust centre/past RFPs → park submit), Vendor Portal Operator (portals with no API → weekly click-path → exceptions only), Playtest Operator, Cloud Agent Orchestrator, Subscription Cleaner, Travel Coordinator, Apartment Scout.

**Pattern:** the vendor's own catalogue is ~90% "prepare/reconcile/draft, then stop for approval" and ~10% "execute after approval". The wording "never sends without you" recurs across the marketplace.

### 7.2 Bot Marketplace (x.ai/bot/marketplace) [E2]

69 public Bots · 43 creators · 10 categories (Grok Bot Team, Engineering, Marketing, Personal, Operations, Sales, Customer Success, Recruiting & People, Design, Product). Notable architectures:

| Template | Creator (affiliation) | Architecture signal |
|---|---|---|
| **Projects Manager** | Eric Zakariasson (Cursor) | Meta-orchestrator: Notion Projects + Tasks DBs; one channel per project; staffs ≤5 specialists + PM; never does specialist work itself; "Blocked" status pings the human |
| **tinkabot** | Lauren Tan (Cursor) | Wraps an API into a Cursor/Agent Plugin (MCP + skills); records that Grok Bot loads plugins only from the Cursor dashboard/marketplace |
| **Nightly Audit Engineer** / **Engineer Bot** | Lingxi Li | Boards work, launches Cloud Agents on a named repo, polls PRs on a 30-min cadence, asks only to merge; defaults to 04:00 |
| **Alfred** | Robin Delta | Governs the Bot *organisation* itself: smallest useful structure, human owners, no duplicate jobs, creates nothing without explicit yes |
| **The Morning Newspaper** | Karen X. Cheng | Pulls email + calendar, lays out a personalised paper, prints overnight |
| **dial bot** | Matt Palmer | Places outbound phone calls via a third-party voice API (asks for API key on first use) |
| **Researchy** | Farzad | Every pass on latest Grok with live web search; dated, sourced claims |
| **Company Docs Q&A** | Anoop Baliga | Live docs first, then connected knowledge sources, always cites |

### 7.3 Evidence-graded deployments

| Deployment | What ran | Outcome / evidence | Grade |
|---|---|---|---|
| **SpaceXAI internal (pre-launch)** | Sales Bot updating CRM from call transcripts and drafting follow-ups; ops Bot seating new hires and processing invoices from Gmail; engineering Bot reproducing a UI bug, filing the ticket, handing the fix to a debugging Bot | Launch post; five employee testimonials | E2 |
| **Rank'em mobile-game studio (Ryan Perry)** | Six Bots: Mobile Orchestrator, Analytics (only one allowed to *declare a finding*), Creatives (never buys media), Engineer (takes findings as specs), GCS/infra (owns deploys/rollbacks), Bug-fix (sweeps Sentry overnight). Routines at 19:10, 06:30 and Mondays 09:00 CT. Meta Ads creative upload **taught by demonstration** because API verification stalled | Self-reported: CPI $15 → $1 (15×); D7 retention ~4×; >1,000 downloads in a week | E2 |
| **Multi-team pattern (Eric Zakariasson)** | Projects Manager Bot with a "Project Ops" skill creates a Notion row + channel + roster; reuse-before-create staffing; ≤6 Bots per channel; Blocked → ping human | Official guide with screenshots; author calls it experimental | E2 |
| **Design org (John Bai)** | Separate Bots for experiments, motion, repetitive Figma production, engineering questions; motion Bot iterates real production assets in a local playground | Official guide | E2 |
| **Notion task ledger + Cloud Agents (Brian Lovin)** | Each task a Notion page (progress, blockers, next step); intake from chat and routines watching email/Sentry/GitHub; implementation via Cursor Cloud Agents | Public posts; Notion amplified | E4 |
| **"Outer loop" coding (Matt Palmer)** | Bot gathers context across Slack/Notion/repo, writes a clean task, spawns a Cloud Agent → PR + screenshots + video; personal-software pattern: logic in skills/plugins/MCP, JSON data store in Git, chat as UI | Video walkthrough | E4 |
| **Community/support (Lenny Rachitsky, Cursor Community)** | Support-email drafting, job-seeker/company matching, subscription review, podcast guest briefs; community Bot answering DMs all day | Public posts | E4 |
| **Monitoring (Alex Finn)** | Bot polling AI-company accounts every 15 minutes; retention-data Bot preparing at-risk outreach | Public posts | E4 |
| **DataCamp "Scout" (Khalid Abdelaty)** | Weekly learning-plan Bot: profile rules → task → correction → skill → Monday routine; learner facts kept in `/workspace/learner-profile.md` | Transcript-level detail incl. errors and fixes | E3 |
| **Blog Pulse (Flavio Copes)** | Daily site review at 08:00 Europe/Rome: post published? RSS? deploy status? traffic vs 4-week same-weekday | Screenshots of routine + morning report | E3 |
| **One-prompt chief of staff (Debbie O'Brien)** | Bot researched the user, inspected her existing Bots, proposed a better setup | Public post | E4 |

### 7.4 Where independent testers say it is the *wrong* tool (E3)

Deterministic transformations (use code/Zapier/n8n), hard real-time paths, anything needing separate trust zones between agents, anything requiring model pinning, and open-ended high-stakes autonomy (legal, financial, production administration).

---

## 8. Connectors and integrations

### 8.1 Integration ladder (vendor guidance + tester consensus) [E1/E3]

```
structured Plugin/connector  →  official API or CLI in the shell  →  cloud browser (computer use)  →  local computer
        (most reliable, cheapest)                                                          (most reach, most fragile/expensive)
```

### 8.2 Plugins / connectors (E1)

- Connectors are surfaced as **Plugins**: Settings → Plugins → browse → Add → OAuth in browser → attach with `@` in chat. Reference a skill with `/`.
- **Account-wide**: an installed connector is available to every Bot; not isolable per Bot.
- Multiple accounts per service are supported (e.g., work and personal Gmail/Notion) — the prompt must name which account. [E3]
- API-key connectors take the key through the **secure secret request**: masked, excluded from the transcript, not shown to the model, not stored in `/workspace`. [E1/E3]
- Team policy: Grok Bot **inherits the team's Cursor connector policy** (require/restrict in Teams Marketplace → Integrations). Blocked servers show as *Disabled by team admin*. Blocking a plugin does **not** block that vendor's website — connector policy and network policy are separate layers. Provisioning connectors to members (mandatory/default-on) is not available. [E1]
- Some vendors restrict their MCP endpoints to their own administrators, producing vendor-side permission errors for regular members. [E1]

### 8.3 Event triggers (E1)

"Cursor account integrations" can start a routine from an event (Slack message, GitHub notification). They are **separate** from the Slack/GitHub plugins and may need their own connection flow. Vendor advises narrow match rules (channel + phrase) and warns against "every new message" listeners.

### 8.4 Cloud Agents (E1)

Grok Bot can delegate coding tasks to separate Cursor Cloud Agent computers under existing Cloud Agent controls; admins can disable spawning (default on). Auto Review covers these delegation launches.

### 8.5 Commerce and social connectors (E2/E3)

- **Stripe Link**: Bot researches and prepares an order; at payment it raises a *spend request* (merchant, total, description, breakdown). Each request needs explicit approval; on approval the Bot receives a secure **single-use card**. US only at launch; mobile support later.
- **X**: connecting an X account auto-provisions an X developer account; paid users get starter X API credits (separate from Grok Bot usage). Plugin id `49086599` supports search posts, timelines, trends, bookmarks. Vendor frames v1 as read-first.

### 8.6 Known connector catalogue signals (E1/E3/E4)

Officially documented Grok Bot plugin flows exist for **Neon** (deep link `grokbot://app/v1/plugin/add?id=669`) and **Coolify** (Streamable HTTP MCP at `/mcp` with bearer token; submitted via `cursor.com/marketplace/publish`; after review appears in both Cursor and Grok Bot). Vendor tooling in the wider Cursor marketplace includes Vercel, Figma, Stripe, Cloudflare, MongoDB, Railway, Chrome DevTools, and the `superpowers` skill collection. Named in official copy or guides: Salesforce, Slack, Gmail, Notion, Zendesk, Databricks, Sumble, Gong, Sentry, PostHog, Meta Ads, AppLovin, Adjust, Apple/Google Play consoles, Zoom, Google Drive, Jira, Figma, GitHub.

### 8.7 Client reach (gap)

Grok Bot reaches the user only through its desktop and mobile apps — **no inbound email, Slack, Telegram or phone channel** as a user-facing surface. [E3]

---

## 9. MCP-related extensibility — the three surfaces

### 9.1 Surface A — Grok Bot (inherits Cursor plugin + MCP system)

**What is documented (E1):**
- "Plugins" = connectors + packaged skills, installed from the Cursor marketplace via Settings → Plugins.
- Team MCP policy applies in full; the **MCP server allowlist is Enterprise-only**; there is no separate Grok Bot plugin list.
- OAuth tokens never reach the computer; Bots invoke tools without receiving them.
- Templates exclude custom MCP servers, scripts and code.

**What is observed (E3/E4):**
- Grok Bot does **not** load local plugins from `~/.cursor/plugins/local`; it loads only dashboard/marketplace-published plugins (stated in a Cursor employee's public template memory).
- Plugins found in the wild ship in Cursor's marketplace format: `.cursor-plugin/plugin.json`, `skills/*/SKILL.md`, `rules/*.mdc`, `mcp.json`; a repository root `.cursor-plugin/marketplace.json` lists plugins. Cursor also reads the newer open "Agent Plugins" layout (`plugin.json`, `mcp.json`, `skills/`) — but as of mid-August no Grok-Bot-loaded manifest carried the open spec's `$schema`.
- Community reverse-engineering reports Cursor-side agent tools named `SearchPlugins`, `InstallPlugin`, `AddMcpServer`, `AuthenticateMcpServer` (unverified; E4).
- A known Cursor plugin-cache bug: if `.cursor-plugin/plugin.json` omits an MCP entry, the materialised cache prunes `.mcp.json` and the server never registers even though the listing advertises it. Declare MCP explicitly in the manifest.

**Minimal Cursor-marketplace plugin that Grok Bot can consume (after marketplace review):**

```text
my-connector/
├── .cursor-plugin/
│   └── plugin.json
├── mcp.json
├── skills/
│   └── weekly-export/
│       └── SKILL.md
└── README.md
```

```json
// .cursor-plugin/plugin.json
{
  "name": "my-connector",
  "displayName": "My Connector",
  "version": "0.1.0",
  "description": "Structured access to My Service: list, export, reconcile.",
  "author": { "name": "Basileia Technologies", "email": "plugins@example.com" },
  "skills": "skills",
  "mcp": "mcp.json",
  "install": {
    "variables": [
      { "name": "MYSVC_URL", "description": "Instance URL, no trailing slash" },
      { "name": "MYSVC_TOKEN", "description": "Team-scoped API token", "secret": true }
    ]
  }
}
```

```json
// mcp.json
{
  "mcpServers": {
    "mysvc": {
      "url": "${MYSVC_URL}/mcp",
      "headers": { "Authorization": "Bearer ${MYSVC_TOKEN}" }
    }
  }
}
```

```markdown
<!-- skills/weekly-export/SKILL.md -->
---
name: weekly-export
description: Export last week's records from My Service and reconcile against the ledger sheet.
---
When to use: Monday routine or on request "run the weekly export".
Inputs/access: mysvc connector; read access to the ledger sheet.
Steps: 1) mysvc.list(range=last_week) 2) diff vs ledger 3) write /workspace/exports/YYYY-WW.md
Validate: row counts match; every exception has an id and link.
Return: table of exceptions + summary line.
Approvals: never write to the ledger; never email anyone.
```

### 9.2 Surface B — Grok Build (coding CLI)

Documented `grok mcp` workflow (E1):

```bash
grok mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem /path/to/dir
grok mcp add --transport http linear https://mcp.linear.app/mcp          # OAuth handled
grok mcp add --transport http api https://mcp.example.com/mcp --header "Authorization: Bearer ${API_TOKEN}"
grok mcp list | grok mcp doctor <name> | grok mcp remove <name>
```

Config lives in `~/.grok/config.toml` (`[mcp_servers.<name>]` with `command/args/env` or `url/headers`, `${VAR}` expansion, `startup_timeout_sec`, `tool_timeout_sec`); project scope via `.grok/config.toml`; tools namespaced `<server>__<tool>`; OAuth tokens in `~/.grok/mcp_credentials.json`. **Compatibility:** Grok Build also loads `~/.claude.json`, `.cursor/mcp.json` and project `.mcp.json` (disable with `[compat.claude] mcps = false` / `[compat.cursor] mcps = false`).

The official **xAI plugin marketplace** (`github.com/xai-org/plugin-marketplace`) is the catalogue **for Grok Build**, not Grok Bot. Format: `.grok-plugin/marketplace.json` (source of truth) + generated `.grok-plugin/plugin-index.json`; plugins bundle `skills/`, `commands/`, `agents/`, `hooks/hooks.json`, `.mcp.json`, `.lsp.json`, optional `plugin.json`; remote sources must pin a full 40-char commit SHA, re-verified after clone.

### 9.3 Surface C — Grok API Remote MCP Tools (E1)

Programmatically usable by any platform. Supported in the xAI native SDK, the OpenAI-compatible Responses API and the Voice Agent API. Parameters: `server_url` (required; Streamable HTTP or SSE only), `server_label`, `server_description`, `allowed_tools`. **Not supported:** `require_approval`, `connector_id`. If `allowed_tools` is omitted, every tool the server exposes is injected into context. xAI manages the connection.

```python
# grok_remote_mcp.py — minimal, production-shaped call (Python 3.11+)
import os, sys, json, logging, requests

log = logging.getLogger("grok_mcp")
API = "https://api.x.ai/v1/responses"

def ask_with_mcp(prompt: str, server_url: str, label: str, allowed: list[str] | None = None,
                 model: str = "grok-4.6", timeout: int = 120) -> dict:
    key = os.environ.get("XAI_API_KEY")
    if not key:
        raise RuntimeError("XAI_API_KEY not set")
    if not server_url.startswith("https://"):
        raise ValueError("server_url must be https")
    tool = {"type": "mcp", "server_url": server_url, "server_label": label}
    if allowed:
        tool["allowed_tools"] = allowed            # least privilege: never omit in production
    payload = {"model": model, "input": [{"role": "user", "content": prompt}], "tools": [tool]}
    r = requests.post(API, headers={"Authorization": f"Bearer {key}",
                                    "Content-Type": "application/json"},
                      json=payload, timeout=timeout)
    if r.status_code >= 400:
        log.error("xAI error %s: %s", r.status_code, r.text[:500]); r.raise_for_status()
    return r.json()

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    out = ask_with_mcp("Summarise open issues.", "https://mcp.example.com/mcp", "tracker",
                       allowed=["list_issues"])
    print(json.dumps(out, indent=2)[:2000])
```

### 9.4 Format comparison

| Aspect | Cursor marketplace plugin (Grok Bot) | xAI `.grok-plugin` (Grok Build) | Open "Agent Plugins" | Grok API remote MCP |
|---|---|---|---|---|
| Manifest | `.cursor-plugin/plugin.json` | `.grok-plugin/marketplace.json` + per-plugin `plugin.json` | root `plugin.json` (+`$schema`) | none (request-time) |
| MCP config | `mcp.json` | `.mcp.json` | `mcp.json` | `tools:[{type:"mcp"}]` |
| Skills | `skills/*/SKILL.md` | `skills/` | `skills/` | n/a |
| Other components | `rules/*.mdc` | `commands/`, `agents/`, `hooks/`, `.lsp.json` | varies | n/a |
| Distribution | Cursor Marketplace review | Git repo, SHA-pinned | any client | API call |
| Loaded by Grok Bot? | **Yes** (marketplace only) | No | Not as of Aug-2026 | Indirectly, if your platform calls the API |

---

## 10. Security, governance and operational limits

### 10.1 Approval semantics (E1)

| Control | Behaviour |
|---|---|
| Allow once / Approve once | Continue with that one action |
| Always allow | Saves a matching rule; proceeds only if Auto Review finds no other stop reason |
| Deny | Blocks the action |
| Require Approval rule | Always stops matching actions; **wins** over Always Allow |
| Approval scope | Governs the *proposed* action; **does not reverse completed work** |
| Test run | Performs **real** work (navigates, changes files, calls tools) |

Vendor-recommended blocked categories: sending messages/invitations, publishing, purchases/transfers, deleting/overwriting, permission changes, production changes, accepting legal terms.

### 10.2 Auto Review (E1)

Independent review model evaluating shell commands, plugin calls, computer-use actions, automation writes (routines/event triggers) and delegation (Cloud Agent/subagent launches) → allow / require approval / deny. Gaps stated by vendor: does not review memory writes or most settings changes; is model-based and must sit on top of deterministic controls (network policy, per-action approvals, per-user isolation). External content (web pages, plugin results, command output) is marked untrusted when presented to the model.

### 10.3 Network policy modes (Enterprise only) (E1)

| Mode | Effect |
|---|---|
| No policy | Allow all (default) |
| Allow all | Explicit allow-all |
| Defaults + team allowlist | Cursor default destinations + your list |
| Team allowlist only | Only your list + what the computer needs to function |

Destinations: domains and IP ranges with ports; no entry cap; directory-group overrides with a team lock; applied at computer (re)creation. Egress is via **shared static IPs** across all Grok Bot customers — no dedicated per-customer IPs; treat the ranges as "Grok Bot traffic", not "our traffic". No DLP hooks. Private services only via Team Setup (admin install scripts on every team computer) running Tailscale or Cloudflare Tunnel; Cursor operates no VPN/private link.

### 10.4 Identity, logging, data (E1)

| Area | Documented state |
|---|---|
| Sign-in | Cursor account; SAML 2.0 (Okta, Entra, Google Workspace, OneLogin); SSO can be required; SCIM 2.0 Enterprise-only |
| Revocation | Admin terminates member's computer (Enterprise); durable disk kept; next session gets a fresh computer; also revoke in IdP |
| Audit logs | Enterprise-only; admin/security/auth events; dashboard or SIEM stream |
| Action Recording | Enterprise-only; **off by default**; scrubbed shell commands etc.; 90-day retention in Cursor store; delivered to you only via OpenTelemetry Export (Enterprise) |
| Endpoint telemetry | None customer-facing; Team Setup can install your own tooling |
| Residency | **United States only**; written commitments via account team |
| Hosting | Cursor-hosted only; no on-prem / own-perimeter / BYO image |
| Retention | Idle hibernation; image updates preserve files; DPA: delete/return within 30 days of written direction |
| Models | No picker; serving mix may change; model allowlist enforcement **not guaranteed** (onboarding acknowledgement) |
| Training | Privacy Mode → not used for training; ZDR via provider agreements; abuse classifiers may retain flagged data |
| Certifications | Anysphere: ISO/IEC 27001 and ISO/IEC 42001 (Schellman); Grok Bot in scope; trust.cursor.com |

**Implication for South African financial-services deployments:** US-only compute, shared egress and 90-day vendor-side action logs need explicit assessment under POPIA cross-border transfer conditions (s72) and any client data-residency clauses before connecting production systems. Self-hosted replication (§12) removes this constraint.

### 10.5 The shared-computer boundary (E1, emphasised by every independent reviewer)

The documentation's own sentence: "do not use separate Bots as a security boundary." Consequences: signing into a tool for Bot A gives Bot B the session; a file Bot A writes may be read as fact by Bot B (quality drift, not only audit risk); deleting a Bot leaves files and sessions in place; teardown is a six-step manual routine (pause routines → sign out → uninstall/revoke connectors → clean `/workspace` → hide/delete Bots → account flow). Workloads needing separate credential sets need **separate Cursor users**.

### 10.6 Independently reported issues (E3/E4, dated Aug–Sep 2026)

| Issue | Status |
|---|---|
| Each Bot is one unbounded thread; no fresh-session, manual compaction or context meter | Staff-confirmed on Cursor forum |
| Weekly quota opacity; one Heavy user derived ~16.4M tokens/week; system-prompt overhead per turn | Single-user reverse engineering, unverified |
| Six-agent setup consumed ~42% of a week's allowance on day one | Single report |
| 20–21 Aug incident: shared computer stuck → all of a user's Bots down | Vendor-acknowledged per forum |
| Per-agent Chrome profiles reset daily | Single report |
| Bot allegedly wiped a production project | Single, unverified |
| Datacenter IP blocks / CAPTCHAs on some sites | Multiple testers |
| Group rooms: repetition, loops, usage burn | Multiple testers; vendor guidance to assign single owners and add a "workforce checker" Bot |

---

## 11. Competitive positioning (brief)

| Product | Environment | Persistent named agents | Cross-app computer use | Model choice | Self-host |
|---|---|---|---|---|---|
| **Grok Bot** | One managed cloud computer per user | Yes | Yes (browser + shell) | No | No |
| Claude Cowork / Claude Code | Local + managed sessions | Partial | Coding-centric | Anthropic | Partly |
| ChatGPT Work | Local Work or isolated Cloud Work; cloud browser is signed-out | Partial | Limited (no cloud sign-in/payments) | OpenAI | No |
| Hermes Agent (Nous) | Per-Bot profiles; local/Docker/SSH/Daytona/Modal | Yes ("Bot Mode", group chats, @mentions) | Yes | Any | Yes |
| OpenClaw | Your devices/infra; multi-channel (WhatsApp/Telegram/Slack/Discord) | Yes | Yes | Any | Yes |
| Notion Custom Agents | Notion workspace | Yes | Narrow | Notion | No |

Independent consensus: Grok Bot's individual capabilities are not novel; the differentiator is packaging — persistent computer + named agents + zero infrastructure — and the recurring costs are architectural (shared computer, advisory memory, quota-bundled pricing).


---

## 12. Replication architecture — Parity Reference Architecture (PRA-1)

**Goal:** reproduce every documented Grok Bot capability (C1–C22) with open components, self-hosted, while turning Grok Bot's documented gaps into deliberate design choices. Target host: an Ubuntu 24.04 VPS on a Tailscale network with an OpenAI-compatible model router already running (clawsrv / FreeLLMAPI on `:3002`).

### 12.1 Plane model

```
┌────────────── P0 CLIENTS ──────────────┐   React console (chat, approvals, noVNC "Agent Computer")
│ web · Telegram bridge · (desktop later)│   Telegram/Slack/email inbound = parity+ (Grok Bot has none)
└───────────────┬────────────────────────┘
                │ OIDC (Authentik/Keycloak) — human identity is the only identity
┌───────────────▼──── P1 CONTROL PLANE (FastAPI, Postgres, Redis) ─────────────────────────┐
│ Bot registry · conversations · routines scheduler · approvals · templates · usage meter    │
│ ┌── P4 POLICY ──────────────────────────────────────────────────────────────────────────┐ │
│ │ L1 deterministic PreToolUse hook (rules, allowlists, egress)  ⟶  authoritative       │ │
│ │ L2 independent review model (allow / require_approval / deny) ⟶ Require-Approval wins│ │
│ │ append-only hash-chained audit log → OTel export                                     │ │
│ └───────────────────────────────────────────────────────────────────────────────────────┘ │
│ ┌── P3 TOOL PLANE ─────────────────┐ ┌── P5 MEMORY ──────────────┐ ┌── P6 COLLAB ───────┐ │
│ │ Connector Broker (token vault)   │ │ per-Bot memory + compaction│ │ handoff bus        │ │
│ │ MCP client (stdio / streamable)  │ │ rolling summaries + meter  │ │ group host (2–6)   │ │
│ │ Secure Secret Intake             │ │ shared /workspace          │ │ single-owner rule  │ │
│ │ Plugin loader (Cursor + open fmt)│ │ source-of-record pointers  │ │ workforce checker  │ │
│ └──────────────────────────────────┘ └────────────────────────────┘ └────────────────────┘ │
│ ┌── P7 MODEL PLANE ── FreeLLMAPI :3002 (14 providers) · Grok API (remote MCP) · failover · serving-model log ─┐
└───────────────┬───────────────────────────────────────────────────────────────────────────┘
                │ one SANDBOX per user (parity)  ── or per Bot (isolation toggle = parity+)
┌───────────────▼──── P2 EXECUTION PLANE ───────────────────────────────────────────────────┐
│ rootless Docker (v0) → Firecracker/Kata (multi-tenant)                                    │
│ Xvfb :N per Bot screen · x11vnc → noVNC · Chromium via Playwright persistent context       │
│ shell tool (policy-hooked) · /workspace volume · egress via proxy allowlist                │
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

### 12.2 Capability parity matrix

| Grok Bot capability | PRA-1 component | Parity level |
|---|---|---|
| Persistent named Bot (name/title/description/avatar) | `bots/*.yaml` manifest + registry | = |
| One computer per user; screens per Bot | user sandbox + Xvfb display per Bot | = (+ per-Bot sandbox toggle) |
| Browser with persistent sign-ins | Playwright `launch_persistent_context(user_data_dir)` | = (+ per-Bot profile toggle) |
| `/workspace` shared files | Docker volume mounted at `/workspace` | = |
| Take-over for password/2FA/CAPTCHA | noVNC interactive mode; Bot paused; resume signal | = |
| Secure secret request | Secret Intake form → vault; transcript stores `secret://ref` only | = |
| Connectors, tokens off-computer | Connector Broker proxies MCP/HTTP calls; tokens never in sandbox | = |
| Plugins from marketplace only | Plugin loader reads Cursor-format bundles from a signed git index | = (+ local plugins allowed) |
| Skills (`/`), `@` mentions | SKILL.md library; composer parsing | = |
| Routines (schedule/event; ≤50; 20 run records; test run) | APScheduler + Redis job store; webhook triggers | = |
| Teach a task (≤10-min recording) | Playwright trace/`codegen` recording → LLM → draft SKILL.md | ≈ |
| Bot↔Bot async handoff; group chats 2–6 | Redis Streams bus; group host | = (+ attachments in group handoffs) |
| Memory | structured memory file + compaction + **visible context meter** | + |
| Approvals (Allow once/Always allow/Deny; RA wins) | Approval service; `policy/decide.py` | = |
| Auto Review | L2 reviewer via cheap model; L1 deterministic hook authoritative | + (deterministic first) |
| Network Controls | per-sandbox proxy allowlist + nftables | = (available on every plan) |
| Action Recording / audit / OTel | hash-chained JSONL + OTel exporter | = (customer-owned, no 90-day cap) |
| Templates / share links | export with redaction pass; import creates copy | = |
| Model routing, no picker | FreeLLMAPI routing **with optional pinning** and serving-model log | + |
| Data residency US-only | self-hosted (ZA/EU as chosen) | + |
| Cloud Agent delegation | delegate to Claude Code / Grok Build in a separate container | = |

### 12.3 Data model (authoritative schemas, YAML for readability)

```yaml
# schemas/bot.yaml  — Bot manifest (versioned; exported as a template with redaction)
id: string            # ulid
name: string          # cosmetic; sidebar label
title: string         # one-line job
description: string   # STANDING RULES: lane owned, refusals, sources, approval boundaries
avatar: string        # url or emoji
owner_user_id: string # human identity the Bot acts as (no bot identity exists)
isolation: enum [shared_user_sandbox, dedicated_sandbox]      # parity+ toggle
browser_profile: enum [user_shared, bot_private]              # parity+ toggle
skills: [skill_id]
connectors: [connector_id]                                    # account-wide pool, enabled per Bot
routines: [routine_id]
approval_boundaries:
  require_approval: [send_message, publish, purchase, delete, permission_change, production_change, accept_terms]
  always_allow: []                                            # narrow patterns only
memory:
  policy: advisory                                            # never authoritative
  compaction: {trigger_tokens: 120000, keep_recent_turns: 40}
limits: {max_routines: 50, run_records: 20}
version: semver
```

```yaml
# schemas/skill.yaml — SKILL.md frontmatter contract
name: string
description: string
when_to_use: string
inputs: [{name, required, source}]
access: [connector_id | "browser" | "shell"]
steps: [string]            # ordered, imperative
validate: [string]         # checks before returning
returns: string            # deliverable + path
approvals: [string]        # what must stop
failure_policy: {no_data: report_and_stop, stale_data: report_and_stop, unreachable_source: report_and_stop}
```

```yaml
# schemas/routine.yaml
id: string
bot_id: string                     # exactly one owner
trigger:
  kind: enum [cron, event]
  cron: "0 14 * * FRI"             # when kind=cron
  tz: "Africa/Johannesburg"
  event: {source: slack, match: {channel: "#customer-escalations", contains: ["needs repro"]}}  # when kind=event
skill: skill_id
inputs: {learner_file: "/workspace/learner-profile.md"}
deliverable: {path: "/workspace/readiness/{{yyyy}}-{{ww}}.md", post_summary: true}
approval_boundary: inherit_bot      # plus per-routine additions
on_missing_source: report_and_stop
notify_threshold: changes_only      # quiet run == successful run
enabled: bool
run_records: 20
```

```yaml
# schemas/approval_rule.yaml
id: string
scope: enum [personal, team]
effect: enum [require_approval, always_allow]
match: {action_class: string, tool: string?, target_regex: string?, path_prefix: string?}
# precedence: any matching require_approval → REQUIRE; else always_allow only if L2 review has no stop reason
```

```yaml
# schemas/audit_event.yaml
ts: rfc3339
actor: {user_id, bot_id}
action_class: string
tool: string
args_scrubbed: object
decision: {l1: allow|require|deny, l2: allow|require|deny, final: allow|require|deny, approver: user_id?}
result: {ok: bool, evidence: [url|path]}
prev_hash: sha256   # hash chain
```

### 12.4 Repository layout

```
oikonomos/
├── control/
│   ├── api/            bots.py chats.py routines.py approvals.py templates.py plugins.py
│   ├── policy/         l1_rules.py l2_review.py decide.py action_classes.py
│   ├── broker/         connectors.py vault.py mcp_client.py secret_intake.py
│   ├── scheduler/      routines.py run_records.py triggers/slack.py triggers/github.py
│   ├── memory/         store.py compaction.py meter.py
│   ├── collab/         handoff_bus.py group_host.py workforce_checker.py
│   ├── models/         llm_router.py (FreeLLMAPI/OpenAI-compatible, xAI Responses, failover)
│   └── audit/          log.py otel.py
├── sandbox/            Dockerfile entrypoint.sh screen.sh policy_hook.py
├── plugins/            <cursor-format bundles>  index.json (signed)
├── skills/             <name>/SKILL.md
├── clients/web/        React console (chat · approvals · noVNC)
├── clients/telegram/   Telethon bridge
├── tests/              test_policy.py test_routines.py test_handoff.py test_secrets.py
└── docs/adr/           ADR-001-l1-pretooluse.md ADR-002-shared-vs-dedicated-sandbox.md ...
```

### 12.5 Reference implementations

**(a) Policy decision — precedence identical to Grok Bot, deterministic layer authoritative**

```python
# control/policy/decide.py
from __future__ import annotations
from dataclasses import dataclass, field
from enum import Enum
import re, logging

log = logging.getLogger("policy")

class Verdict(str, Enum):
    ALLOW = "allow"; REQUIRE = "require_approval"; DENY = "deny"

# Vendor-recommended blocked categories → require approval by default
DEFAULT_REQUIRE = {"send_message", "publish", "purchase", "delete", "permission_change",
                   "production_change", "accept_terms"}

@dataclass(frozen=True)
class Action:
    action_class: str            # e.g. "shell", "browser_click", "send_message"
    tool: str                    # e.g. "gmail.send", "shell"
    target: str = ""             # url, path, recipient, command
    args: dict = field(default_factory=dict)

@dataclass(frozen=True)
class Rule:
    effect: Verdict              # REQUIRE or ALLOW (always_allow)
    action_class: str | None = None
    tool: str | None = None
    target_regex: str | None = None

    def matches(self, a: Action) -> bool:
        if self.action_class and self.action_class != a.action_class: return False
        if self.tool and self.tool != a.tool: return False
        if self.target_regex and not re.search(self.target_regex, a.target): return False
        return True

def l1_decide(a: Action, rules: list[Rule], egress_allowlist: set[str] | None) -> Verdict:
    """Deterministic layer. Never consults a model."""
    if egress_allowlist is not None and a.action_class.startswith("network"):
        host = re.sub(r"^https?://([^/]+).*$", r"\1", a.target)
        if host not in egress_allowlist:
            log.warning("egress denied host=%s", host); return Verdict.DENY
    matched = [r for r in rules if r.matches(a)]
    if any(r.effect == Verdict.REQUIRE for r in matched):        # Require-Approval always wins
        return Verdict.REQUIRE
    if a.action_class in DEFAULT_REQUIRE and not any(r.effect == Verdict.ALLOW for r in matched):
        return Verdict.REQUIRE
    if any(r.effect == Verdict.ALLOW for r in matched):
        return Verdict.ALLOW
    return Verdict.ALLOW

def final_decide(l1: Verdict, l2: Verdict) -> Verdict:
    """Combine deterministic L1 with model-based L2 (advisory-to-enforcing)."""
    if Verdict.DENY in (l1, l2): return Verdict.DENY
    if Verdict.REQUIRE in (l1, l2): return Verdict.REQUIRE   # always_allow proceeds only if L2 has no stop reason
    return Verdict.ALLOW
```

```python
# tests/test_policy.py
from control.policy.decide import Action, Rule, Verdict, l1_decide, final_decide

def test_require_beats_always_allow():
    a = Action("send_message", "gmail.send", "ceo@example.com")
    rules = [Rule(Verdict.ALLOW, tool="gmail.send"), Rule(Verdict.REQUIRE, action_class="send_message")]
    assert l1_decide(a, rules, None) is Verdict.REQUIRE

def test_default_blocked_category_requires_approval_without_rules():
    assert l1_decide(Action("purchase", "stripe_link.pay", "merchant.example"), [], None) is Verdict.REQUIRE

def test_narrow_always_allow_passes_l1_but_l2_can_stop():
    a = Action("shell", "shell", "git status", {"cwd": "/workspace/reports"})
    rules = [Rule(Verdict.ALLOW, tool="shell", target_regex=r"^git status$")]
    assert l1_decide(a, rules, None) is Verdict.ALLOW
    assert final_decide(Verdict.ALLOW, Verdict.REQUIRE) is Verdict.REQUIRE

def test_egress_allowlist_is_deterministic_deny():
    a = Action("network_fetch", "browser", "https://evil.example/x")
    assert l1_decide(a, [], {"jira.example.com"}) is Verdict.DENY
```

**(b) Routine scheduler — timezone-aware, no-data policy, 20 run records, test run = real run**

```python
# control/scheduler/routines.py
from __future__ import annotations
import logging, datetime as dt
from collections import deque
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger

log = logging.getLogger("routines")
RUN_RECORDS = 20

class Routine:
    def __init__(self, rid: str, bot_id: str, cron: str, tz: str, skill, inputs: dict,
                 on_missing_source: str = "report_and_stop"):
        self.id, self.bot_id, self.cron, self.tz = rid, bot_id, cron, tz
        self.skill, self.inputs, self.on_missing_source = skill, inputs, on_missing_source
        self.records: deque = deque(maxlen=RUN_RECORDS)   # parity: keep 20 most recent
        self.enabled = True

    def run(self, *, test: bool = False) -> dict:
        """A test run performs REAL work (parity). Callers must use safe inputs."""
        started = dt.datetime.now(dt.timezone.utc)
        rec = {"started": started.isoformat(), "test": test, "status": "running"}
        try:
            missing = [k for k, v in self.inputs.items() if not self.skill.source_available(v)]
            if missing:
                if self.on_missing_source == "report_and_stop":
                    rec.update(status="stopped", reason=f"missing sources: {missing}")
                    log.warning("routine %s stopped: %s", self.id, rec["reason"]); return rec
            out = self.skill.execute(self.inputs, bot_id=self.bot_id)    # approvals raised inside
            rec.update(status="ok", deliverable=out.get("path"), evidence=out.get("evidence", []))
        except PermissionError as e:                     # approval pending → explicit state, no retry loop
            rec.update(status="awaiting_approval", detail=str(e))
        except Exception as e:                           # explicit failure state, never stale data
            rec.update(status="failed", detail=repr(e)); log.exception("routine %s failed", self.id)
        finally:
            rec["ended"] = dt.datetime.now(dt.timezone.utc).isoformat(); self.records.append(rec)
        return rec

class RoutineScheduler:
    def __init__(self):
        self.s = BackgroundScheduler(); self.s.start()
    def add(self, r: Routine):
        trig = CronTrigger.from_crontab(r.cron, timezone=r.tz)
        self.s.add_job(r.run, trig, id=r.id, replace_existing=True, misfire_grace_time=3600)
    def pause(self, rid): self.s.pause_job(rid)
    def resume(self, rid): self.s.resume_job(rid)
    def delete(self, rid): self.s.remove_job(rid)          # immediate, no undo (parity)
```

**(c) MCP client behind the Connector Broker — tokens injected server-side, allowlisted tools only**

```python
# control/broker/mcp_client.py   (works with mcp 1.x and mcp 2.x; Python 3.11+)
from __future__ import annotations
import asyncio, logging
from mcp import ClientSession

log = logging.getLogger("broker.mcp")

try:                                    # mcp >= 2.0: headers travel on an httpx client
    from mcp.client.streamable_http import streamable_http_client, create_mcp_http_client
    def _transport(url: str, headers: dict):
        return streamable_http_client(url, http_client=create_mcp_http_client(headers=headers))
except ImportError:                     # mcp 1.x: headers are a keyword argument
    from mcp.client.streamable_http import streamablehttp_client
    def _transport(url: str, headers: dict):
        return streamablehttp_client(url, headers=headers)

class BrokeredMCP:
    """Runs in the control plane, never in the sandbox. Sandbox sees only tool names + results."""
    def __init__(self, url: str, token_ref: str, vault, allowed_tools: set[str]):
        self.url, self.token_ref, self.vault, self.allowed = url, token_ref, vault, allowed_tools

    async def call(self, tool: str, arguments: dict) -> dict:
        if tool not in self.allowed:
            raise PermissionError(f"tool {tool} not in allowlist")
        headers = {"Authorization": f"Bearer {self.vault.reveal(self.token_ref)}"}   # never logged
        async with _transport(self.url, headers) as streams:
            read, write = streams[0], streams[1]                # 1.x yields 3-tuple, 2.x yields 2-tuple
            async with ClientSession(read, write) as session:
                await session.initialize()
                names = {t.name for t in (await session.list_tools()).tools}
                if tool not in names:
                    raise LookupError(f"server does not expose {tool}")
                res = await session.call_tool(tool, arguments)
                log.info("mcp call ok tool=%s", tool)
                is_err = getattr(res, "is_error", getattr(res, "isError", False))   # 2.x vs 1.x
                return {"content": [c.model_dump() for c in res.content], "is_error": bool(is_err)}

if __name__ == "__main__":
    class _Vault:                                   # replace with age/SOPS/Vault-backed store
        def reveal(self, ref): import os; return os.environ["DEMO_TOKEN"]
    c = BrokeredMCP("https://mcp.example.com/mcp", "secret://demo", _Vault(), {"list_issues"})
    print(asyncio.run(c.call("list_issues", {"state": "open"})))
```

**(d) Sandbox image — one screen per Bot, live view, persistent browser profile**

```dockerfile
# sandbox/Dockerfile
FROM mcr.microsoft.com/playwright/python:v1.55.0-noble
RUN apt-get update && apt-get install -y --no-install-recommends xvfb x11vnc novnc websockify fluxbox \
 && rm -rf /var/lib/apt/lists/*
RUN useradd -m -u 10001 bot && mkdir -p /workspace && chown bot:bot /workspace
COPY sandbox/screen.sh /usr/local/bin/screen.sh
COPY sandbox/policy_hook.py /opt/policy_hook.py
USER bot
VOLUME ["/workspace", "/home/bot/.profiles"]
ENTRYPOINT ["/usr/local/bin/screen.sh"]
```

```bash
#!/usr/bin/env bash
# sandbox/screen.sh — start N virtual screens (one per Bot) with a noVNC endpoint each
set -euo pipefail
SCREENS="${SCREENS:-3}"                    # parity: several Bots in parallel, one task per screen
for i in $(seq 1 "$SCREENS"); do
  Xvfb ":$i" -screen 0 1440x900x24 -nolisten tcp &
  DISPLAY=":$i" fluxbox >/dev/null 2>&1 &
  x11vnc -display ":$i" -rfbport "$((5900+i))" -nopw -forever -shared -quiet &
  websockify --web=/usr/share/novnc "$((6080+i))" "localhost:$((5900+i))" >/dev/null 2>&1 &
done
wait
```

```python
# sandbox/browser.py — persistent context per user (parity) or per Bot (isolation toggle)
from playwright.sync_api import sync_playwright
def open_browser(profile: str, display: str):
    import os; os.environ["DISPLAY"] = display
    p = sync_playwright().start()
    ctx = p.chromium.launch_persistent_context(f"/home/bot/.profiles/{profile}", headless=False,
                                                args=["--no-first-run", "--disable-dev-shm-usage"])
    return p, ctx     # cookies/sessions persist across runs → "sign in once"
```

**(e) Teach-by-demonstration → draft skill**

1. Human takes over the Bot's screen (noVNC) with Playwright **tracing on** (`context.tracing.start(screenshots=True, snapshots=True)`), capped at 10 minutes, no audio.
2. Stop → `trace.zip` + action log (selectors, URLs, typed text with secret fields redacted at capture time via a deny-list of `input[type=password]`, OTP patterns).
3. LLM converts the action log into a **draft** `SKILL.md` using the §12.3 contract; the draft is flagged `status: draft` until the human adds decision rules, failure handling and approvals, and one test run on a different input passes.

**(f) Group host — bounded wake-ups, single owner**

```python
# control/collab/group_host.py (excerpt)
MAX_MEMBERS = 6
def route(message, members, llm):
    tagged = [m for m in members if f"@{m.name}" in message.text]
    if tagged: return tagged                                   # explicit owner(s)
    if "@everyone" in message.text: return members
    # implicit: one cheap classification per member, then exactly ONE responder
    scores = {m.id: llm.score_should_respond(m.description, message.text) for m in members}
    best = max(scores, key=scores.get)
    return [m for m in members if m.id == best]                # parity+: no committee chatter
```

### 12.6 Verification log (code in §12.5 was executed, not just written)

| Check | Result (2026-09-05, Python 3.12, Ubuntu 24.04) |
|---|---|
| `pytest tests/test_policy.py` | 4 passed — Require-Approval beats Always-Allow; default blocked categories require approval; L2 can stop an L1-allowed action; egress allowlist denies deterministically |
| Scheduler smoke | `0 14 * * FRI` @ `Africa/Johannesburg` → next fire `2026-09-11 14:00+02:00`; run records capped at 20 after 25 runs; missing source → `stopped` with reason |
| MCP broker end-to-end | Local streamable-HTTP MCP server (`mcp` 2.1.1, `MCPServer`) behind a bearer-checking ASGI wrapper: allowlisted `list_issues` returned data; `delete_issue` blocked by allowlist before any network call; wrong token rejected by server (401) |
| SDK compatibility | Client adapts to `mcp` 1.x (`streamablehttp_client(url, headers=…)`, `res.isError`) and 2.x (`streamable_http_client(url, http_client=create_mcp_http_client(headers=…))`, `res.is_error`) |
| Static checks | All Python modules compile; `bash -n sandbox/screen.sh` OK; 54 code fences balanced; 0 malformed tables |

### 12.7 Threat-model deltas vs Grok Bot

| Risk in Grok Bot | PRA-1 mitigation |
|---|---|
| Cross-Bot session/file bleed on one computer | `isolation: dedicated_sandbox` and `browser_profile: bot_private` per Bot when the job needs it; `/workspace/shared` vs `/workspace/<bot>` convention |
| Model-based review as a primary gate | L1 deterministic hook is authoritative (ADR-001); L2 advisory→enforcing; both logged |
| Prompt injection via web/tool output | untrusted-content tagging + L1 category rules + egress allowlist + no tokens in sandbox |
| Opaque quota | per-Bot, per-routine token/step metering exposed in UI; hard caps per routine |
| Unbounded context | compaction with retained recent turns; context meter; "fresh session" action |
| US-only residency | host in-region; data map for POPIA |
| One stuck computer takes all Bots down | health checks per sandbox; per-Bot sandbox option; automated recover |

---

## 13. Roadmap (12 weeks) and OIKONOMOS / clawsrv alignment

### 13.1 Phases and acceptance criteria

| Phase | Weeks | Scope | Exit criteria (tests) |
|---|---|---|---|
| **0 Foundations** | 1 | Repo, ADRs, schemas (§12.3), sandbox image, policy engine, audit log | `pytest tests/test_policy.py` green; sandbox boots with 3 screens visible in noVNC; audit chain verifies |
| **1 Single Bot loop** | 2–3 | Chat → plan → tools (shell/browser/files) → approvals → transcript; memory v0; context meter | Release-Readiness Reviewer runs read-only end-to-end on sandboxed Jira/Confluence; any write stops at approval; approval card shows exact command |
| **2 Skills & routines** | 4–5 | SKILL.md library, `/` and `@`, cron+event routines, test run, 20 records, teach-by-demo draft | Weekly routine fires with client offline; missing source → `stopped` with reason; recorded demo → draft skill → passes on a second input |
| **3 Connectors & MCP** | 6–7 | Connector Broker, vault, secure secret intake, MCP client, Cursor-format plugin loader, egress allowlist | `grep -r TOKEN` inside sandbox returns nothing; blocked domain denied at L1; plugin bundle from `plugins/` installs and its MCP tools appear |
| **4 Multi-Bot** | 8–9 | Handoff bus, group rooms (2–6), single-owner routing, workforce checker, per-Bot isolation toggle | Research→Review→Edit pipeline completes via file handoffs; wake-ups ≤ members×1 per message; dedicated-sandbox Bot cannot read another Bot's profile |
| **5 Templates & channels** | 10 | Template export/import with redaction, signed marketplace index, Telegram bridge | Exported template contains no secrets/internal URLs (automated scan); import creates independent copy; Telegram message reaches a Bot and returns an approval card |
| **6 Governance** | 11–12 | OIDC SSO, team rules, L2 team instructions, OTel export, usage dashboard, POPIA data map | SSO-only login enforced; team block instruction stops a production change; OTel events land in collector; residency documented |

### 13.2 Deliberate differentiators (where to beat, not match)

1. **Isolation as a dial** — shared sandbox for cheap handoffs, dedicated sandbox per Bot for client tenants; Grok Bot cannot offer the second.
2. **Deterministic L1 first** — ADR-001's PreToolUse hook is the enforcement layer; the review model advises. Grok Bot inverts this emphasis.
3. **Context hygiene** — compaction, fresh-session, and a visible meter (staff-confirmed gaps in Grok Bot).
4. **Transparent metering** — per-Bot/per-routine tokens and steps; hard caps; no opaque weekly allowance.
5. **Reach** — Telegram/Slack/email inbound and outbound (Grok Bot: apps only).
6. **Model choice with failover logging** — FreeLLMAPI routing, optional pinning per Bot; Grok Bot has no picker and does not guarantee allowlist enforcement.
7. **Residency and audit ownership** — self-hosted, in-region, unlimited retention under your control (Grok Bot: US-only, 90-day vendor-side Action Recording).

### 13.3 Alignment with the OIKONOMOS build and the clawsrv estate

| OIKONOMOS / clawsrv element | Grok Bot counterpart | Action |
|---|---|---|
| ADR-001: PreToolUse hook as L1 enforcement | Deterministic controls (network policy, per-action approvals, per-user isolation) beneath model-based Auto Review | Keep L1 authoritative; add L2 reviewer with Grok Bot's exact precedence rule (Require-Approval wins; Always-Allow only if L2 has no stop reason) — see `decide.py` |
| Basileia-accounts-only scope constraint | "A Bot has no identity of its own; acts as the signed-in member" | Document as parity posture; model team-managed connectors as the single exception, mirroring Grok Bot |
| clawsrv Ubuntu 24.04 + Tailscale | Team Setup installs Tailscale/Cloudflare Tunnel to reach private services (Enterprise only) | Sandboxes join the tailnet via sidecar; you already have the private-network path Grok Bot reserves for Enterprise |
| FreeLLMAPI on `:3002` aggregating 14 providers | Cursor-managed routing with failover; usage analytics show serving model | Add per-request serving-model + failover logging to the router; expose per-Bot pinning |
| OpenClaw on clawsrv | Community "OpenGrokBot" assembles a Grok Bot alternative from OpenClaw + BYO model | Evaluate OpenClaw as the **channel + browser tool adapter** for P0/P2 instead of building channel bridges from scratch; keep policy/broker/scheduler in OIKONOMOS |
| 128-ticket WBS | §12.2 parity matrix (22 rows) | Diff every row against the WBS; any row without a ticket is a gap; any ticket not mapping to a row is scope to defend |
| DEVDepartment multi-agent framework | Cloud Agent delegation, "outer loop" pattern | Position OIKONOMOS Bots as the outer loop; DEVDepartment/Claude Code as the inner coding loop, exactly as Grok Bot delegates to Cloud Agents |

### 13.4 Ticket-level parity checklist (to diff against the WBS)

```
P-01 Bot manifest (name/title/description/avatar) + registry         P-12 Secure secret intake (masked, out-of-transcript)
P-02 Per-user sandbox with durable /workspace                        P-13 Connector Broker; tokens never in sandbox
P-03 Per-Bot virtual screen + live view + take-over                  P-14 MCP client (stdio + streamable HTTP) with tool allowlist
P-04 Persistent browser profile (user-shared / bot-private)          P-15 Plugin loader: Cursor .cursor-plugin + open Agent Plugins
P-05 Shell tool behind PreToolUse hook                               P-16 Egress allowlist per sandbox (4 modes)
P-06 Approvals: allow-once / always-allow / deny; RA wins            P-17 Bot↔Bot async handoff bus
P-07 L2 review model with team allow/block instructions              P-18 Group rooms 2–6; single-owner routing; @everyone
P-08 Skills library (SKILL.md contract); `/` reference                P-19 Memory: advisory store + compaction + context meter
P-09 Routines: cron+tz, event triggers, test run, 20 records, pause   P-20 Templates: export with redaction; import as copy; index
P-10 Teach-by-demonstration → draft skill (≤10 min, no audio)         P-21 Audit: hash-chained log + OTel export; usage metering
P-11 Local-execution policy (ask / always / never)                    P-22 SSO/OIDC, team rules, SCIM (later), residency data map
```

---

## 14. Open questions and unverifiable claims

| Item | Status | Why it matters |
|---|---|---|
| Numeric weekly allowances per plan | Not published; one E4 estimate (~16.4M tokens/week, Heavy) | Cost modelling for OIKONOMOS pricing |
| Internal orchestration (planner/executor split, screen implementation) | Not disclosed; third-party diagrams are conceptual | Parity claims are behavioural, not structural |
| Whether "screens" are X displays vs browser contexts | Not documented | Affects how faithfully §12.5(d) mirrors the original |
| Migration of Grok Bot plugins to the open Agent Plugins spec | Cursor reads both; no Grok-Bot-loaded manifest carried `$schema` as of mid-Aug | Plugin portability for a marketplace strategy |
| Enterprise GA and org-wide enable switch timing | "Rolling out"; waitlist | Enterprise competitive window |
| Android and Linux desktop | Listed as supported in the 2 Sep FAQ; late-Aug testers reported neither | Verify in-app before citing |
| Cursor-side tool names (`SearchPlugins`, `InstallPlugin`, `AddMcpServer`, `AuthenticateMcpServer`) | Community reverse engineering only | Do not build against them |
| Production-wipe anecdote | Single unverified forum post | Cite only as a risk category, not an event |

---

## 15. Source register

| # | Source | Type / grade | Date |
|---|---|---|---|
| S1 | https://x.ai/bot — product page (pricing cards, FAQs, Cursor download/sales links) | E1/E2 | fetched 2026-09-05 |
| S2 | https://x.ai/news/introducing-grok-bot — launch post | E2 | 2026-08-11 |
| S3 | https://docs.x.ai/grok-bot/overview | E1 | updated 2026-09-03 |
| S4 | https://docs.x.ai/grok-bot/bots — Create and manage Bots | E1 | 2026-08-22 |
| S5 | https://docs.x.ai/grok-bot/chat-and-collaboration | E1 | 2026-09-02 |
| S6 | https://docs.x.ai/grok-bot/computer-and-apps | E1 | 2026-08-11 |
| S7 | https://docs.x.ai/grok-bot/skills-routines-and-automations | E1 | 2026-08-11 |
| S8 | https://docs.x.ai/grok-bot/approvals-security-and-privacy | E1 | 2026-09-02 |
| S9 | https://docs.x.ai/grok-bot/security | E1 | 2026-09-03 |
| S10 | https://docs.x.ai/grok-bot/teams-and-enterprises | E1 | 2026-09-03 |
| S11 | https://docs.x.ai/grok-bot/faq | E1 | 2026-09-02 |
| S12 | https://cursor.com/docs/grok-bot — Cursor-side docs | E1 | fetched 2026-09-05 |
| S13 | https://x.ai/bot/guides (5 guides: multi-team, mobile dev, design, GTM, PMs) | E2 | 2026-08-15…27 |
| S14 | https://x.ai/bot/guides/how-i-run-multiple-teams-of-grok-bots — E. Zakariasson | E2 | 2026-08-27 |
| S15 | https://x.ai/bot/guides/grok-bot-for-mobile-app-development — R. Perry | E2 | 2026-08-25 |
| S16 | https://x.ai/bot/marketplace (+ /bots/projects-manager, /bots/tinkabot) | E2 | fetched 2026-09-05 |
| S17 | https://x.ai/bot/use-cases — 56 use cases | E2 | fetched 2026-09-05 |
| S18 | https://x.ai/news/grok-bot-and-x — X connector | E1/E2 | 2026-08-29 |
| S19 | https://docs.x.ai/developers/tools/remote-mcp — Grok API Remote MCP Tools | E1 | 2026-07-21 |
| S20 | https://docs.x.ai/build/features/mcp-servers — Grok Build MCP | E1 | 2026-07-02 |
| S21 | https://github.com/xai-org/plugin-marketplace — `.grok-plugin` format (Grok Build) | E1 | fetched 2026-09-05 |
| S22 | https://github.com/cursor/plugins — Cursor plugin specification | E1 | fetched 2026-09-05 |
| S23 | https://neon.com/docs/ai/ai-grok-bot-plugin ; https://github.com/coollabsio/coolify-cursor-plugin | E1 (vendor) | 2026-08 |
| S24 | https://github.com/vercel/vercel-plugin/issues/125 — MCP manifest pruning bug | E3 | 2026-08 |
| S25 | https://flaviocopes.com/grok-bot/ — deep dive with screenshots | E3 | 2026-08-22, upd. 08-30 |
| S26 | https://www.datacamp.com/tutorial/grok-bot-tutorial — hands-on build | E3 | 2026-08-27 |
| S27 | https://composio.dev/content/guide-to-frok-bot — conceptual architecture | E3 | 2026-08 |
| S28 | https://www.vellum.ai/blog/official-grok-bot-breakdown ; https://www.eesel.ai/blog/grok-bot-review | E3 | 2026-08 |
| S29 | https://cellcog.ai/blog/grok-bot-problems/ ; /grok-bot-security/ ; /is-grok-bot-worth-it/ | E3/E4 | 2026-08 |
| S30 | https://www.llmrumors.com/news/grok-bot-product-agents-authority-backlash | E3 | 2026-09-02 |
| S31 | https://nervegna.substack.com/p/grok-bot-for-designers-and-product | E3 | 2026-08-31 |
| S32 | https://9to5mac.com/2026/08/14/… — acquisition close; https://thenextweb.com/news/spacexai-grok-bot-ai-agents-cursor ; https://runtimewire.com/article/cursor-spacexai-launch-grok-bot-general-purpose-agents ; https://www.trendingtopics.eu/grok-bot-spacexai/ | E3 (press) | 2026-08 |
| S33 | https://www.digitalapplied.com/blog/grok-bot-cursor-tier-gating-spacex-anysphere-deal-2026 ; https://roo.beehiiv.com/p/grok-bot-cursor-infrastructure | E3 | 2026-08 |
| S34 | https://en.wikipedia.org/wiki/SpaceXAI | E3 | fetched 2026-09-05 |
| S35 | https://github.com/ZeroPointRepo/awesome-grok-bot — community catalogue | E4 | 2026-08 |
| S36 | https://x.com/ArchiveExplorer/article/2092228964253069759 — long-form community analysis | E4 | 2026-08 |

*End of report.*
