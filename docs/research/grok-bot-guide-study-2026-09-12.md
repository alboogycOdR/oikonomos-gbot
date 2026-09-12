# Grok Bot guide study — what matters for OIKONOMOS

Source: x.ai's own published Grok Bot guides (linked inline below). Compiled 2026-09-12.

The central lesson is that Grok Bot is not primarily selling "an agent with tools." It is selling an operating system for a small AI workforce: persistent specialists, clear responsibilities, routines, shared work artifacts, visible progress, and human judgment at consequential boundaries.

## 1. The product unit is a persistent specialist, not a chat session

A Bot is defined by a simple identity pack — name, title, and description/instructions — then gains role-specific memory, skills, tools, routines, and work context over time. Users should be able to create one quickly from a voice note, a workflow explanation, or a recorded demonstration. [Grok Bot 101](https://x.ai/bot/guides/grok-bot-101)

OIKONOMOS already has the right foundations: named roles, instructions, memory, skills, routines, and bot creation. The product gap is mostly onboarding polish: the creation flow should help a user define a specialist's job, boundaries, inputs, outputs, approval rules, and success standard — not just fill fields.

## 2. Multi-bot work needs a project operating model

The strongest team pattern is:

> one project → one channel → one roster → one task board

A manager/PM Bot handles staffing and status; specialists do scoped work; blocked work is explicit; the human watches progress and intervenes only when needed. Grok's guide caps a project team at six including the PM, reuses existing specialists first, and requires human approval before creating new specialists. [How I run multiple teams of Grok Bots](https://x.ai/bot/guides/how-i-run-multiple-teams-of-grok-bots)

OIKONOMOS has group threads, handoffs, routing, and an internal task/run model. The meaningful next product layer is a Project abstraction that binds together a channel, roster, tasks, artifacts, decisions, and status — not merely a group chat.

## 3. Skills, routines, and templates are three different reusable layers

The guides clarify a useful hierarchy:

- **Skills**: reusable playbooks for doing work.
- **Routines**: scheduled or event-driven jobs.
- **Templates**: installable Bot recipes containing approved instructions, selected memories, skills, routines, and integrations.

Templates are intentionally recipes, not clones: secrets, personal/private memories, custom code, and scripts must not travel; recipients inspect included context and integrations before installing. Templates can be private, team-only, or public. [Templates for Grok Bot](https://x.ai/bot/guides/templates-for-grok-bot)

OIKONOMOS has built skills and much of routine parity, but templates remain deferred. This should become a priority once skills are proven live in both production execution lanes: templates are how a mature internal platform turns one good Bot into a repeatable organizational capability.

## 4. The "manager Bot" is a first-class role

Across the PM, engineering, and multi-team guides, a manager-type Bot does not necessarily execute specialist work. It decomposes goals, maintains the plan, checks evidence, delegates, escalates blockers, and keeps the system from becoming noisy.

For engineering specifically, Grok's pattern is outer-loop Bot → specialized coding agent → evidence/PR/test review → follow-up or escalation. The critical feature is the complete feedback loop, not autonomous code generation. [Grok Bot for Engineering](https://x.ai/bot/guides/grok-bot-for-engineering)

This strongly validates OIKONOMOS's governed handoff model and DEVDEPARTMENT-style evidence/review discipline. We should eventually expose it as a user-facing "Engineering Manager" Bot pattern rather than leaving it implicit in infrastructure.

## 5. Routines should produce signal, not noise

The support guide frames routines as the transition from a demonstrated workflow to dependable recurring work: release monitoring, bug reproduction with proof, churn analysis, approval-gated refunds, and custom reports. [Grok Bot for Support](https://x.ai/bot/guides/grok-bot-for-support)

The PM guide adds an important product concept: an attention list — a continuously refreshed view of what matters across calendar, inbox, chat, meetings, and projects. It is more useful than a static priority list because it reflects actual work. [Grok Bot for PMs](https://x.ai/bot/guides/grok-bot-for-pms)

OIKONOMOS should treat routines as governed operational products with:

- explicit source scope and freshness rules;
- disabled-by-default schedules;
- an approval boundary;
- a clear empty-result policy;
- change-only notifications;
- evidence-backed results.

This aligns closely with the current routine safety architecture.

## 6. Human judgment remains central

The design guide's point is subtle and important: Bots make exploration cheaper and faster, but humans retain taste, decision-making, and final judgment. The Bot should work with real production assets and structured sources of truth — such as a Figma file via MCP — not approximate them from screenshots. [Designing Grok Bot with Grok Bot](https://x.ai/bot/guides/designing-grok-bot-with-grok-bot)

This reinforces our stronger design choice: high-consequence work must be governed outside the model, with exact-action approvals, audit evidence, and human takeover for authentication friction.

## Highest-value product implications

1. Build a first-class Project / team workspace over the existing task, group-thread, handoff, and artifact primitives.
2. Finish the production wiring and prove skills actually affect live Claude and Gemini runs.
3. Promote templates from deferred work to the next reuse/distribution layer after live skills are proven.
4. Package role archetypes: Chief of Staff, Engineering Manager, Support Queue, Product Research, Design Production.
5. Add event-driven routines and operational "attention list" patterns after service supervision and latency instrumentation are fixed.
6. Treat the engineering feedback loop — task → delegated execution → proof → review → rework/merge — as a flagship OIKONOMOS workflow.
7. Preserve the current governance advantage: Grok's guide describes model-mediated natural-language controls, whereas OIKONOMOS has a stronger deterministic broker and approval boundary. [Grok Bot 101](https://x.ai/bot/guides/grok-bot-101)
