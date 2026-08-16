# TASK-026 dossier

## Brief

ATLAS coverage: structural package-dropout assertion (residual from TASK-024).
Protected: `infra/ci`. Do not lower the numeric tolerance. Assert additionally
that no complete workspace package directory is absent from the index.

## Work Log

- [2026-08-16T11:12:00Z] [GB] Session start. Newly claimed; created `task/TASK-026-gb` from master (`2add77b`, TASK-024 merge). Preflight (c8b9872 filesystem check), verbatim:

```
[preflight] TASK-026 Owned_Paths inspected in C:/CLAUDECODE_TOOLSETS/wt-grok-oikonomos
[preflight] 2 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
  FILE   infra/ci/lib/atlas-coverage.mjs  -> exists, 304 line(s), 10711 bytes
  FILE   infra/ci/test-controls-live.mjs  -> exists, 396 line(s), 16166 bytes
[preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
```

  `git ls-files packages/agent-providers` is 4 files: package.json, src/index.ts, tsconfig.json, vitest.config.ts. Next: additional structural assertion (workspace-derived package discovery, not a tighter number); zero-baseline fixture where missing==4 still fails; keep ATLAS_COVERAGE_TOLERANCE=4 and its derivation.

- [2026-08-16T11:20:00Z] [GB] Structural dropout assertion added. `checkAtlasCoverage` still uses tolerance 4 for diffuse lag; additionally fails when every indexable file of a workspace package (globs from `pnpm-workspace.yaml`) is absent. Zero-baseline fixture: `packages/agent-providers` (4 files) missing, numeric-only still null, structural FAIL names the package and files as "package dropout, not scan lag". New-package fixture `packages/brand-new` (3 files, no hardcoded name) also fails. Four misses inside larger `packages/shared` still pass as lag. Live ATLAS PASS from this worktree and from main (7/7 on main). Worktree-only `workspace dist freshness` red on `packages/broker` (src/dist mtime after checkout; not in Owned_Paths, unchanged). `node infra/ci/test-controls-live.mjs` 19/19; other infra/ci self-tests 8+11+8+9; `pnpm -r test` exit 0. Ready for review.

- [2026-08-16T14:50:00Z] [GB] Resume on `task/TASK-026-gb` at `b4c1e44`. ORCH rework (opus-4-8): empty `droppedWorkspacePackages`/parser no-op on flow-style or missing `pnpm-workspace.yaml` is ADR-005 §2 fail-open. Preflight:

```
[preflight] TASK-026 Owned_Paths inspected in C:/CLAUDECODE_TOOLSETS/wt-grok-oikonomos
[preflight] 2 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
  FILE   infra/ci/lib/atlas-coverage.mjs  -> exists, 409 line(s), 14640 bytes
  FILE   infra/ci/test-controls-live.mjs  -> exists, 522 line(s), 21764 bytes
[preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
```

  Implementing: fail closed on zero globs and on packages/ present with zero mapped packages; `loadWorkspacePackageGlobs` returns `{globs,error}` (no throw); parse flow-style `packages: [...]` as well as block; pin tests. Tolerance stays 4.

- [2026-08-16T13:28:00Z] [GB] Rework complete. Empty/missing/unparsed/unreadable workspace yaml and unmapped `packages/` now FAIL as UNOBSERVABLE (never a silent empty dropped list). Flow-style `packages: ["packages/*", "services/*"]` parses and is collected end-to-end. Unreadable yaml (directory-named file) returns `fail()`, no throw. Tolerance still 4. Tests: `node infra/ci/test-controls-live.mjs` 21/21; banned-modes 8/8; secret-scan 11/11; protected-path-review 8/8; test-job-order 9/9; `node infra/ci/controls-live.mjs` 7/7 PASS (worktree); `pnpm -r test` exit 0. Ready for review.
