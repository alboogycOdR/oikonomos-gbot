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

- [2026-09-06T09:13:00Z] [CX9] Preflight completed: migration 016 files, worker routineJob tests, and control-api routine route tests are NEW; routines.ts, routines.test.ts, routineJob.ts, app.ts, and openapi.ts exist. Read all TASK-182 spec references, TASK-176/179 outcomes, current routine DB/scheduler/API code, and TASK-177 prompt assembly. Blocked before implementation: live skill binding requires propagating routine.skill_id into the chat-run prompt path (`services/worker/src/chatRunDriver.ts` and/or `services/worker/src/promptAssembly.ts`), neither in Owned_Paths. Live pause/resume and test-run routes also require adding real routine operations to `services/control-api/src/ports.ts`/`createDatabaseBackedDeps`, also outside Owned_Paths. Implementing only local route ports in app.ts would leave production endpoints inert, contrary to the task description and ADR-005 liveness discipline. Need ORCH to widen territory or split/wire those seams.
- [2026-09-06T10:05:00Z] [CX9] Resumed after ORCH widened `services/control-api/src/ports.ts`; confirmed the prescribed skill approach is viable within `routineJob.ts` (prepend the persisted skill name as a `/name` token). Re-ran preflight and read all live routine, scheduler, API-port, skill, prompt-assembly, migration, and task files. Blocked by a remaining Owned_Paths omission: the new typed routine functions needed for retention records, stopped/skipped outcomes, pause/resume, lookup, and test-run must be exported from `packages/db/src/index.ts`. Both `routineJob.ts` and `ports.ts` import only `@oikonomos/db`; `Database` has no corresponding routine methods. That index is not owned, so implementation cannot make these production paths live without an out-of-territory edit.
