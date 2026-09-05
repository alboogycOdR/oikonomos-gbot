# OIKONOMOS Grok Bot Parity Disposition v1.0 — decompose input for Wave "Chat-3 / Office-1"

Written 2026-09-05 (ORCH, research session). Dispositions every capability
from the two 2026-09-05 Grok Bot research reports against the live codebase
and PLAN.md, so the next `/devteam-decompose` starts from decided scope
rather than re-reading 90 pages.

Sources dispositioned:

- `docs/research/grok-bot-technical-report-and-replication-blueprint-2026-09-05.md`
  — §4 capability inventory C1–C22, §12.2 parity matrix, §13.4 checklist
  P-01…P-22, §13.2 differentiators.
- `docs/research/grok-bot-technical-report-2026-09-05.pdf` — §2.1 runtime
  table, §8.2 component mapping, §8.4 identity pack.
- Prior dispositions this one does **not** repeat: `docs/STUDY-grok-bot-018.md`
  (governance internals — all TASKed or COVERED) and
  `docs/research/grok-bot-live-probe-2026-09-01.md` (box durability → ADR-010).

Precedence: sits alongside `OIKONOMOS_CHAT_SURFACE_v1.0.md`; overrides no ADR.
Where a row touches enforcement it defers to ADR-001/ADR-010 unchanged.

Statuses (same vocabulary as STUDY-018):
**HAVE** (built, cite package/task) · **IN-FLIGHT** (open TASK) ·
**GAP → G-nn** (proposed task, specified in §3) · **DEFER** (real, wave not
arrived, reason given) · **CONVENTION** (apply in reviews/specs, not a work
item) · **REJECT** (deliberately not doing, reason given).

---

## 1. Disposition table — 22 parity rows (report §12.2, merged with C1–C22 and P-01…P-22)

