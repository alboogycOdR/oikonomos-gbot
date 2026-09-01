# ADR-010 — Pivot to the persistent-office-computer model

**Status:** ACCEPTED · **Date:** 2026-09-01 · **Decision owner:** Alister Witbooi
**Relates to:** ADR-001 (broker enforcement point), ADR-003 (tier resolution), ADR-005 (control liveness), ADR-009 (cloud-portable orchestration), `docs/STUDY-grok-bot-018.md`, CLAUDE.md non-negotiables
**Supersedes:** the implicit ephemeral-per-task execution model this codebase has built against since inception. Does not supersede any single prior ADR by name — it changes the assumption several of them were written on top of.

---

## 1. Context — what OIKONOMOS actually is today, and why that's not what was asked for

Every runtime primitive built to date — `services/worker`'s `executeTaskRun`, `packages/harness-factory`'s `composeHarness`, the connector-mount lifecycle proven live in TASK-054/055 — is **ephemeral and per-task**: a task arrives, a harness is composed for that one run, a connector is mounted for that run only, the run ends, and nothing survives except database rows (`tasks`, `runs`, `audit_events`, `approvals`). There is no persistent environment, no filesystem a run can leave state in for the next run to find, no shared browser/connector session, and no durable identity with memory or routines living independently of any one task. The word "agent" in this codebase currently means "one governed execution of one task," not "a role that persists."

This was not a documented decision anyone consciously reversed later — it is the union of many task-level choices (TASK-052 through TASK-083) that were each individually correct against the spec documents in force at the time, but that spec was never itself the vision. The owner's stated intent, repeated now for the record:

> "I want OIKONOMOS to become the persistent-office-computer model — one durable environment, named agent roles with memory/routines living on it, shared workspace and session state, connectors + broader autonomy with human-takeover reserved for auth/security friction."

That is the Grok Bot **product** architecture (one persistent account-scoped VM; named Bot identities as durable roles on it, each with job/memory/routines/skills; a shared `/workspace` filing cabinet; shared browser cookies and connector logins across every identity; human takeover reserved for password/2FA/CAPTCHA/payment friction, not for ordinary business actions) — as distinct from the Grok Bot **local-tool-permission subsystem** that `docs/STUDY-grok-bot-018.md` mined for governance patterns (nonce+generation+epoch approvals, undescribable-⇒-deny, construction-time policy completeness, refusal memory). This codebase adopted the second thing thoroughly and never adopted the first thing at all. `docs/decisions/ADR-010` is where that gap gets closed, in writing, before further task-level work either deepens the ephemeral model or gets built against an architecture the owner has now explicitly rejected.

## 2. Decision

**OIKONOMOS pivots to a persistent-environment, named-role architecture.** Concretely, in scope for this decision (mechanism design is deferred to the spec/decompose work this ADR authorizes, not decided here):

1. **One durable environment** replaces the per-run ephemeral harness as the default execution substrate. State — files, browser/connector sessions, installed packages/CLI credentials — lives on that environment and survives across runs, the same way `/workspace` and browser cookies survive across Grok Bot's Bots.
2. **Named agent roles** become durable identities on that environment: profile, job description, own memory, own routines/skills, own conversation history — not re-derived per task. `role_id`/`role_grants` already exist in the schema as a structured permission concept; this decision extends "role" to also mean a persistent, addressable identity, which the existing schema does not yet model.
3. **Shared workspace and session state** across roles on the same environment — a role that signs into a service makes that session available to other roles on the same environment, mirroring the explicit account-not-Bot isolation boundary Grok Bot documents (and warns about: *"do not use separate Bots as a security boundary"*).
4. **Broader autonomy** — the default posture shifts from "every external action passes the broker and Tier-3 actions park for approval" toward "acts freely within its role's grant; human takeover is reserved for genuine auth/security friction" (login walls, 2FA, CAPTCHA, payment confirmation) rather than for ordinary business-risk actions.

## 3. What does NOT change — the CLAUDE.md non-negotiables hold regardless of this pivot

This decision widens *autonomy*; it does not touch *governance floor*. Explicitly still in force, unchanged:

