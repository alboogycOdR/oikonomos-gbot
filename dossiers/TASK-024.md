# TASK-024 dossier

## Brief

ATLAS index liveness assertion (descoped from TASK-021). Protected: `infra/ci/**`.
Key on main-checkout coverage via `git rev-parse --git-common-dir`, not commit
topology or timestamps. Do not write `.devteam/`.

## Work Log

- [2026-08-16T10:28:10Z] [GB] Session start. Newly claimed; created `task/TASK-024-gb` from this worktree HEAD (`38cdba1`, TASK-023 merge). Preflight (c8b9872 filesystem check), verbatim:

```
[preflight] TASK-024 Owned_Paths inspected in C:/CLAUDECODE_TOOLSETS/wt-grok-oikonomos
[preflight] 1 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
  GLOB   infra/ci/**  -> 16 file(s):
           infra/ci/README.md
           infra/ci/banned-modes-allowlist.txt
           infra/ci/banned-modes.mjs
           infra/ci/controls-live.mjs
           infra/ci/hooks/pre-commit
           infra/ci/lib/allowlist.mjs
           infra/ci/lib/test-job-order.mjs
           infra/ci/lib/walk.mjs
           infra/ci/protected-path-review.mjs
           infra/ci/run-local.mjs
           infra/ci/secret-scan.mjs
           infra/ci/test-banned-modes.mjs
           ... and 4 more
[preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
```

  Live measurement from this worktree against the MAIN checkout index (`C:\CLAUDECODE_TOOLSETS\oikonomos\.devteam\atlas.db`): 256 indexed, 256 tracked indexable after atlas filters, 1 missing (`packages/shared/test/prng.ts`, valid UTF-8 — scan lag, not a decode skip), 1 extra (`AUTOPILOT_LOG.md`, gitignored but walked by scan). Next: coverage check with a stated lag-window tolerance, fail-closed on absent/unreadable main index, induced-failure self-test that names the missing files.

- [2026-08-16T10:33:03Z] [GB] Implemented ATLAS coverage liveness. `collectAtlasCoverageEvidence` resolves the main checkout via `git rev-parse --git-common-dir`, reads that checkout's `.devteam/atlas.db` read-only (`file:…?mode=ro`), and compares against `git ls-files` filtered by atlas text extensions + ignore/exclude patterns. Tolerance is 8 (justified: live delta 1, diagnosis delta 4; empty/unreadable still fail-closed). Wired as the seventh `controls-live` check. Induced-failure self-test points at a fixture index missing named files and requires a non-zero result that lists them. Live `node infra/ci/controls-live.mjs` from this worktree: all 7 PASS, including ATLAS. `node infra/ci/test-controls-live.mjs`: 13/13. All other infra/ci self-tests green. `node infra/ci/run-local.mjs --approval-marker fable-reviewed`: all runnable jobs green (includes `pnpm -r test`). No write to `.devteam/`. Ready for review.

