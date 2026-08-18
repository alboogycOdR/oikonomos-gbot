# TASK-040 dossier

## Brief

OIK-041 CRITICAL-1: broker replay cache must be keyed on the ACTION, not just the principal. ADR-007 §3a is the corrected spec.

## Work Log

- [2026-08-18T12:55:00Z] [GB] Session start. Newly claimed; created `task/TASK-040-gb` from `master` (`70d0420`). Did not re-claim. Preflight against main PLAN.md (worktree PLAN.md is stale vs TASK-040):
  ```text
  [preflight] TASK-040 Owned_Paths inspected in C:/CLAUDECODE_TOOLSETS/oikonomos
  [preflight] 2 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    FILE   packages/broker/src/index.ts  -> exists, 376 line(s), 12421 bytes
    FILE   packages/broker/test/pretooluse.test.ts  -> exists, 441 line(s), 18527 bytes
  [preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
  ```
  Both paths exist and match Owned_Paths. Implementing ADR-007 §3a key: `tenantId \0 roleId \0 toolUseId \0 toolName \0 actionDigest({toolName, input, destination})` via `@oikonomos/shared` only.

- [2026-08-18T12:57:36Z] [GB] Replay key now includes `toolName` + `@oikonomos/shared` `actionDigest({toolName, input, destination})`. Destination is resolved *before* cache lookup so a payload swap cannot inherit a prior allow. `destinationFor` / `actionDigest` failures fail closed and are not cached. Tests added: T1→T3 same-`toolUseId` escalation (must resolve T3, `approval_pending`, own audit), payload substitution (destination re-resolved, own audit), N10 source guard (no local `createHash`). Existing CAN-08 L1/L3 same-action replay still one decision / one audit.

- [2026-08-18T12:57:36Z] [GB] MUTATION-PROVEN: temporarily used identity-only key `tenantId \0 roleId \0 toolUseId`. Broker suite 26 pass / 2 fail — T3 reuse returned `allow`/`T1_draft` (no approval, no second audit); mutated payload did not re-call `getCapability`. Restored §3a key; 28/28 green.

- [2026-08-18T12:57:36Z] [GB] Test_Evidence:
  - `pnpm --filter @oikonomos/broker test` — 28/28 pass
  - `pnpm lint` — exit 0
  - `pnpm canaries` — 10 files, 14 passed / 2 skipped (CAN-08 included)
  - First `pnpm -r test` failed in `services/worker` (`getRun`/`startRun` is not a function). Cause: stale gitignored `packages/db/dist` missing `runs` exports. Outside Owned_Paths; rebuilt locally with `pnpm --filter @oikonomos/db build` (dist/ is gitignored, not committed).
  - `pnpm -r test` after that rebuild — exit 0 (broker 28/28; worker 3 passed / 3 skipped; evals-harness 14 passed / 2 skipped).

Ready for review.