| # | Grok Bot capability | P-ref | Disposition | Evidence / note |
|---|---|---|---|---|
| 1 | Persistent named Bot: name, title, description, avatar | P-01 | **HAVE** | `packages/db` roles (TASK-084); persona via `systemPrompt` (TASK-156); title/instructions in API + mobile (TASK-165); conversational rename (TASK-167). Avatar upload: DEFER (Chat-2 list, cosmetic). |
| 2 | One computer per user, screens per Bot; durable `/workspace` | P-02 | **IN-FLIGHT** | Sandbox substrate: TASK-169 (unblocked by the exec-API resolution, re-scope in `docs/research/opensandbox-exec-api-gap-2026-09-05.md`) → TASK-170. Workspace paths + durability tiers: `services/workspace` (TASK-090). **Decision carried in:** one sandbox per role, `pause` on idle (ADR-010). |
| 3 | Per-Bot virtual screen + live view + take-over | P-03 | **IN-FLIGHT / GAP** | Live view: TASK-171 — design against execd PTY viewer mode. Take-over (human drives the Bot's browser for password/2FA/CAPTCHA): **GAP → G-07**, blocked on the browser lane (row 4). |
| 4 | Persistent browser profile (user-shared / bot-private) | P-04 | **GAP → G-06** | Steel Browser is decided (ADR-006 B) but no code references it. Nothing in the product can click a website today. |
| 5 | Shell tool behind PreToolUse hook | P-05 | **HAVE** (host) / **IN-FLIGHT** (sandbox) | Broker hook is the enforcement point (ADR-001, TASK-052/093). Inside-sandbox gating is an explicit AC on TASK-170 with liveness assertion. |
| 6 | Approvals: allow-once / always-allow / deny; Require-Approval wins | P-06 | **HAVE** | `packages/approvals` (TASK-013/014/062/080/065), four-way standing-mode resolution (TASK-081), require-approval precedence (TASK-086), inline ApprovalCard + Always Allow (TASK-109/118/123), mobile approvals (TASK-148). |
| 7 | L2 review model + team allow/block instructions | P-07 | **DEFER** | Grok Bot's "Auto Review" is a *model* gate on top of deterministic controls. Our L1 is authoritative and complete; an advisory L2 reviewer adds cost per action for marginal safety at single-tenant scale. Revisit at Teams (row 22). Documented as a deliberate inversion in report §13.2 item 2. |
| 8 | Skills library (`SKILL.md` contract), `/` invocation, enable-per-Bot | P-08 | **GAP → G-01** | Nothing exists. Routines currently bind to a prompt string, not to a reusable, validated procedure. Highest-leverage gap: it is the unit that routines, teach-by-demo, and templates all compose from. |
| 9 | Routines: cron + tz, event triggers, test run, 20 run records, pause | P-09 | **HAVE** (core) / **GAP → G-02** (parity semantics) | pg-boss firing (TASK-132), cron scheduling (TASK-134), run history (TASK-159), mobile create UI (TASK-158), per-routine budgets (TASK-143). Missing: event triggers (connector-sourced), "test run", `on_missing_source: report_and_stop`, ≤50/Bot cap, 20-record retention, pause/resume. |
| 10 | Teach-by-demonstration → draft skill (≤10 min, no audio) | P-10 | **DEFER** | OIK-113/114 epic; TASK-142 was its first slice. Depends on G-01 (skills) and G-06 (browser lane with tracing). Not before Office-2. |
| 11 | Local-execution policy (ask / always / never; default ask) | P-11 | **REJECT** (for now) | Requires a desktop client that can run commands on the user's own machine. We ship web + mobile + Telegram; no desktop agent is planned this quarter. ADR-010 Amendment already fixes the policy ("ask every time") for when one exists. |
| 12 | Secure secret intake (masked, out-of-transcript, `secret://` ref) | P-12 | **HAVE** (storage) / **GAP → G-05** (intake UX) | D3 sealed-secret path guard (TASK-088/093/097), `secret://` resolver convention (connectors, sandbox-client). Missing: a chat-side "the bot asks for a key → masked form → vault → ref in transcript" flow. Today a user who pastes an API key into chat puts it in the transcript. |
| 13 | Connector Broker; tokens never in sandbox | P-13 | **HAVE** | Manifest → capabilities → grants pipeline (TASK-043/044/113/114), session minters with headless OAuth (TASK-083/127/137/138), N-connector mounting (TASK-139/146), durable session pool (TASK-092). TASK-170 must preserve "no token reaches the sandbox" — carried as AC. |
| 14 | MCP client (stdio + streamable HTTP) with tool allowlist | P-14 | **HAVE** | Live MCP mount + `allowedTools` from manifest (TASK-052/054), call-time re-check (TASK-066 lineage), loopback bridge for CLI harnesses (TASK-079). |
| 15 | Plugin loader: Cursor `.cursor-plugin` + open Agent Plugins format | P-15 | **REJECT** | Our unit of extensibility is the connector manifest (ADR-008/013, protected path, tier-declaring). Loading third-party plugin bundles would bypass the manifest review that decides governed tiers. If a marketplace ever matters, it is a *manifest* marketplace. |
| 16 | Egress allowlist per sandbox (4 modes) | P-16 | **GAP → G-08** | OIK-045b (pulled forward by ADR-006 B) has no task. Becomes load-bearing the moment TASK-170 runs untrusted commands; pairs with the deferred TASK-027 host-firewall remedy, whose trigger fires with TASK-170. |
| 17 | Bot↔Bot async handoff bus | P-17 | **HAVE** | Handoff mailbox (TASK-090/099), `sendToRole` broker tool (TASK-131), live two-role demo (TASK-141), mobile handoff chips (TASK-160). |
| 18 | Group rooms 2–6, single-owner routing, `@everyone`, workforce checker | P-18 | **HAVE** (rooms) / **GAP → G-04** (routing discipline) | Group threads schema/API/UI/compose (TASK-120/121/122/125/126). Missing: the *exactly-one-responder* routing rule (report §12.5 f) and a member cap — the documented fix for Grok Bot's committee-chatter usage burn. |
| 19 | Memory: advisory store + **compaction + visible context meter + fresh session** | P-19 | **HAVE** (store) / **GAP → G-03** (hygiene) | `packages/memory`: three scopes, three tiers, conflict order, ACL + versioning (TASK-085/098). Missing: per-thread context compaction, a visible context meter, and a "fresh session" action. Staff-confirmed Grok Bot gap; cheapest differentiator on the list. |
| 20 | Templates: export with redaction, import as copy, signed index | P-20 | **DEFER** | Needs G-01 (skills) to have anything worth exporting beyond a description. Office-2. |
| 21 | Audit: hash-chained log + OTel export; usage metering | P-21 | **HAVE** (audit, metering) / **DEFER** (OTel) | Append-only audit + redaction + outbox (TASK-011/012/077); budgets and spend ceiling (TASK-143), SDK-path cost tracking IN-FLIGHT (TASK-163). OTel export: DEFER until a customer needs a SIEM feed. Hash-chaining: CONVENTION — verify the append-only trigger in migration 002 remains the tamper control; do not add a second mechanism. |
| 22 | SSO/OIDC, team rules, SCIM, residency data map | P-22 | **HAVE** (auth) / **DEFER** (teams) | Real per-user auth: backend TASK-172 done, mobile TASK-173 in flight. Team rules / SCIM: DEFER to a Teams wave. Residency: CONVENTION — self-hosted on clawsrv already satisfies it; record in the POPIA note when one is written. |

### Rows from the reports that are not in the 22-row matrix

| Capability | Disposition | Note |
|---|---|---|
| Model routing without a picker, failover, serving-model log (C22) | **HAVE** / **CONVENTION** | Multi-provider (ADR-011; Gemini/Codex/Grok providers TASK-094/095/143). We deliberately *do* expose a per-role model choice (report §13.2 item 6). Serving-model + failover must be logged per run — verify during TASK-163 review. |
| Multi-channel reach: Telegram/Slack/email inbound (§8.7 gap in Grok Bot) | **HAVE** (Telegram) / **DEFER** (Slack, email) | `services/gateway-telegram` (TASK-057/058/059). Others wait for demand. |
| Stripe Link purchasing with per-payment approval (C18) | **REJECT** | Spend is on the enforced hard-stop line (ADR-010 Amendment). A bot never holds a card, single-use or otherwise. |
| Native X connector (C19) | **REJECT** | Not a Basileia-owned account class we operate; no demand. |
| Cloud Agent delegation for coding (C15) | **CONVENTION** | Already our operating model: OIKONOMOS bots are the outer loop, DEVDEPARTMENT/Claude Code the inner loop (report §13.3). No product feature needed. |
| Attachments (chat file/image) | **HAVE** | TASK-166. |
| Instruction precedence stack (report §6.1) | **CONVENTION → doc** | Write `docs/architecture/INSTRUCTION_PRECEDENCE.md` mapping the 11 layers to our mechanisms. Half a page; ORCH-authored, not a builder task. |
| Six-part Bot charter / four-artefact identity pack (report §5.3, PDF §8.4) | **CONVENTION → G-01/G-09** | The "description = standing policy, message = this task" split becomes the create-bot guidance text and the default template (G-09). |

---

## 2. What we are incorporating — the short answer

**Incorporating (in order):** Skills (G-01) · routine parity semantics (G-02) · context compaction + meter + fresh session (G-03) · single-owner group routing (G-04) · secure secret intake in chat (G-05) · browser lane via Steel (G-06) · human take-over (G-07) · per-sandbox egress allowlist (G-08) · Bot charter template on create (G-09). Plus the already-in-flight sandbox execution (TASK-169/170/171).

**Deferring:** L2 review model, teach-by-demo, templates/marketplace, OTel export, Teams/SCIM, Slack/email channels, avatar upload.

**Rejecting:** local-execution policy (no desktop client), third-party plugin-bundle loading, Stripe purchasing, X connector.

---

## 3. Proposed tasks (decompose from these; Owned_Paths are proposals for ORCH to confirm disjoint at dispatch)

Ordering rationale: G-01 first because G-02, G-09 and both DEFER items (teach, templates) compose from it; G-03 is independent and cheap — run it in parallel.

### G-01 — Skills primitive
**Spec:** report §12.3 `schemas/skill.yaml`; PDF §3.4 six-part structure.
**Scope:** `skills` table (role-scoped enable list; account-scoped library), Markdown body with frontmatter contract (`name, description, when_to_use, inputs, access, steps, validate, returns, approvals, failure_policy`), API CRUD, `/skill-name` invocation from the composer resolving to a prompt block injected *below* the role's instructions (precedence stack), and a routine may reference a `skill_id` instead of raw text.
**Owned_Paths (proposal):** `packages/db/src/skills*`, migration `NNN_skills.sql`, `services/control-api/src/skills*`, `apps/mobile/lib/**/skills*`.
**AC anchors:** a skill invoked with `/` appears in the run's system context exactly once and below the persona; a routine bound to a skill fires with that skill's body; disabled-for-this-Bot skill is not invocable from that Bot (enforced server-side, not UI-only).
**Not in scope:** teach-by-demo, marketplace, templates.

### G-02 — Routine parity semantics
**Spec:** report §12.3 `schemas/routine.yaml`, §12.5(b); PDF §3.5.
**Scope:** `on_missing_source: report_and_stop` (a routine whose declared input/connector is unavailable records `stopped` with reason, never runs on stale data); explicit **test run** ("does real work" — surfaced with that warning); pause/resume; ≤50 routines per Bot; retain 20 run records per routine (older pruned); `notify_threshold: changes_only`. Event triggers (connector-sourced, narrow match) are a **separate follow-on** — G-02b — because they need the connector event pipeline that does not exist yet.
**Owned_Paths (proposal):** `packages/db/src/routines*`, `services/worker/src/jobs/routineJob.ts`, `services/control-api/src/routines*`, mobile routines screens.
**AC anchors:** missing-source routine produces a `stopped` record and no model call (assert zero provider spend); 21st run record evicts the oldest; 51st routine rejected server-side.

### G-03 — Context hygiene: compaction, context meter, fresh session
**Spec:** report §10.6 (staff-confirmed gap), §12.3 `memory.compaction`, §13.2 item 3.
**Scope:** per-thread token accounting exposed in the API (`context_used`, `context_limit`); rolling-summary compaction when a configurable threshold is crossed (keep last N turns verbatim, summarise the rest into a tiered memory fact via `packages/memory`); a "Start fresh" action that opens a new run context while keeping the thread visible; a visible meter in the mobile header.
**Owned_Paths (proposal):** `packages/memory/src/compaction*`, `services/worker/src/chatRunDriver.ts` (context assembly only), `services/control-api/src/threads*` (meter fields), mobile chat header.
**AC anchors:** a thread driven past the threshold shows a compaction system-event and the next run's prompt size is below the threshold (measured, not inferred); nothing in a compaction summary is a sealed secret (redaction test); "Start fresh" run cannot see pre-fresh turns except through memory facts.
**Conflict note:** `chatRunDriver.ts` is also in TASK-170's Owned_Paths — sequence G-03 after TASK-170 or carve the context-assembly function into its own file first.

### G-04 — Single-owner group routing
**Spec:** report §12.5(f), §6.4 "group chatter cost", §10.6.
**Scope:** in a group thread, `@name` → that Bot; `@everyone` → all; **no mention → exactly one responder** chosen by a cheap Tier-0 classification over each member's description (FreeLLMAPI per CLAUDE.md budget rule); hard cap 6 members; per-message wake-up budget ≤ members × 1.
**Owned_Paths (proposal):** `services/worker/src/groupRouting*` (new), group-thread fan-out code from TASK-122 (ORCH to locate exact file).
**AC anchors:** an unaddressed message in a 3-Bot room produces exactly one Bot run (assert run count = 1); the classifier call is billed to the Tier-0 provider, not the role's primary model.

### G-05 — Secure secret intake from chat
**Spec:** report C13, §8.2, §12.2 row "Secure secret request"; ADR-010 Amendment (secret handling on the enforced line).
**Scope:** a broker tool `requestSecret(label, purpose)` a Bot may call; renders as an inline masked-input card (mobile + web); value goes straight to the vault, the transcript stores `secret://<ref>` only; the model never sees the value; audit records the request and fulfilment, never the value. Reuse the ApprovalCard transport (RT-01 push).
**Owned_Paths (proposal):** `packages/broker/src/tools/requestSecret*` ⚑ protected (adversarial review, different model), `services/control-api/src/secrets*`, mobile card widget.
**AC anchors:** the secret value appears in zero rows of `messages`, `audit_events`, or worker logs (grep-style negative test on a real run); the ref resolves for the connector minter that requested it and for no other role.

### G-06 — Browser lane v1 (Steel inside the sandbox)
**Spec:** ADR-006 Addendum B (Steel inside OpenSandbox); report §12.5(d) persistent profile; ADR-010 Amendment (browser-session credentials must be inaccessible to the model by construction).
**Scope:** Steel Browser running in the role's sandbox image; persistent profile per role (`bot_private` default — we are deliberately stricter than Grok Bot's shared profile); a `browser.*` capability family registered via manifest with tiers; the live viewer URL surfaced to TASK-171's monitor view. Stealth/anti-bot features **off** (NN#6).
**Owned_Paths (proposal):** `packages/connectors/manifests/steel-browser.json` ⚑ protected, sandbox image definition under `infra/sandbox/images/**`, `packages/harness-factory/src/**` (mount) ⚑ protected.
**AC anchors:** profile cookies are unreadable from a `/command` run as the agent user (Landlock/permission test, observed denial); a CAPTCHA page raises a `human_takeover_required` event rather than any solve attempt.
**Depends_On:** TASK-170.

