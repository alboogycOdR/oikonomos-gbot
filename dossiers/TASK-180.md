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
