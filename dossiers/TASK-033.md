# TASK-033 dossier

## Brief
After a tool runs, write result digest + artifact URIs to the audit trail, correlated to the L1 decision's toolUseId/auditEventId (R4). Protected.

## Spec pointers
ADR-001 R4; Handover §4.3 (shared canonical-JSON/digest, no reimplementation). Depends OIK-034 (pairs with the L1 record).

## Intended approach
Own only src/hooks/posttooluse.ts + test.

## Work Log

- [2026-08-17T19:56:36Z] [CX] Preflight completed: `packages/harness-factory/src/hooks/posttooluse.ts` and `packages/harness-factory/test/hooks/posttooluse.test.ts` are NEW (their hooks/test parents exist); `packages/harness-factory/package.json` and `pnpm-lock.yaml` are existing files. Implemented `createPostToolUseHook` with an injected completion-audit sink. It correlates completion records by `toolUseId`, extracts explicit `artifactUri`/`artifactUris` fields, and produces the result digest through `@oikonomos/shared`'s `actionDigest` (canonical JSON + SHA-256), without local hashing. Audit sink rejections are deliberately propagated.
- [2026-08-17T19:59:35Z] [CX] Validation: `pnpm --filter @oikonomos/shared build` (required once to materialize the fresh-worktree workspace export), `pnpm --filter @oikonomos/harness-factory test` (7 files, 46 tests passed), `pnpm --filter @oikonomos/harness-factory typecheck` (passed), and `pnpm lint` (passed). `pnpm -r test` ran through all packages but exited 1 only because the unrelated `@oikonomos/worker` tests expect non-exported `getRun`/`startRun`; harness-factory itself passed in that recursive run. `git diff --check` passed.
