# TASK-008 — OIK-004/007 fast-follow: CI scanners honor .gitignore (walk.mjs)

**Unit:** GB  
**Branch:** task/TASK-008-gb  
**Owned_Paths:** infra/ci/lib/**, infra/ci/test-banned-modes.mjs, infra/ci/test-secret-scan.mjs

## Preflight (c8b9872)

```
[preflight] TASK-008 Owned_Paths inspected in C:/CLAUDECODE_TOOLSETS/wt-grok-oikonomos
[preflight] 3 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
  GLOB   infra/ci/lib/**  -> 2 file(s):
           infra/ci/lib/allowlist.mjs
           infra/ci/lib/walk.mjs
  FILE   infra/ci/test-banned-modes.mjs  -> exists, 177 line(s), 6500 bytes
  FILE   infra/ci/test-secret-scan.mjs  -> exists, 117 line(s), 4668 bytes
[preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
```

## Work Log

- [2026-08-14T21:25:00Z] [GB] Claimed branch task/TASK-008-gb (dispatcher pre-claimed). Preflight clean. Reproduced live failure: with .devteam/runs present, `node infra/ci/banned-modes.mjs` exits 1 on gitignored path. Implementing gitignore-aware walkFiles via `git check-ignore --stdin` + FALLBACK_SKIP_DIRS when git absent. Docs of fallback live in walk.mjs JSDoc (README.md outside Owned_Paths).
- [2026-08-14T21:40:00Z] [GB] Implemented walk.mjs gitignore awareness. Git mode only when scan root has its own `.git` (avoids home-dir parent-repo pollution on Windows %TEMP%). Filter via `git check-ignore --stdin -z` with cleaned GIT_* env. FALLBACK_SKIP_DIRS includes `.devteam` when git unavailable. Added `.db` to SKIP_EXTS. New self-tests prove tracked enforcement catch + ignored skip is check-ignore (not allowlist) + fallback path.
- [2026-08-14T21:45:00Z] [GB] All ACs verified. Ready for review.

## Test Evidence

```
node infra/ci/test-banned-modes.mjs
  8/8 pass (was 6; +2 gitignore/fallback)

node infra/ci/test-secret-scan.mjs
  11/11 pass (was 9; +2 gitignore/fallback)

# live working tree WITH .devteam/runs/fake-log.txt present
# (gitignored; contains bypassPermissions + PLACEHOLDER key shape)
node infra/ci/banned-modes.mjs  → exit 0  "clean"
node infra/ci/secret-scan.mjs   → exit 0  "clean"

# walk mode on real worktree
resolveIgnoreMode(repoRoot()) → { mode: 'git', reason: 'git-check-ignore' }
walkFiles: 220 files, 0 under .devteam/
```

## Acceptance Criteria checklist (builder-verified)

- [x] live banned-modes + secret-scan exit 0 with .devteam present
- [x] planted TRACKED enforcement violation still caught (test)
- [x] planted IGNORED path skipped; reason = gitignore (isEnforcementSurface true, isAllowlisted false, check-ignore reports path)
- [x] FALLBACK_SKIP_DIRS documented in walk.mjs JSDoc; behavior when git unavailable covers .devteam; clean checkout unchanged
- [x] existing self-tests stay green (8/8 + 11/11)

## Artifacts

- infra/ci/lib/walk.mjs
- infra/ci/test-banned-modes.mjs
- infra/ci/test-secret-scan.mjs
- dossiers/TASK-008.md
