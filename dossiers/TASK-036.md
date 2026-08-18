# TASK-036 dossier

## Brief
A subagent Tier-3 attempt is denied and the audit attributes the subagent (F4/CAN-05); no subagent path carries a bypass mode. Protected.

## Spec pointers
ADR-001 F4/CAN-05; Handover §4.1 agentRef.isSubagent. Extends CAN-05, depends OIK-039.

## Intended approach
Own src/subagent.ts + test.

## Work Log

- [2026-08-18T08:40:00Z] [CX] Preflight output (verbatim): `[preflight] TASK-036 Owned_Paths inspected in C:/CLAUDECODE_TOOLSETS/wt-codex-oikonomos`; `[preflight] 2 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.`; `  NEW    packages/harness-factory/src/subagent.ts  -> does not exist; parent packages/harness-factory/src/ exists`; `  NEW    packages/harness-factory/test/subagent.test.ts  -> does not exist; parent packages/harness-factory/test/ exists`. Started OIK-040 implementation on task/TASK-036-cx from origin/master after correcting the dispatcher worktree branch mismatch.
- [2026-08-18T08:46:00Z] [CX] Implemented subagent L1 construction and its CAN-05-focused test: Tier-3 denial travels through L1 to the broker with `agentRef.isSubagent: true` and a child-only session reference; unsafe inherited modes are rejected. Verified `pnpm --filter @oikonomos/harness-factory test` (9 files, 60 tests passed), `pnpm --filter @oikonomos/harness-factory typecheck`, `pnpm lint`, and `git diff --check` (all exit 0). `pnpm canaries` is currently not runnable from this clean worktree because its eight integration suites cannot resolve unbuilt workspace packages `@oikonomos/approvals`/`@oikonomos/broker`; CAN-03 and workspace tests pass. No out-of-territory build outputs were created.
- [2026-08-18T10:57:26Z] [CX] Rework complete: publicly re-exported the subagent construction API and rewired CAN-05 to invoke it directly, with the broker HTTP seam delegated to the real broker handler. Replaced the untyped runtime-module cast with a typed static L1 import. After `pnpm install --offline --frozen-lockfile` restored workspace links, verified `pnpm -r build`; harness-factory typecheck + 60/60 tests; evals-harness typecheck + focused CAN-05; `pnpm lint`; `git diff --check`; and `pnpm canaries` (10 files, 14 passed, 2 Postgres variants skipped). Liveness mutation: replacing the subagent broker consult with a local denial made CAN-05 fail (`expected [] to have a length of 1 but got 0`); restored the consult and CAN-05 passed.