- Broker enforcement stays the `PreToolUse` hook — `canUseTool` alone remains banned (ADR-001). A broader-autonomy default is implemented as a policy/tier configuration the broker evaluates, never as a bypass of the broker itself.
- `bypassPermissions`/`acceptEdits` remain banned platform-wide.
- Fail-closed on broker-unreachable/timeout/malformed remains absolute.
- No credentials in prompts, logs, audit payloads, or fixtures — if anything, a persistent environment with durable sessions makes this *more* load-bearing, not less: a leaked audit payload on a durable environment is discoverable by every role on it, not just the one run that produced it.
- Basileia-owned accounts only; no client/employer account ever lands in the shared environment.
- **No circumvention of CAPTCHA, MFA, or bot protection.** This is precisely where "human-takeover reserved for auth/security friction" already lives in this codebase's own rules — item 4 of this decision is an extension of an existing non-negotiable, not a new one.
- ACL filter before vector similarity, never after.
- Approvals stay nonce-bound and single-use where they are still the mechanism in use — the pivot changes *which actions* require an approval (fewer, reserved for genuinely irreversible/high-risk ones and for auth friction), not the atomicity guarantee of the approval primitive itself when one is issued.

The practical implication: the broker, policy, approvals, and audit machinery built across TASK-052 through TASK-083 is **not discarded**. It becomes the enforcement layer for a narrower, higher-stakes action set inside a much more autonomous environment, rather than the gate on every single tool call. The tier map (T0–T4) likely needs rework — under the current model T3 already means "requires approval"; under the new model most T1/T2-shaped actions plausibly need to execute autonomously, with approval reserved closer to T3/T4 *and* to the auth-friction moments Grok Bot itself pauses for. That rework is a decompose task, not decided here.

## 4. Consequences

- **The current PLAN.md backlog needs reassessment**, not a wholesale halt. Concretely:
  - Governance primitives (packages/broker's registry/describe/decision/refusal-memory, packages/policy's ceiling/approval-resolution) remain valid — they become the enforcement layer for the narrower "still needs a human" action set, and the persistent environment needs them *more*, not less, given durable state raises the stakes of a mistake.
  - The ephemeral-per-run model in `services/worker`/`packages/harness-factory` (TASK-055's ownership, TASK-076's scheduler) needs to be re-examined against a persistent-environment target — some of it (per-agent serialization, approval-aware idle, lane priority) still applies to a persistent role's queue of work; some of the "mount fresh per run, tear down at run end" assumptions do not.
  - Connector work (TASK-054/083, Gmail specifically) gets *more* valuable under this model, not less — a persistent, authenticated connector session is exactly the "signed in once, available thereafter" property this ADR asks for.
- **A proper spec/decompose pass is required before further build work proceeds against the new target.** Per this project's own model-discipline table, architectural decomposition and Owned_Paths design run on `claude-opus-5` at medium-or-higher reasoning effort — not folded into a Sonnet-5 ORCH background loop. This ADR authorizes that pass; it does not substitute for it.
- **Open questions the decompose pass must resolve, not this ADR:** what "one durable environment" means technically for this stack (a long-lived container/VM per tenant? per role? something else); how role memory/routines are persisted and schema-modeled; how the broker's tier map and approval thresholds get redefined for the new autonomy default; how shared session/credential state is protected given N4/N5 given it now persists across roles and time instead of dying with a run; migration path for the connector/worker code that already exists and works (TASK-054/055/083) rather than a rewrite from zero.
- **In-flight task-level work is not aborted by this ADR.** TASK-079 (loopback MCP bridge) remains directly relevant — a persistent environment still needs broker-gated tool bridges for CLI harnesses. New backlog dispatch from the *old* per-task-shaped list should pause pending the decompose pass, since some of it (e.g. TASK-076's scheduler) may be reshaped or superseded by the new target rather than simply built as specified.

## 5. Rollout

1. This ADR (accepted, this document).
2. Spec authoring / decompose pass on `claude-opus-5`, addressing the open questions in §4, producing the environment/role/session model as a real design (likely its own addendum-shaped document, given the size) before PLAN.md tasks are cut against it.
3. Re-triage the current PLAN.md backlog against the new spec: keep, reshape, or supersede each pending item explicitly (no silent drops — matches this project's own "nothing dropped silently" convention already used for the Grok Bot study's disposition table).
4. New tasks cut from the resulting spec, decomposed and dispatched under the normal protocol.
