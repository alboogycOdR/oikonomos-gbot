# TASK-031 dossier

## Brief
canUseTool callback to the same broker endpoint, idempotent with L1 per toolUseId (R2/CAN-08); catches the F5 class (AskUserQuestion, requiresUserInteraction, ask-configured tools). Never sole enforcement. Protected.

## Spec pointers
ADR-001 L3/R2/F5; Handover §4.1. Fail closed same as L1.

## Intended approach
Own only src/l3/canusetool.ts + test.

## Work Log
