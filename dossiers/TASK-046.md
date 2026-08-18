# TASK-046 — OIK-051 Golden-eval harness for connectors

## Brief

`@oikonomos/evals-golden` provides per-connector golden-task suites under `suites/<connector_id>/`. Its runner executes tasks through `composeHarness` and reports pass-rate against the manifest's `min_pass_rate`; G-CONN unlock decisions depend on these reports.

## Interface contract

- Suite definitions are YAML or JSON under `evals/golden/suites/<connector_id>/`; every definition is loaded and merged. The connector-id directory convention is authoritative, while `manifest.evals.suite` remains the manifest-declared artifact path for callers/reporting.
- `runSuite(connectorId, options)` accepts a fake `queryFn` for CI. Live callers inject their governed `pretooluse` and audit sink; absent injection denies tool calls fail-closed.
- The manifest dependency is intentionally a local shape mirror until the connector pipeline is consumed directly.

## Work Log

- [2026-08-18T14:54:12Z] [CX] Preflight completed before edits: `[preflight] TASK-046 Owned_Paths inspected in C:/CLAUDECODE_TOOLSETS/wt-codex-oikonomos`; `GLOB evals/golden/** -> 4 file(s): evals/golden/package.json, evals/golden/src/index.ts, evals/golden/test/scaffold.test.ts, evals/golden/tsconfig.json`. Replaced scaffold with typed YAML/JSON suite validation and a composeHarness-only runner, added the 3-task `_fixture` suite, fake-query runner tests, and a native-TS CLI that emits JSON reports. Draft-only tiers reject T3+, empty suites fail UNOBSERVABLE, and the report includes harness invocation evidence.
- [2026-08-18T14:54:12Z] [CX] Test evidence: `pnpm --filter @oikonomos/evals-golden test` — 4/4 passed; `pnpm --filter @oikonomos/evals-golden typecheck` — passed; `pnpm -r test` — passed (workspace DB integration legs skipped without DATABASE_URL); `pnpm lint` — passed; `pnpm canaries` — 15 passed, 2 DB-dependent skipped. CLI smoke: `pnpm --filter @oikonomos/evals-golden run run _fixture test/fixtures/manifest.mjs test/fixtures/query.mjs` — exit 0 and JSON report with `pass_rate: 1`, `harness_invocations: 3`.
- [2026-08-18T16:00:00Z] [CX] Resume preflight: `[preflight] TASK-046 Owned_Paths inspected in C:/CLAUDECODE_TOOLSETS/wt-codex-oikonomos`; `GLOB evals/golden/** -> 4068 file(s)` (including installed workspace dependencies; output was truncated after the first entries). Addressing review round 1 by injecting live governance seams with a fail-closed default, deriving draft tiers from the DB vocabulary, and loading every YAML/JSON definition in a suite.
- [2026-08-18T17:24:00Z] [CX] Rework complete. `RunSuiteOptions` now accepts injected broker/audit seams; its default broker denies tool calls, including Tier-3. Suites merge every YAML/JSON definition deterministically. Regression evidence: evals typecheck passed; evals tests 6/6 passed; `pnpm -r test`, `pnpm lint`, and `pnpm canaries` exited 0; CLI smoke emitted pass_rate 1 and harness_invocations 3. Mutation proof: changing the default broker decision to allow made the Tier-3 seam assertion fail (5/6 passed, 1 failed); deny implementation restored before the final green run.