### G-07 — Human take-over
**Spec:** report C14, §12.2 row "Take-over"; ADR-010 Amendment enforced set; PDF §2.1 "Human takeover".
**Scope:** on `human_takeover_required` (login wall, 2FA, CAPTCHA, payment page), the run parks (reuse `waiting_approval` machinery from TASK-136/155), the user gets a push + inline card with a "Take over" button opening the live view in interactive mode, and a "Hand back" action resumes the run. The model receives only "the human completed the step", never the credentials.
**Depends_On:** G-06, TASK-171.
**AC anchors:** during take-over the agent process receives no keystrokes or page content (viewer-only PTY/CDP session for the model); resume re-uses the continue-after-approval path with the same replay-window guarantees (ADR-007).

### G-08 — Per-sandbox egress allowlist
**Spec:** report §10.3 (4 modes), §12.5(a) egress deny; OIK-045b; `infra/sandbox/README.md` §7.1.
**Scope:** OpenSandbox per-sandbox network policy (or proxy + nftables if the pinned version lacks it) with modes `allow_all | defaults_plus_allowlist | allowlist_only`; policy source is the role's manifest-derived connector hosts + an explicit per-role list; deterministic deny logged as an audit event. Apply the TASK-027 `DOCKER-USER` remedy in the same task (its trigger fires here) and verify by observed refusal.
**Owned_Paths (proposal):** `infra/sandbox/**` ⚑ (infra/ci is protected; sandbox infra should be treated the same), `packages/policy/src/egress*` ⚑ protected.
**Depends_On:** TASK-170.
**AC anchors:** a `curl` from inside an `allowlist_only` sandbox to a non-listed host fails (observed), and the denial is an audit row; liveness assertion — a sandbox created with the policy deliberately absent is refused by the broker before any command runs.

