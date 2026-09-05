# TASK-180 — G-04 — Single-owner group routing: exactly one responder when nobody is @-mentioned

## Brief

Today a group-thread message fans out to every member (TASK-122 gates 2+ recipients behind an approval). Add a routing step BEFORE fan-out in groupFanout.ts, implemented in groupRouting.ts: `@name` tokens → exactly those members; `@everyone` → all members (still subject to the fan-out approval); no mention → ONE responder chosen by a cheap should-respond score over each member's title+description via the Tier-0 provider (packages/agent-providers, budgeted — never `unsafeAllowUnbudgeted`), ties broken by the thread's most recent responder. Enforce a hard cap of 6 members at routing time (reject with a clear error; do not silently truncate). Wake-up budget: a single inbound message may start at most `members × 1` runs. Pure routing function is unit-tested without a model; the classifier call is injected.

## Spec pointers

specs/OIKONOMOS_GROKBOT_PARITY_DISPOSITION_v1.0.md §3 G-04 (AC anchors: unaddressed message in a 3-Bot room yields run count = 1; classifier billed to Tier-0); report §12.5(f) group_host.route, §6.4 'group chatter cost', §10.6; TASK-122's fan-out approval rule stays intact

## Territory

services/worker/src/groupRouting.ts, services/worker/src/groupRouting.test.ts, services/worker/src/groupFanout.ts, services/worker/src/groupFanout.test.ts

Depends_On: TASK-175

## Intended approach

Read the Spec pointers first, then the existing files named in Territory (run the preflight and paste it into the first Progress_Note). Match surrounding conventions exactly — packages/db follows routines.ts; control-api routes follow the chat routes + openapi.ts; mobile follows the TASK-157/168 visual bar. Every acceptance criterion maps to a spec sentence; test the criterion, not the summary. Anything outside Territory is a block, not an edit.

## Work Log

- [2026-09-05T22:07:01Z] [CX9] Started on `task/TASK-180-cx9`; no `Review_Findings` rework was present. Preflight output (verbatim):
  ```text
  [preflight] TASK-180 Owned_Paths inspected in E:/DELL-PROJECTS/wt-codex9-GROKBOT-CLONE
  [preflight] 4 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    NEW    services/worker/src/groupRouting.ts  -> does not exist; parent services/worker/src/ exists
    NEW    services/worker/src/groupRouting.test.ts  -> does not exist; parent services/worker/src/ exists
    FILE   services/worker/src/groupFanout.ts  -> exists, 93 line(s), 4155 bytes
    FILE   services/worker/src/groupFanout.test.ts  -> exists, 140 line(s), 6192 bytes
  [preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
  ```
  Blocked before implementation: the sole production call site, `services/control-api/src/ports.ts` (`requestGroupFanout`), passes only `memberRoleIds` to `deliverBotToBotMessage`. It provides neither role title/description nor a classifier/Tier-0 provider/budget sink nor the group thread/recent-responder context. `groupFanout.ts` cannot construct a compliant budgeted Tier-0 call itself: `@oikonomos/agent-providers` exposes generic providers and `withBudgetSink`, but the task explicitly prohibits unbudgeted construction and its required runtime seams must originate at composition. Implementing routing only in newly created worker files would be unreachable from every group message; changing the call site or public worker composition is outside the four Owned_Paths. Required territory expansion: `services/control-api/src/ports.ts` (and, if the dependency seam is exposed through the package, `services/worker/src/index.ts` / `chatRunDriver.ts`), with a decision on the concrete FreeLLMAPI/Tier-0 adapter and its database-backed budget sink.

- [2026-09-06T00:25:00Z] [CX9] Resumed after ORCH's scope clarification (live call-site wiring is TASK-189). Added the routing engine: `@name`, `@everyone`, unaddressed single-score selection with recent-responder tie break, an explicit six-member cap, and a budget-enforced Tier-0 scorer built through `withBudgetSink` (fails closed without a completed billed turn). `groupFanout` now accepts the engine's optional routing context and invokes it before its unchanged TASK-122 approval gate. Evidence: targeted `pnpm --filter @oikonomos/worker exec vitest run --config ../../packages/shared/vitest.config.ts --root . src/groupRouting.test.ts src/groupFanout.test.ts` passed 9/9; worker typecheck, build, and repository lint passed. A prior full worker suite additionally exercised TASK-122 successfully but had two unrelated existing PostgreSQL tests time out at Vitest's 5s limit (`registerCapabilities PostgreSQL idempotency`, `runLifecycle durable resume`).
