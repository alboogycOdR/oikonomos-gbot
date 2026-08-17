# TASK-038 dossier

## Brief
Backup + restore for Postgres + evidence volume, with a restore drill into a clean environment (the drill is the acceptance bar). NON-protected. Wave-1 parallel filler so both units are fed while E4's head is serial.

## Spec pointers
WBS OIK-015; Handover §8. Notes go in infra/backup/README.md (docs/** is builder-blocked). Deps only OIK-011 (done) = eligible now.

## Intended approach
Scripted backup + a demonstrated clean-env restore. No credentials anywhere.

## Work Log
