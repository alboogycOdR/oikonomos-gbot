# infra/ci — CI jobs that also run locally

OIK-002 / OIK-004 / OIK-007. Protected path. There is no remote yet, so every
job is runnable from this directory. Root `package.json` scripts are **not**
owned here (ORCH 15:15Z): call `pnpm typecheck`, `pnpm build`, `pnpm test`,
and `pnpm lint` (the last arrives with TASK-005). Grep and secret-scan are
invoked directly.

## Local entrypoints

```
node infra/ci/run-local.mjs
node infra/ci/banned-modes.mjs
node infra/ci/secret-scan.mjs
node infra/ci/test-banned-modes.mjs
node infra/ci/test-secret-scan.mjs
sh infra/ci/hooks/pre-commit          # same scan as CI, against the staged index
```

Install the pre-commit hook from the repo root:

```
ln -sf ../../infra/ci/hooks/pre-commit .git/hooks/pre-commit
```

On Windows (Git Bash): `cp infra/ci/hooks/pre-commit .git/hooks/pre-commit`

## Banned-mode grep (OIK-004 / CAN-03)

`banned-modes.mjs` implements ADR-002 §4. The allowlist is
`banned-modes-allowlist.txt`, next to the grep, and cites ADR-002. It is the
closed §2 development-tooling set plus `docs/decisions/**`. Tokens are
assembled at runtime so this `infra/**` path never contains them (ADR-002 §1).

Self-test plants a violation under a temporary `packages/` tree (must fail)
and checks the current checkout against the same allowlist (must pass).

## Secret scan (OIK-007)

`secret-scan.mjs` fails closed on known key/token/PEM patterns. The self-test
plants an obviously-fake key that contains `PLACEHOLDER` text — never a
realistic-looking value (N4). The same scanner backs the pre-commit hook
(`--staged`) and the CI `secret-scan` job.

## Workflow

`.github/workflows/ci.yml` defines `lint`, `typecheck`, `test`, and `build`
(each fails the run when red) plus `banned-modes` and `secret-scan`. Triggers:
`pull_request` and `push`.
