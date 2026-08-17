# @oikonomos/evals-harness

CI-blocking canary suite for the harness composition root (OIK-039 / CAN-01…CAN-08).

## Run

From the repo root (clean checkout after `pnpm install`):

```
pnpm canaries
```

Or:

```
pnpm --filter @oikonomos/evals-harness test
```

## Design

Canaries compose the real enforcement path in-process:

- `handlePreToolUse` from `@oikonomos/broker`
- `composeHarness` from `packages/harness-factory/src/compose.ts`
- fake injected I/O ports (capability / role grant / audit / approvals)

No live HTTP listener. CAN-06 and CAN-07 additionally run against Postgres when `DATABASE_URL` is set, and are visibly skipped when it is not.

CAN-03 reuses `infra/ci/banned-modes.mjs` (ADR-002 Amendment A). ORCH wires the GitHub Actions job at merge.
