# TASK-300 -- Atomic budget reservation protocol for the project and role axes -- database layer (P-3a)

## Brief
Pure database layer, no worker wiring (TASK-301 wires it). Assigned to S5, priority high. Depends on: TASK-298.

## Spec pointers
specs/OIKONOMOS_PROJECT_WORKSPACE_v1.0.md §6.2 (the full reservation protocol: SELECT ... FOR UPDATE ledger rows, recorded spend + open reservations per axis, deny before spawn, release exactly once), §11 (two simultaneous near-limit admissions -> at most one admitted); docs/decisions/ADR-019-project-entity-and-manager-role.md §5 'Atomic admission' steps 1-4.

## Owned paths
packages/db/src/spendReservations.ts, packages/db/src/spendReservations.test.ts, packages/db/src/spend.ts, packages/db/src/spend.test.ts, packages/db/src/index.ts

## Intended approach
Concurrency test pattern: two separate pool clients, BEGIN both, interleave so both reach the FOR UPDATE, assert one blocks then is denied. Month key = UTC YYYY-MM.

## Acceptance criteria
- Two concurrent near-limit admissions on the same project axis: exactly one succeeds and the other is denied budget.project_exceeded -- proven with two genuinely concurrent real-Postgres transactions, not sequential calls. (spec §6.2, §11)
- The same concurrency proof on the role axis with budget.role_exceeded. (spec §6.2, §11)
- Open reservations count against the ceiling alongside recorded spend. (spec §6.2)
- A reservation is released exactly once: releasing twice is a no-op, and recording spend releases it in the same transaction as the spend_records insert (a test proves a failed insert leaves the reservation open). (spec §6.2)
- A role with budget_usd NULL and a run with no project are admitted without touching those axes. (spec §6.2)
- Full recursive suite via scripts/test-isolated.ps1 only.

## Work Log
