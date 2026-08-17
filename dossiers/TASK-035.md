# TASK-035 dossier

## Brief
compose.ts wires the three adapters + PostToolUse into createHarness(); the eight canaries CAN-01..08 run CI-blocking. The G-GOV gate. CAN-02 is the regression test against the original architecture flaw. Protected.

## Spec pointers
ADR-001 Canary table; directive §6. CAN-03 may reuse the existing infra/ci banned-mode scanner. ORCH wires the CI job at merge (workflow file is cross-cutting).

## Intended approach
compose.ts is the sole composition root (kept out of index.ts so adapters could be concurrent). Depends on all four of OIK-034/035/036/037.

## Work Log
