# infra/ci — CI jobs that also run locally

OIK-002 / OIK-003 / OIK-004 / OIK-007. Protected path. There is no remote yet, so every
job is runnable from this directory. Root `package.json` scripts are **not**
owned here (ORCH 15:15Z): call `pnpm typecheck`, `pnpm build`, `pnpm test`,
and `pnpm lint` (the last arrives with TASK-005). Grep and secret-scan are
invoked directly.

## Local entrypoints

```
node infra/ci/run-local.mjs [--approval-marker fable-reviewed]
node infra/ci/banned-modes.mjs
node infra/ci/secret-scan.mjs
node infra/ci/test-banned-modes.mjs
node infra/ci/test-controls-live.mjs
node infra/ci/test-secret-scan.mjs
node infra/ci/test-protected-path-review.mjs
node infra/ci/test-test-job-order.mjs
node infra/ci/protected-path-review.mjs --base <base-ref>
sh infra/ci/hooks/pre-commit          # same scan as CI, against the staged index
```

Install the pre-commit hook from the repo root:

```
ln -sf ../../infra/ci/hooks/pre-commit .git/hooks/pre-commit
```

On Windows (Git Bash): `cp infra/ci/hooks/pre-commit .git/hooks/pre-commit`

## Banned-mode grep (OIK-004 / CAN-03)

`banned-modes.mjs` implements ADR-002 Amendment A. The allowlist is
`banned-modes-allowlist.txt`, next to the grep, and cites that amendment.

- **Enforcement surfaces (scanned, no exceptions):** `packages/**`,
  `apps/**`, `services/**`, `infra/**`, `evals/**`, `.github/**`,
  `.claude/settings*.json`, `.claude/agents/**`. Hard-coded in
  `lib/allowlist.mjs` so a carve-out line cannot override them.
- **Prose + §2(2) carve-outs:** `docs/**`, `specs/**`, `dossiers/**`,
  `briefings/**`, `.claude/commands/**`, `PLAN.md`, `REVIEW.md`,
  `AUTOPILOT_LOG.md`, `INSTINCTS.md`, root `*.md`, `autopilot.json`,
  `scripts/**`.

Tokens are assembled at runtime so this `infra/**` path never contains them
(ADR-002 §1). Self-test plants a violation under a temporary `packages/`
tree (must fail) and checks the current checkout against the same allowlist
(must pass).

## Secret scan (OIK-007)

`secret-scan.mjs` fails closed on known key/token/PEM patterns. The self-test
plants an obviously-fake key that contains `PLACEHOLDER` text — never a
realistic-looking value (N4). The same scanner backs the pre-commit hook
(`--staged`) and the CI `secret-scan` job.

ADR-002 Amendment A exempts exactly one named file, `hooks/run-tests.js`
(the DEVDEPARTMENT pack's own detector corpus). Not a glob.

## Workflow

`.github/workflows/ci.yml` defines `lint`, `typecheck`, `test`, and `build`
(each fails the run when red) plus `banned-modes` and `secret-scan`. Triggers:
`pull_request` and `push`. The `test` job runs `pnpm build` before `pnpm test`
because every workspace package `exports` map points at gitignored `dist/`;
a clean checkout has no `dist/` and `@oikonomos/*` imports cannot resolve
otherwise (TASK-023). A parallel `build` job does not populate the `test`
job's workspace. `run-local.mjs` uses the same build-then-test order.
`controls-live` fails if either file regresses to test-without-build.

## Protected-path review (OIK-003)

`.github/CODEOWNERS` assigns Fable review ownership for the protected paths in
`CLAUDE.md`: broker, policy, approvals, harness factory, CI, ADRs, and all
control-plane configuration (`.claude/**`, `.codex/**`, and `hooks/**`). It
also protects the CODEOWNERS file and CI workflow themselves so the enforcement
cannot be weakened without review.

CODEOWNERS is inert until this repository has a GitHub remote and its branch
protection requires Code Owner review. Replace `@basileia/fable-reviewers`
with the provisioned GitHub review team when that remote is configured.

Until then, `run-local.mjs` is the operative local control: it runs the real
`protected-path-review.mjs` gate against the merge-base of `HEAD` and the local
integration branch (`master`, with `main` as a fallback), as well as running
its self-test. A protected diff fails unless an independent Fable reviewer supplies
`--approval-marker fable-reviewed` to `run-local.mjs`; a clean, unprotected
diff passes without a marker. The marker demonstrates the local gate only; it
does not substitute for GitHub's authenticated required Code Owner review once
a remote exists.

## Control liveness (ADR-005)

`controls-live.mjs` is **local-only**. It is invoked by `run-local.mjs` and
is not a job in `.github/workflows/ci.yml`. Hosted CI does not run this
gate (there is no remote yet; the operative surrogate is this directory).
The ATLAS coverage check reads the main-checkout index through a Python
interpreter (`python`, `python3`, or `py` — the same three-way probe as
`scripts/dispatch.ps1`). A machine with none of those on `PATH` fails
closed with an interpreter-missing diagnostic; it does not imply the
index is corrupt.

`controls-live.mjs` verifies that controls emitted evidence of doing their
work; configuration, database mtimes, and no-op exit codes are not evidence.
The job fails `run-local.mjs` if any of these checks is inert:

- The installed territory pre-commit hook is run through Git against an
  alternate staged index containing `AGENTS.md`, which is outside CX's
  `infra/ci/**` territory. The check requires the hook to reject that attempted
  commit; a hook file or installer confirmation alone is not liveness evidence.
- The main checkout's `.devteam/control/` must exist and contain no queued JSON
  control blocks, which is the observable result of creating and draining the
  control queue. The job resolves that checkout from Git's common directory,
  rather than reading this worktree's independent gitignored `.devteam/`.
  A missing main-checkout directory fails because it makes the drain state
  unobservable.
- Every active builder must have a concrete `model` pin in the dispatcher
  registry. This is an explicit registry invariant required by ADR-005.
- An ordinary `packages/policy` test invocation must print Vitest's v8 coverage
  report, proving coverage was collected rather than only configured. ANSI
  terminal colour is stripped before reading the emitted report.
- Every workspace package with `src/` must have a `dist/` newer than its source;
  failures name the package and seconds behind (or missing output). This keeps
  tests from silently executing old exported build output.
- The MAIN checkout's ATLAS index (resolved via `git rev-parse --git-common-dir`,
  never this worktree's `.devteam/atlas.db`) must contain every tracked
  indexable source file, within a stated lag-window tolerance of 4 (the
  largest missing-file delta observed on this repo: 1, 2, and the spec-time
  4 — not padded headroom). Dispatch refreshes only the main checkout; a
  worktree copy is never maintained. Failures name the missing files and
  the counts. An empty `git ls-files` result is unobservable, not healthy.
  Commit-count and timestamp staleness are not used — they drift with every
  orchestration commit. An absent or unreadable main-checkout index fails
  closed.

Liveness checks are controls too: their self-test deliberately induces an
inert state for every assertion and requires a non-zero result. They can rot
just like the controls they watch, so keep both the check and its induced-
failure proof in the local CI run.
