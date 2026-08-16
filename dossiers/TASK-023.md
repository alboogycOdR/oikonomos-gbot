# TASK-023 dossier

## Brief

CI `test` job never builds. Workspace packages export `./dist/…` and `dist/` is
gitignored, so `pnpm -r test` cannot resolve `@oikonomos/*` on a clean checkout.

Owned_Paths: `.github/workflows/**`, `infra/ci/**`

## Work Log

- [2026-08-16T09:45:00Z] [GB] Session start. Branch `task/TASK-023-gb` created from master (detached worktree was at bdc702c). Preflight (c8b9872 filesystem check), verbatim:

```
[preflight] TASK-023 Owned_Paths inspected in C:/CLAUDECODE_TOOLSETS/wt-grok-oikonomos
[preflight] 2 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
  GLOB   .github/workflows/**  -> 1 file(s):
           .github/workflows/ci.yml
  GLOB   infra/ci/**  -> 14 file(s):
           infra/ci/README.md
           infra/ci/banned-modes-allowlist.txt
           infra/ci/banned-modes.mjs
           infra/ci/controls-live.mjs
           infra/ci/hooks/pre-commit
           infra/ci/lib/allowlist.mjs
           infra/ci/lib/walk.mjs
           infra/ci/protected-path-review.mjs
           infra/ci/run-local.mjs
           infra/ci/secret-scan.mjs
           infra/ci/test-banned-modes.mjs
           infra/ci/test-controls-live.mjs
           ... and 2 more
[preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
```

  Live `ci.yml` `test` job is install-then-`pnpm test` with no build. `run-local.mjs` already runs `pnpm build` before `pnpm test`, which is exactly the local-green / CI-red split the task names. Next: add build to the hosted test job, keep the local mirror on the same order, and add an ADR-005 check that fails if that order regresses.

- [2026-08-16T09:52:00Z] [GB] Implementation in territory only. Hosted `test` job now `pnpm build` then `pnpm test`. `run-local.mjs` keeps the same order and runs `test-test-job-order.mjs`. New `infra/ci/lib/test-job-order.mjs` parses the workflow's `test` job `run:` steps (a parallel `build` job does not count) and the local `run('…', 'pnpm', ['build'|'test'])` calls. Wired into `controls-live` as `CI test job builds before test`. Induced-failure coverage in `test-controls-live.mjs` plus dedicated self-test.

- [2026-08-16T09:55:00Z] [GB] Tests. `node infra/ci/test-test-job-order.mjs`: 9/9 pass (live order, no-build fail, reversed fail, parallel-build-job does not satisfy, run-local regressions, and a fixture workspace where `pnpm test` cannot resolve `@fixture/lib` until `dist/` exists). `node infra/ci/test-controls-live.mjs`: 8/8 pass. `test-banned-modes` 8/8, `test-secret-scan` 11/11, `test-protected-path-review` 8/8, `banned-modes` clean, `secret-scan` clean. `controls-live` PASS on the new check; FAIL `devteam control queue` for `TASK-016-2026-08-16T09-40-39Z.json` in the main checkout — sibling CX dispatch, not drained (shared `.devteam/control`, out of territory).

- [2026-08-16T09:58:00Z] [GB] Clean-tree demonstration (this worktree). Removed all 14 workspace `dist/` dirs (packages/* and services/*). `pnpm --filter @oikonomos/approvals test` then failed: 11/13 files, `Failed to resolve entry for package "@oikonomos/db"` / `"@oikonomos/shared"`. Immediately after: `pnpm build` (14 packages, BUILD_OK) then `pnpm test` (`pnpm -r test`) exit 0. Approvals recovered to 9 passed | 4 skipped (13 files), 43 passed | 14 skipped. That is the CI-equivalent local sequence on a tree that had no `dist/`.

- [2026-08-16T10:00:00Z] [GB] Stopping at needs_review. Handing off. Full run-local not claimed green because controls-live's queue check sees TASK-016's undrained block in the main checkout; the new ordering check itself is PASS. Protected-path gate self-test green; the live gate still requires Fable marker on this protected diff (ORCH/reviewer).
