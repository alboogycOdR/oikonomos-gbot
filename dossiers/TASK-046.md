# TASK-046 — OIK-051 Golden-eval harness for connectors

## Brief
`@oikonomos/evals-golden` (pre-scaffolded): per-connector golden-task suites under `suites/<connector_id>/` and a runner that executes tasks through the governed harness (composeHarness) and reports pass-rate vs the manifest's `min_pass_rate`. This is the machinery every G-CONN unlock depends on.

## Spec pointers
- WBS OIK-051: "Suite runnable per connector; pass-rate reported; wired into CI" (ORCH wires CI at merge).
- Gap Closure §G1: 3–5 golden tasks per connector, ≥90%, run in DRAFT-ONLY mode (Tiers 0–2) — evals run before any G-CONN opens, so the runner must be incapable of Tier-3.
- N9: every model invocation via `composeHarness` from @oikonomos/harness-factory's public `./compose` subpath (exported since TASK-041). Direct provider calls fail lint.
- ADR-005: zero-task suite fails as unobservable; self-anchor that the harness seam was actually invoked.

## Interface contract (fixed by ORCH — build against this)
- Suite dir: `evals/golden/suites/<connector_id>/` — task files (YAML/JSON): prompt, expected-outcome assertions, allowed tiers.
- `runSuite(connectorId, opts)` → report: per-task pass/fail + suite pass-rate + min_pass_rate comparison, JSON-serialisable.
- Manifest coupling: consume only the SHAPE of Handover §4.4's `evals` block via a local type — do NOT wait on TASK-043; you run in parallel with it.
- Injected `queryFn` seam for tests (fake model, no credentials, no live endpoints — N4). Live `run` script is a separate entry.

## Intended approach
Fixture suite `suites/_fixture/` (3 tasks) proving an end-to-end run and a failing run (<1 pass-rate). Territory is `evals/golden/**` only — never root, never the lockfile (deps pre-installed).

## Work Log
