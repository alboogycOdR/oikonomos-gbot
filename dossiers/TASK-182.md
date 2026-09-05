# TASK-182 — G-02a — Routine parity semantics backend: missing-source stop, test run, pause, caps, 20-record retention, skill binding

## Brief

Bring routines to Grok Bot's documented edge semantics. Schema: `role_routines` gains `skill_id uuid null REFERENCES skills`, `on_missing_source text NOT NULL DEFAULT 'report_and_stop'`, `notify_threshold text NOT NULL DEFAULT 'changes_only'`, `paused boolean NOT NULL DEFAULT false`; a `routine_runs` retention rule keeping the 20 most recent fire records per routine (prune on insert, in the typed layer — TASK-159 reconstructs history from these). Worker: before creating the run, routineJob checks each declared input/connector in `definition.inputs` is grantable/available for the role; if not and policy is report_and_stop, record a fire with outcome `stopped` + reason and make NO model call. A routine bound to a skill_id fires with that skill injected exactly as TASK-177 does for `/name`. API: `POST /routines/:id/test-run` (fires now; response carries the literal warning 'test run performs real work'), `POST /routines/:id/pause|resume`, and creation rejects the 51st routine for a role with 409. Event triggers are NOT in scope (G-02b, needs a connector event pipeline that does not exist).

## Spec pointers

specs/OIKONOMOS_GROKBOT_PARITY_DISPOSITION_v1.0.md §3 G-02 (AC anchors: zero provider spend on a stopped routine; 21st record evicts oldest; 51st routine rejected); report §12.3 schemas/routine.yaml, §12.5(b), C6; docs/research/grok-bot-technical-report-2026-09-05.pdf §3.5; Addendum F §3.4 F7 (missed, never queued for catch-up)

## Territory

infra/postgres/migrations/016_routine_parity.up.sql, infra/postgres/migrations/016_routine_parity.down.sql, packages/db/src/routines.ts, packages/db/src/routines.test.ts, services/worker/src/jobs/routineJob.ts, services/worker/src/jobs/routineJob.test.ts, services/control-api/src/app.ts, services/control-api/src/openapi.ts, services/control-api/src/routines.routes.test.ts

Depends_On: TASK-176, TASK-179

## Intended approach

Read the Spec pointers first, then the existing files named in Territory (run the preflight and paste it into the first Progress_Note). Match surrounding conventions exactly — packages/db follows routines.ts; control-api routes follow the chat routes + openapi.ts; mobile follows the TASK-157/168 visual bar. Every acceptance criterion maps to a spec sentence; test the criterion, not the summary. Anything outside Territory is a block, not an edit.

## Work Log