### G-09 — Bot charter template on create
**Spec:** report §5.3 six-part pattern, PDF §8.4 identity pack, §4.1 three channels.
**Scope:** the create-bot flow seeds `instructions` with the six-part skeleton (job + refusals · connections · routines · skills · handoffs · "check with me before…") as placeholder text, and the bot's first turn offers to fill it in conversationally (extends TASK-167's rename pattern). No schema change.
**Owned_Paths (proposal):** mobile create-bot screen, `services/control-api` default-instructions constant.
**AC anchors:** a newly created bot's `instructions` is non-empty and contains the six headings; the OIK-129 bar ("no manifest, role YAML, or dashboard form first") still holds — the template is prose, not a form.

---

## 4. Next steps (process)

1. **Owner confirms §2** (incorporate / defer / reject lists). Anything moved from REJECT or DEFER to incorporate gets a G-nn entry before decompose.
2. **ORCH applies the TASK-169 re-scope and grounds TASK-170/171** from the OpenSandbox resolution doc — these are prerequisites for G-06/07/08, and G-03 shares a file with TASK-170.
3. **`/devteam-decompose` on `claude-opus-5`** against this document plus `OIKONOMOS_CHAT_SURFACE_v1.0.md` §8 → PLAN.md tasks. Suggested wave shape: **Office-1a** = G-01, G-03, G-04, G-09 (no sandbox dependency, four disjoint territories, dispatchable now); **Office-1b** = TASK-169 → 170 → G-08 → G-06 → G-07 (serial, security-heavy, adversarial review on every protected row); G-02 and G-05 slot into whichever wave has a free builder.
4. **ORCH writes** `docs/architecture/INSTRUCTION_PRECEDENCE.md` (CONVENTION row) — not a builder task.
5. **Pointer** added to `specs/README.md` (this file) so the decompose command finds it; the Grok Bot research docs stay in `docs/research/` as evidence, not spec.
