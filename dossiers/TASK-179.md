# TASK-179 — G-03a — Context hygiene backend: per-thread context meter, rolling compaction, 'start fresh'

## Brief

Grok Bot's staff-confirmed gap: one unbounded thread per Bot, no compaction, no meter. Build: (1) `thread_context(thread_id PK, context_tokens int, context_limit int, compacted_through_message_id uuid null, epoch int NOT NULL DEFAULT 0, updated_at)` plus `thread_summaries(summary_id, thread_id, epoch, covers_through_message_id, body text, created_at)`. Summaries are THREAD state, not memory — Addendum F forbids memory writes as a run side-effect, so compaction never touches packages/memory. (2) contextCompaction.ts: after each run, estimate tokens of (persona + skills + summary + verbatim history); when above `context_limit * 0.8`, summarise all messages older than the last N=40 turns into a new thread_summaries row using the Tier-0 provider (CLAUDE.md budget rule: cheap model via FreeLLMAPI/agent-providers), run the packages/audit redaction middleware over the summary body before persisting, and advance compacted_through_message_id. (3) promptAssembly.ts assembles: persona → skills → latest summary → verbatim messages after compacted_through. (4) 'Start fresh' = `POST /threads/:id/fresh` increments epoch; assembly only includes messages/summaries of the current epoch (older turns stay visible in the UI, invisible to the model). (5) `GET /threads/:id` gains context_tokens/context_limit/epoch. A compaction emits a `system` message `Context compacted (N messages → summary)` so the UI can show it.

## Spec pointers

specs/OIKONOMOS_GROKBOT_PARITY_DISPOSITION_v1.0.md §3 G-03 (AC anchors incl. measured prompt-size reduction and no sealed secret in a summary); report §10.6 staff-confirmed Grok Bot gap, §12.3 memory.compaction, §13.2 item 3; Addendum F §3.3 ('memory is not the transcript'; nothing is written to memory as a side effect of a run)

## Territory

infra/postgres/migrations/015_thread_context.up.sql, infra/postgres/migrations/015_thread_context.down.sql, packages/db/src/threadContext.ts, packages/db/src/threadContext.test.ts, services/worker/src/contextCompaction.ts, services/worker/src/contextCompaction.test.ts, services/worker/src/promptAssembly.ts, services/worker/src/promptAssembly.test.ts, services/control-api/src/app.ts, services/control-api/src/openapi.ts, services/control-api/src/threadContext.routes.test.ts

Depends_On: TASK-177

## Intended approach

Read the Spec pointers first, then the existing files named in Territory (run the preflight and paste it into the first Progress_Note). Match surrounding conventions exactly — packages/db follows routines.ts; control-api routes follow the chat routes + openapi.ts; mobile follows the TASK-157/168 visual bar. Every acceptance criterion maps to a spec sentence; test the criterion, not the summary. Anything outside Territory is a block, not an edit.

## Work Log
