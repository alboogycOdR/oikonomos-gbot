# TASK-031 dossier

## Brief
canUseTool callback to the same broker endpoint, idempotent with L1 per toolUseId (R2/CAN-08); catches the F5 class (AskUserQuestion, requiresUserInteraction, ask-configured tools). Never sole enforcement. Protected.

## Spec pointers
ADR-001 L3/R2/F5; Handover §4.1. Fail closed same as L1.

## Intended approach
Own only src/l3/canusetool.ts + test.

## Work Log

- [2026-08-17T19:50:00Z] [CX] Preflight: `[preflight] TASK-031 Owned_Paths inspected in C:/CLAUDECODE_TOOLSETS/wt-codex-oikonomos`; both owned L3 source and test paths are NEW (their parent directories do not exist). Read WBS OIK-035, ADR-001 L3/R2/F5, Handover §4.1, and the live L1 adapter. Implementing L3 as a thin mapping over L1's injected transport adapter so endpoint, request shape, 10-second fail-closed behavior, and broker-owned per-toolUseId idempotency cannot diverge.
- [2026-08-17T19:54:00Z] [CX] Implemented the adapter and L3 tests, including an L1+L3 same-toolUseId broker simulation that asserts a single idempotent decision/audit record. Focused suite: 29/29 passed; after lockfile-pinned dependency installation, typecheck and build passed and the full recursive suite passed (277 tests, 31 integration skips).
