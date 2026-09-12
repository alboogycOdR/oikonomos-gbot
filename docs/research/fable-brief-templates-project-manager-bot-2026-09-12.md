# Brief for Fable — Templates, Project workspace, Manager/coordinator bot

**Status:** handoff brief, not a spec. Produce the specs; do not build code from this brief directly.
**Owner:** ORCH commissioned this; Fable (or Opus, per `docs/MODEL_DISCIPLINE.md`'s architectural-decision row) does the design.
**Read first:** `CLAUDE.md` (non-negotiables, protected paths, document precedence, budget), `docs/decisions/` (existing ADRs — check before proposing anything that might already be decided), `specs/OIKONOMOS_GROKBOT_PARITY_DISPOSITION_v1.0.md` (what's already built vs. deferred vs. rejected, and why), `docs/research/grok-bot-guide-study-2026-09-12.md` (why these three items were flagged as the next real product layer).

---

## The ask

Produce the design/architecture documents needed before any of this is decomposed into `PLAN.md` tasks, for three related but separable features:

1. **Templates** — packaging a bot's skills, routines, and instructions into an installable recipe another bot or user can adopt.
2. **A "Project" abstraction** — binding a channel, roster, task board, and shared artifacts together, so multi-bot work has real shared state beyond a group chat's message history.
3. **A manager/coordinator bot pattern** — one bot that delegates to specialists and tracks progress, rather than that logic living only in ORCH's own DEVDEPARTMENT orchestration layer.

Deliverable shape: real specs (following this repo's existing `specs/` convention — see `OIKONOMOS_GROKBOT_PARITY_DISPOSITION_v1.0.md` and the WBS addenda for the expected level of detail), plus an ADR for any decision that's genuinely material/cross-cutting/hard to reverse (per `CLAUDE.md`'s own rule for when an ADR is required vs. not). Do not write product code as part of this brief — the output is what ORCH decomposes into `PLAN.md` tasks next.

These three are ordered by dependency, not importance: Templates needs nothing new (skills went live in production this session, TASK-224 — the templates decision was explicitly waiting on exactly that). The Project abstraction and the manager-bot pattern both plausibly want the same underlying "shared workspace" primitive, so consider whether they're really two features or one, before designing them as two.

---

## Real constraints to design inside, not around

- **Protected paths and adversarial review.** Templates will very likely need to touch `packages/connectors/manifests/**` (a template installs granted capabilities) — that path requires review by a different model than the author, per `CLAUDE.md`. Say so explicitly in the spec rather than leaving it for whoever builds it to discover.
- **Scope boundary.** Every connector manifest carries `account_ownership: basileia` — Basileia-owned accounts only, no client/employer/third-party systems. A template that "installs an integration" must never be a path around that.
- **No credentials, ever.** In prompts, logs, audit payloads, fixtures, or — new here — **template exports**. This is the single most important lesson from the competitive research below: real-world Grok Bot templates have leaked API keys and internal URLs left in a bot's description or routine text by creators who didn't realize the "share as template" flow doesn't scrub secrets for them. Whatever OIKONOMOS ships must either mechanically strip anything secret-shaped before a template can be exported, or refuse to export a bot that has any live secret reference at all. This is not a nice-to-have; treat it as a hard acceptance criterion.
- **ADR-010's enforced set** (password/2FA/CAPTCHA/payment = human takeover, never the model) is directly relevant to the manager-bot pattern: a coordinator that can spin up new specialist bots or grant them capabilities is itself a governance-relevant action. Design what approval boundary (if any) sits between "the manager bot decides to delegate" and "a new bot/grant actually gets created" — don't leave it implicit.
- **Budget.** R350/month hard ceiling, enforced by the broker. A Project abstraction or manager-bot pattern that fans work out to many specialist bots concurrently needs to say how per-project or per-manager spend is bounded, not just how per-bot spend already is.
- **Build on what exists — don't re-invent it.** Skills (`packages/db/src/skills.ts`, wired live this session), routines (cron + parity semantics, `TASK-182`), group threads with single-owner routing (`TASK-180`), async handoffs (`TASK-131`), the task/run model (`packages/db`), and the audit log are all real and working. A Project is very likely "a view/binding over roster + group thread + tasks + a new artifacts primitive," not a parallel system. Say explicitly which existing primitives each new feature reuses vs. what's genuinely new.

---

## Templates — real competitive research (do not skip this)

Pulled live from four community sites tracking Grok Bot's own template ecosystem, 2026-09-12. Grok Bot's template feature is real, shipped, and has real adoption data — this is not speculative market research, it's an existing feature to learn from (and, per the disposition doc, potentially interop with).

### What a Grok Bot template actually is, and how it's built (from aibuilderclub.com's writeup — the most detailed source found)

- A template is a shareable blueprint of a configured bot. Publishing it produces a public link; installing from that link creates a working copy of the bot in the recipient's own account.
- **What a template carries:** the bot's identity, description, skills, and routines, plus selected memories and first-party integrations.
- **What it deliberately does NOT carry:** the user's own computer access, browser logins, conversation history, or custom MCP servers/scripts/code — those need separate setup after install.
- **Creation flow:** open the bot's settings → "Share as template" → the product auto-selects what it thinks should go in the template → the creator reviews and manually removes anything sensitive → publish (privately to a team, or publicly).
- **The real, documented failure mode:** "the link exposes the bot's configuration," including any secret left in the description or routine text — the product does not scrub this for the creator. This has genuinely happened to real users. Any OIKONOMOS design must close this gap by construction (mechanical secret-detection/refusal), not by asking the human to remember to check, since the entire point of the aibuilderclub finding is that humans don't reliably remember to check.
- **Installer-side safety guidance the product gives:** read the preview before installing, connect only the accounts actually needed with minimal scopes, run one supervised test task before trusting it, set approval boundaries before enabling any routine the template includes.
- **One-way distribution:** templates install *into* the product; there's no export path back out to a portable format. Worth an explicit decision either way for OIKONOMOS, not a silent default.

### The marketplace/ecosystem layer (rankmybot.com, grokmarket.io, grok-bot.net)

- Real scale: grokmarket.io indexes 518 templates from 378 creators; grok-bot.net indexes 332 across 9 categories (Engineering 138, Personal 114, Sales 23, Marketing 18, and others); rankmybot.com ranks by hot/top/new/rated/installs across 8 categories.
- Common categories across all three sites: Engineering, Sales, Marketing, Personal, Operations, Research/Product, Creative/Publishing.
- Consistent shape across many top templates: a **"coordinator + specialists"** pattern shows up repeatedly as a *template category in its own right*, not just as one example — "Chief of Staff" (multiple independent creators built one), "Loops" (an engineering outer-loop coordinator that hands off to coding agents — directly analogous to OIKONOMOS's own DEVDEPARTMENT pattern), "Alfred" ("designs, audits, and governs your Grok Bot organization"). This is real market validation that the manager/coordinator pattern above is worth building, not a guess.
- `grok-bot.net` documents real technical interop surfaces worth considering as prior art for an OIKONOMOS equivalent: a `grokbot://` URL protocol for one-click install, an MCP integration, a CLI (`grokbot search`, `grokbot get`), and a no-auth JSON API for the directory itself. OIKONOMOS doesn't need to copy these, but the spec should say whether an installable-link scheme and/or a JSON manifest format for a template are in scope now or explicitly deferred.
- Real recurring design patterns from the aibuilderclub writeup's "pre-templating" era, worth stealing regardless of template mechanics: **"interview once, reuse the answers every run"** (a bot's first-run setup shouldn't repeat), **"keep a state file to avoid duplicate reporting across runs"**, **"if there's nothing to report, send nothing"** (a routine's silence is a real, intentional output, not a failure), and **"handoff quality is a file format problem, not a prompting problem"** (directly relevant to designing what a Project's shared artifacts actually look like).

### Open question for the spec to answer, not assume

Should OIKONOMOS templates be a **closed, internal-only** feature (bots built inside OIKONOMOS, shared only among Basileia's own bots/users), or should the design leave room to **import** a well-known public Grok Bot template's *shape* (translating its skills/routines/instructions concept into OIKONOMOS's own governed model) without ever executing untrusted third-party code or granting a capability OIKONOMOS itself doesn't already govern? The scope-boundary rule above (Basileia-owned accounts only) and the "no third-party contract systems" rule both bear directly on this — don't resolve it by default, put the tradeoff in the spec and make a recommendation.

---

## Specific questions each spec should answer

**Templates:**
- What's the export format — a real file/manifest, or purely a DB-to-DB copy (accepting no external portability)?
- How are secrets/live references detected and refused, mechanically, at export time?
- Does installing a template touch `packages/connectors/manifests/**`? If so, the adversarial-review requirement is load-bearing for every template install, not just template-feature development — say what that means operationally.
- Versioning: can a template be updated after bots have already installed it? Do installed copies drift independently (matching Grok Bot's own "recipe, not clone" philosophy) or can they be re-synced?

**Project abstraction:**
- Is this a new first-class entity in `packages/db`, or a composed view over existing roster/thread/task/audit tables? Recommend one, with reasoning.
- What is a "shared artifact" concretely — a file, a fact in `packages/memory`, something new? Tie this to the "handoff quality is a file format problem" finding above.
- How does a Project's task board relate to the existing `tasks`/`runs` model — a filtered view, or a genuinely new board with its own state machine?

**Manager/coordinator bot:**
- Does the manager bot *create* new specialist bots/grants (a governance-relevant action needing an approval boundary per ADR-010), or only route/delegate among *already-existing* bots a human provisioned? Recommend one for v1, with the other as a stated future step.
- How does a manager bot's own spend get bounded separately from the specialists it delegates to, against the R350 ceiling?
- Relationship to DEVDEPARTMENT's own ORCH role: is a product-facing manager bot a *different* thing from ORCH (a governance-plane role that shouldn't be user-facing), or should DEVDEPARTMENT's own coordination patterns directly inform this design? Recommend one.

---

## What "done" looks like for this brief

One or more real spec documents under `specs/` (or `docs/architecture/`, matching this repo's existing split), each with the level of concreteness `OIKONOMOS_GROKBOT_PARITY_DISPOSITION_v1.0.md` and the WBS addenda already model: a disposition/decision per open question above, explicit dependencies on existing primitives, and acceptance-criteria-shaped requirements ORCH can decompose into `PLAN.md` tasks without having to re-derive the design. Any decision that's genuinely hard to reverse or cross-cutting gets its own ADR under `docs/decisions/`, per `CLAUDE.md`'s own rule for when one is required.
