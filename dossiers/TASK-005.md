# TASK-005 — OIK-005/006 Lint enforcement: N9 (query() only in harness-factory) + policy purity

**Brief:** Two custom ESLint rules that turn non-negotiables into build failures: no Agent SDK query() outside packages/harness-factory (N9), and zero I/O imports inside packages/policy.

**Spec pointers:** WBS OIK-005/006 acceptance. CLAUDE.md non-negotiables (N9; "packages/policy has zero I/O imports (lint-enforced)").

**Intended approach:** eslint.config.mjs flat config at root (safe: TASK-001 done first, no concurrent root-file owner); custom rules in infra/lint/rules/ with RuleTester tests. Rule 1: flag import/require of @anthropic-ai/claude-agent-sdk (and query identifier usage from it) in any file not under packages/harness-factory; message names the sanctioned path. Rule 2: in packages/policy/**, flag imports of fs, net, http(s), dns, child_process, worker_threads, pg/db drivers, and process.env member access. Wire pnpm lint root script.

## Work Log

- [2026-08-14T15:09:27Z] [CX] Preflight before implementation:
  ```text
  [preflight] TASK-005 Owned_Paths inspected in C:/CLAUDECODE_TOOLSETS/wt-codex-oikonomos
  [preflight] 2 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    NEW    eslint.config.mjs  -> does not exist; parent ./ exists
    GLOB   infra/lint/**  -> matches nothing yet (new territory)
  [preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
  ```
  The checked-out worktree was detached at the dispatcher claim commit and `task/TASK-005-cx` did not yet exist, so created that task branch. Blocking before implementation: TASK-005 requires a root `pnpm lint` script, but root `package.json` is outside its `Owned_Paths` and presently exposes only `typecheck`, `build`, and `test`. Need ORCH to add `package.json` to TASK-005 ownership or create a dedicated integration task for that script.
