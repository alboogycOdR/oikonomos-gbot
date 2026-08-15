# TASK-021 dossier

## Work Log

- [2026-08-15T16:27:00Z] [CX] Resumed as a newly claimed strict-control task: no prior dossier or local task branch existed, so created `task/TASK-021-cx` from the claimed integration head. Preflight output: `[preflight] TASK-021 Owned_Paths inspected in C:/CLAUDECODE_TOOLSETS/wt-codex-oikonomos` / `[preflight] 1 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.` / `GLOB infra/ci/** -> 12 file(s): infra/ci/README.md, infra/ci/banned-modes-allowlist.txt, infra/ci/banned-modes.mjs, infra/ci/hooks/pre-commit, infra/ci/lib/allowlist.mjs, infra/ci/lib/walk.mjs, infra/ci/protected-path-review.mjs, infra/ci/run-local.mjs, infra/ci/secret-scan.mjs, infra/ci/test-banned-modes.mjs, infra/ci/test-protected-path-review.mjs, infra/ci/test-secret-scan.mjs.`
- [2026-08-15T16:31:00Z] [CX] Implemented the ADR-005 controls-live gate and induced-failure self-test. The current unscanned ATLAS database correctly reports `last scan: never`; this is expected to fail the new gate until the index is scanned, rather than being masked by its database mtime.
