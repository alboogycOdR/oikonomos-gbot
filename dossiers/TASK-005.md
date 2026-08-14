# TASK-005 — OIK-005/006 Lint enforcement: N9 (query() only in harness-factory) + policy purity

**Brief:** Two custom ESLint rules that turn non-negotiables into build failures: no Agent SDK query() outside packages/harness-factory (N9), and zero I/O imports inside packages/policy.

**Spec pointers:** WBS OIK-005/006 acceptance. CLAUDE.md non-negotiables (N9; "packages/policy has zero I/O imports (lint-enforced)").

**Intended approach:** eslint.config.mjs flat config at root (safe: TASK-001 done first, no concurrent root-file owner); custom rules in infra/lint/rules/ with RuleTester tests. Rule 1: flag import/require of @anthropic-ai/claude-agent-sdk (and query identifier usage from it) in any file not under packages/harness-factory; message names the sanctioned path. Rule 2: in packages/policy/**, flag imports of fs, net, http(s), dns, child_process, worker_threads, pg/db drivers, and process.env member access. Wire pnpm lint root script.

## Work Log
