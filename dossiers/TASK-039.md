# TASK-039 dossier

## Brief
Close the subprocess broker-bypass TASK-029 review found only mitigated-in-principle: gateSubprocess exists in harness-factory but nothing calls it, so codex.ts/grok.ts still spawn() directly. Route both providers through an injected gate seam + ADR-005 liveness assertion. Also widen the sole-constructor guard to scan apps/ and evals/.

## Spec pointers
ADR-001 P1/L1 (every tool call through the broker); ADR-005 s2 (liveness keyed on behaviour); TASK-029 M4 (gate provided, unused) and M1 (guard blind spot); TASK-028 subprocess note. codex.ts:170 / grok.ts:122 are the direct spawn sites; gateSubprocessThroughL1 in harness-factory/src/index.ts is the gate to route through.

## Intended approach
Add an optional gateSpawn seam to codex/grok provider options (same pattern as Claude queryFn injection from TASK-028). Route every spawn through it; fail closed on deny/throw AND on absent-seam-when-required. Composition (TASK-035) wires the real gate - hence 035 depends on this. Add a liveness test that a spawn is impossible without a broker allow. Widen scanRoots in sole-constructor.test.ts to apps/ + evals/.

## Work Log

- [2026-08-17T20:35:00Z] [CX] STOPPED: after task-local checks passed, the worktree was externally reset from `task/TASK-039-cx` to detached `c87dc15`; the branch no longer exists and all TASK-039 source/test edits plus the prior work-log entry disappeared. This is a `SYNC_MISMATCH`; no code commit can be safely produced until the dispatcher restores or re-dispatches the task worktree.
- [2026-08-17T21:17:58Z] [CX] Recovered the missing `task/TASK-039-cx` branch at the current integration tip after the dispatcher reset. Added structural `gateSpawn` seams to Codex/Grok providers; both now refuse before `spawn()` when the gate is absent, denies, throws, or returns malformed data. Sentinel-CLI tests prove no OS process runs without broker allow. The sole-constructor guard now scans `apps/` and `evals/`, with an `apps/` injected-SDK-import regression fixture. Preflight: all five owned paths existed (codex.ts 258 lines, grok.ts 179, Codex tests 134, Grok tests 212, sole-constructor 96). Evidence: agent-providers 45/45; harness-factory 47/47; `pnpm lint` and `node infra/ci/banned-modes.mjs` clean. `pnpm -r test` found two unrelated existing worker failures (`getRun`/`startRun` not functions), while all TASK-039 suites passed.
