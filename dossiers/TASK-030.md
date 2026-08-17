# TASK-030 dossier

## Brief
PreToolUse hook that POSTs the Handover §4.1 request to the broker and maps allow/deny; the primary enforcement point P1; fails closed on transport/timeout>10s/malformed. Protected.

## Spec pointers
ADR-001 L1, R3; Handover §4.1. CAN-04 is the fail-closed canary. Consume broker via DI port; no local §4.1 reimplementation.

## Intended approach
Own only src/hooks/pretooluse.ts + test. Disjoint from L3/L2/PostToolUse so all run concurrently after OIK-033.

## Work Log
