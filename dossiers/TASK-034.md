# TASK-034 dossier

## Brief
start/resume/fail/cancel state machine with session_ref persisted for resume-after-kill; new runs table + typed db module + worker consumer. NON-protected (S5 ok).

## Spec pointers
WBS OIK-038; Synthesis §5.1. New migration (next number, don't edit existing). No raw SQL outside packages/db.

## Intended approach
Disjoint territory (db/src/runs.ts + new migration + services/worker) so it runs concurrently with the harness adapters.

## Work Log
