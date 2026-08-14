# TASK-004 — OIK-002/004/007 CI skeleton + banned-mode grep + secret scan ⚑ protected

**Brief:** The CI pipeline skeleton, the N2 banned-mode grep implemented per ADR-002 §4, and secret scanning. Protected path (infra/ci): author GB, reviewer ORCH on opus-4-8 — different-model rule holds. Repo has no remote yet, so local runnability of every job is the demonstrable acceptance.

**Spec pointers:** WBS OIK-002/004/007. ADR-002 §4 (grep patterns: bypassPermissions, acceptEdits, --dangerously-skip-permissions; allowlist = ADR-002 §2 paths + docs/decisions/**, cited beside the grep). ADR-001 CAN-03 (what this job will grow into). N4 (fixture keys must be obviously fake — the DEVDEPARTMENT secret-scan hook mechanically blocks realistic-looking ones).

**Intended approach:** .github/workflows/ci.yml with lint/typecheck/test/build jobs calling pnpm scripts; infra/ci/banned-modes.(sh|mjs) + infra/ci/banned-modes-allowlist.txt citing ADR-002; self-test fixture proving catch + current-repo pass. Secret scan: gitleaks (or script) in CI + pre-commit hook config; planted fixture uses PLACEHOLDER-structured fake.

## Work Log

### [2026-08-14T17:15:00Z] [GB] Session start — resume of claimed task, branch created

Dispatcher said resume; PLAN.md Branch was `task/TASK-004-gb` but the branch did not exist (ORCH salvage note: previous wave killed before GB created it). Created `task/TASK-004-gb` from worktree HEAD `8fc9b43`. Did not re-claim. control.mode=strict — PLAN.md not touched.

Read: ADR-002 §2/§4, WBS OIK-002/004/007, Directive §4/§6, ADR-001 CAN-03, ORCH 15:15Z clarification (do not add root package.json scripts; call `pnpm typecheck`/`build`/`test` and `pnpm lint` if present; grep/secret-scan live under infra/ci/).

Preflight (`python scripts/preflight_paths.py TASK-004`) — c8b9872 filesystem check, pasted verbatim:

```
[preflight] TASK-004 Owned_Paths inspected in C:/CLAUDECODE_TOOLSETS/wt-grok-oikonomos
[preflight] 2 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
  GLOB   .github/**  -> matches nothing yet (new territory)
  GLOB   infra/ci/**  -> matches nothing yet (new territory)
[preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
```

Both globs are NEW. Will not touch root package.json (TASK-005 grant).

Live-tree note (not yet a block): a faithful ADR-002 §4 allowlist leaves prohibition-text hits outside the carve-out (PLAN.md, specs/, dossiers/, DEVDEPARTMENT_HANDOVER_PROMPT.md). Implementing the closed allowlist first; will not widen it without an ADR/ORCH answer.

Next: write workflow + scanners + self-tests.

### [2026-08-14T18:10:00Z] [GB] Implementation complete; blocking on closed-allowlist vs current-repo-pass

Delivered under Owned_Paths only (plus this dossier). No PLAN.md, no root package.json.

Artifacts:
- `.github/workflows/ci.yml` — lint / typecheck / test / build (each fails the run when red) + banned-modes + secret-scan; `on: pull_request` and `push`
- `infra/ci/banned-modes.mjs` + `banned-modes-allowlist.txt` — ADR-002 §4 closed set, tokens assembled at runtime (this `infra/**` path contains zero banned literals)
- `infra/ci/secret-scan.mjs` + `infra/ci/hooks/pre-commit` — same scanner for CI and staged index
- `infra/ci/test-banned-modes.mjs`, `infra/ci/test-secret-scan.mjs`
- `infra/ci/run-local.mjs`, `infra/ci/README.md`, `infra/ci/lib/{walk,allowlist}.mjs`

Self-tests that do not depend on the live tree: 7/7 pass
- allowlist cites ADR-002 and equals exactly: autopilot.json, CLAUDE.md, AGENTS.md, docs/**, docs/decisions/**, .claude/commands/**, briefings/**, scripts/**
- each of the three tokens planted under a temp `packages/policy/src/` path is caught
- allowlisted docs/CLAUDE.md hits are not violations
- planted fakePlaceholderKey() (assembled `sk` + PLACEHOLDER_FAKE_…, never written contiguously here) is caught
- pre-commit hook source invokes `secret-scan.mjs --staged`
- same scanner path catches the planted fixture
- clean text / `CHANGE_ME_LOCAL_ONLY` does not match

Local CI job mirrors (ORCH 15:15Z — existing root scripts, no package.json edits):
- `pnpm typecheck` exit 0 (14/14)
- `pnpm build` exit 0 (14/14)
- `pnpm test` exit 0 (14/14 workspaces, 1 test each)
- `pnpm lint` — `Command "lint" not found` (TASK-005 not merged). Noted per ORCH; other three demonstrated green.

Current-repo-pass tests fail, and I will not paper over them:

OIK-004 closed allowlist hits (prohibition text, not product runtime):
- `PLAN.md:106` (this task's own Description)
- `specs/OIKONOMOS_BUILD_DIRECTIVE_v1.0.md:40` and `:48`
- `dossiers/TASK-004.md:5` (ORCH decompose brief)
- `DEVDEPARTMENT_HANDOVER_PROMPT.md:41`

OIK-007: `hooks/run-tests.js` matches OpenAI/Anthropic-style API key, GitHub token, AWS access key ID, and private key block (pack fixture literals that look like real vendor examples, not PLACEHOLDER-marked).

I cannot satisfy both "allowlist contains only ADR-002 §2 + docs/decisions/**" and "current repo passes" without either widening the allowlist (forbidden by the other AC) or editing files outside Owned_Paths (`PLAN.md` forbidden in strict mode; `specs/**` read-only; `hooks/` pack-owned). Stopping. Branch `task/TASK-004-gb`.

ORCH question (need exactly one answer per issue):
1. Banned-mode current-repo-pass — (A) amend ADR-002 §4 and this task to add `PLAN.md`, `specs/**`, `dossiers/**`, `DEVDEPARTMENT_HANDOVER_PROMPT.md` as prohibition-text carve-outs; (B) ORCH strips the tokens from those four files; or (C) other.
2. Secret-scan current-repo-pass — (A2) allowlist `hooks/run-tests.js`; (B2) restrict the scan to product paths (`packages/**`, `apps/**`, `services/**`, `infra/**`, `evals/**`, `.github/**`); or (C2) ORCH rewrites those pack fixtures to PLACEHOLDER form.

### [2026-08-14T19:05:00Z] [GB] Resume — ORCH unblocked via ADR-002 Amendment A

Resuming on `task/TASK-004-gb` @ f866c36. Did not re-claim or re-branch. PLAN.md not touched (control.mode=strict).

ORCH 18:45Z chose option A generalised (Amendment A) plus A2 (single-file secret-scan exemption). Re-read ACs and `docs/decisions/ADR-002-permission-bypass-ban-scope.md` Amendment A from the main checkout (this worktree is one commit behind master's ADR write; docs/ is read-only here).

Implementing:
- allowlist = Amendment A prose + §2(2) dev-tooling globs (not the old closed file list)
- enforcement surfaces hard-scanned, no exceptions even if listed as carve-outs
- secret-scan exempts exactly `hooks/run-tests.js`

Next: rewrite allowlist + scanners + self-tests, then local CI mirrors.

### [2026-08-14T18:50:00Z] [GB] Amendment A applied; all ACs met; ready for review

Implemented ADR-002 Amendment A on `task/TASK-004-gb`. Territory only: `.github/**`, `infra/ci/**`, plus this dossier. No PLAN.md, no root package.json.

Preflight after implementation (c8b9872):

```
[preflight] TASK-004 Owned_Paths inspected in C:/CLAUDECODE_TOOLSETS/wt-grok-oikonomos
[preflight] 2 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
  GLOB   .github/**  -> 1 file(s):
           .github/workflows/ci.yml
  GLOB   infra/ci/**  -> 10 file(s):
           infra/ci/README.md
           infra/ci/banned-modes-allowlist.txt
           infra/ci/banned-modes.mjs
           infra/ci/hooks/pre-commit
           infra/ci/lib/allowlist.mjs
           infra/ci/lib/walk.mjs
           infra/ci/run-local.mjs
           infra/ci/secret-scan.mjs
           infra/ci/test-banned-modes.mjs
           infra/ci/test-secret-scan.mjs
```

What changed vs the earlier SPEC_AMBIGUITY stop:
- `banned-modes-allowlist.txt` now cites Amendment A; active entries are the prose + §2(2) set (globs, not a closed file list).
- `lib/allowlist.mjs` hard-codes enforcement surfaces so a carve-out line cannot skip `packages/**`, `apps/**`, `services/**`, `infra/**`, `evals/**`, `.github/**`, `.claude/settings*.json`, `.claude/agents/**`.
- `secret-scan.mjs` exempts exactly `hooks/run-tests.js` (named file, not a glob).
- Self-tests cover catch, prose pass, enforcement-cannot-be-overridden, staged-index catch, current-repo pass.

Acceptance:
- [x] Workflow defines lint/typecheck/test/build (+ banned-modes, secret-scan) on PR and push
- [x] Local mirrors: typecheck/build/test green; lint not merged (TASK-005); grep/secret-scan invoked directly
- [x] Banned-mode grep fails on planted packages/ tokens; current repo passes under Amendment A
- [x] Allowlist cites Amendment A and implements the split exactly
- [x] Secret scan blocks planted PLACEHOLDER fixture (CI path + staged/pre-commit); exemption is the one named file
- [x] No edits outside .github/** and infra/ci/** (plus this dossier)

Test_Evidence:
- `node infra/ci/test-banned-modes.mjs` — 6/6 pass
- `node infra/ci/test-secret-scan.mjs` — 9/9 pass
- `node infra/ci/banned-modes.mjs` — clean
- `node infra/ci/secret-scan.mjs` — clean
- `pnpm typecheck` — exit 0, 14/14
- `pnpm build` — exit 0, 14/14
- `pnpm test` — exit 0, 14/14 workspaces, 1 stub test each
- `pnpm lint` — Command "lint" not found (TASK-005 not merged; noted per ORCH 15:15Z)

Ready for review.
