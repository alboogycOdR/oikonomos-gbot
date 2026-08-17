# TASK-033 dossier

## Brief
After a tool runs, write result digest + artifact URIs to the audit trail, correlated to the L1 decision's toolUseId/auditEventId (R4). Protected.

## Spec pointers
ADR-001 R4; Handover §4.3 (shared canonical-JSON/digest, no reimplementation). Depends OIK-034 (pairs with the L1 record).

## Intended approach
Own only src/hooks/posttooluse.ts + test.

## Work Log
