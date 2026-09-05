# Workflow — Post-incident backlog: prioritization and Wave 7/8

**Date:** 2026-09-05, morning session · **Builders:** S5, CX, CX9 · **Context:** real on-device testing tonight surfaced two live incidents (chat-run isolation, fixed as TASK-153; an unresolved MCP-connector leak) plus a real UI/capability gap analysis against the reference Grok Bot app. This is the full backlog from that testing, prioritized and sequenced.

## Priority reasoning

**Tier 1 — actively blocking further verification.** Continue-after-approval isn't just a known gap anymore; tonight's own live retest hit it directly and couldn't complete. It also happens to be the one item that, once built, lets ORCH actually finish verifying the MCP-connector-leak question live rather than guessing. Goes first.

**Tier 2 — security-adjacent, independently investigable.** The MCP-connector leak's likely fix point (`withSystemClaudeExecutable`, `packages/harness-factory`) is a different file entirely from continue-after-approval's, so it doesn't need to wait — a builder can investigate and prove/fix it directly, in parallel.

**Tier 3 — real capability gaps, backend mostly ready.** Role instructions/persona, routine creation UI, routine detail+history, inline handoff chips. These are genuine product gaps (not polish) where oikonomos's backend is ahead of what the mobile client exposes.

**Tier 4 — polish.** Markdown rendering, system-event styling, composer placeholder, title field surfacing, frosted header, date dividers. Real, worth doing, no architectural risk.

**Deliberately not scheduled, named so they aren't lost:** live-agent/monitor view (depends on OpenSandbox being wired into chat execution — real, larger, separate program), conversational rename (needs its own capability + tool, sequence after role-instructions lands), voice input (needs a speech-to-text pipeline, out of scope), pill-composer/attach-button visual work (cosmetic, lowest value), OIK-110/111 budgets (already named from TASK-150, no new urgency today).

## Territory note — why TASK-155 and TASK-156 don't run in parallel

Both continue-after-approval and role-instructions need to touch `services/worker/src/chatRunDriver.ts`'s `runChatTask` function — one to add a resume path, one to add `systemPrompt`. Physically the same file regardless of logical independence, so per this project's own "never let two builders near one file" rule they're sequenced, not parallelized: TASK-155 now, TASK-156 once it lands.

## Wave 7 — dispatched now, verified disjoint

| Task | Builder | Scope | Why grounded, not guessed |
|---|---|---|---|
| TASK-154 | CX | MCP-connector/system-CLI leak — investigate `packages/harness-factory`'s `withSystemClaudeExecutable`, prove or fix | Confirmed this function lives entirely in `packages/harness-factory/src/index.ts`, zero overlap with TASK-155/156's files |
| TASK-155 | CX9 | Continue-after-approval — real SDK session resume once an approval is granted | Confirmed real: SDK supports `resume: sessionId` (verified in `sdk.d.ts`), `runs.session_ref` is already persisted, and TASK-153 already built the generic `agentSdkOptions` passthrough this needs. CX9 has fresh SDK-internals context from TASK-150. |
| TASK-157 | S5 | Mobile polish bundle: markdown rendering, system-event message styling, personalized composer placeholder, `title` field in settings | Pure `apps/mobile/**`, no backend dependency, no collision with anything |

## Wave 8 — named now, decomposed once Wave 7 frees builders or lands

| Task | Depends on | Scope |
|---|---|---|
| TASK-156 | TASK-155 (same-file sequencing) | Role instructions/persona: migration + `instructions` column, PATCH route, `systemPrompt` injection into chat runs (SDK supports `systemPrompt: string`, confirmed) |
| TASK-158 | TASK-157 (apps/mobile single-owner) | Routine creation UI on mobile (backend route already exists per TASK-134) |
| TASK-159 | TASK-158 | Routine detail view + run history (extends TASK-148's read-only list) |
| TASK-160 | TASK-159 | Inline cross-bot handoff chips — likely needs a small new backend enumeration endpoint + mobile UI |
| ORCH (not a builder task) | TASK-155 | Re-run the live MCP-connector-leak retest now that runs can actually complete, to settle whether TASK-154's fix (or TASK-153's env scoping alone) closed it |

## What I'm doing now

Decomposing and dispatching Wave 7 (TASK-154/155/157) immediately. Wave 8 gets decomposed as Wave 7 tasks land, same discipline as every prior wave this session.
