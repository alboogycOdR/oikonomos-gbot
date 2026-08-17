# TASK-032 dossier

## Brief
Fix permissionMode=dontAsk and validate the allowedTools allowlist; REJECT bare-name entries unless ADR-named (R1/F2). The config-layer half of CAN-02, the most important test in the project. Protected.

## Spec pointers
ADR-001 L2/R1/F2; directive §6. Scoped forms allowed, bare names rejected.

## Intended approach
Own only src/l2/allowed-tools.ts + test. Note L1 still denies regardless; L2 is defence in depth.

## Work Log
