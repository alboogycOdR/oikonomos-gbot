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
node infra/ci/test-secret-scan.mjs
node infra/ci/test-protected-path-review.mjs
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
`pull_request` and `push`.

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
