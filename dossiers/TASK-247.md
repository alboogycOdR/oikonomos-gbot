# TASK-247 — Workspace-1 follow-on — routine time zone (IANA) for cron evaluation and next-fire display

**Unit:** TBD · **Priority:** low · **Depends_On:** TASK-242

## Brief
No time zone exists on `role_routines`; cron is evaluated in process time and `nextFireAt` is shown bare. Add `timezone text NOT NULL DEFAULT 'UTC'` (IANA name, validated), use it in `nextFireAtFromCron` and the scheduler, accept it on create/patch, return it on read. Dashboard/mobile display follow separately. Sequenced after TASK-242 (`app.ts`).

## Spec pointers
specs/OIKONOMOS_WORKSPACE_WAVE_v1.0.md §9.3; specs/OIKONOMOS_GROKBOT_PARITY_DISPOSITION_v1.0.md §3 G-02

Read `specs/OIKONOMOS_WORKSPACE_WAVE_v1.0.md` §1 first for the product shape and §10 for what must not be claimed. The independent review that produced this wave (verdict, disposition matrix, execution proposal) is at `E:\DELL-PROJECTS\GROKBOT-RESEARCH-DOCS\ORCH_REVIEW\` — read the rows cited in Spec_References; do not treat the advisory documents themselves as spec.

## Intended approach
No time zone exists on `role_routines`; cron is evaluated in process time and `nextFireAt` is shown bare. Add `timezone text NOT NULL DEFAULT 'UTC'` (IANA name, validated), use it in `nextFireAtFromCron` and the scheduler, accept it on create/patch, return it on read. Dashboard/mobile display follow separately. Sequenced after TASK-242 (`app.ts`).

## Owned_Paths
packages/db/src/routines.ts, packages/db/src/routines.test.ts, infra/postgres/migrations/024_routine_timezone.up.sql, infra/postgres/migrations/024_routine_timezone.down.sql, services/worker/src/jobs/routineJob.ts, services/worker/src/jobs/routineJob.test.ts, services/worker/src/routineTool.ts, services/worker/src/routineTool.test.ts, services/control-api/src/app.ts, services/control-api/src/openapi.ts, services/control-api/src/routines.routes.test.ts

## Work Log
