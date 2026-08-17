# TASK-039 dossier

## Brief
Close the subprocess broker-bypass TASK-029 review found only mitigated-in-principle: gateSubprocess exists in harness-factory but nothing calls it, so codex.ts/grok.ts still spawn() directly. Route both providers through an injected gate seam + ADR-005 liveness assertion. Also widen the sole-constructor guard to scan apps/ and evals/.

## Spec pointers
ADR-001 P1/L1 (every tool call through the broker); ADR-005 s2 (liveness keyed on behaviour); TASK-029 M4 (gate provided, unused) and M1 (guard blind spot); TASK-028 subprocess note. codex.ts:170 / grok.ts:122 are the direct spawn sites; gateSubprocessThroughL1 in harness-factory/src/index.ts is the gate to route through.

## Intended approach
Add an optional gateSpawn seam to codex/grok provider options (same pattern as Claude queryFn injection from TASK-028). Route every spawn through it; fail closed on deny/throw AND on absent-seam-when-required. Composition (TASK-035) wires the real gate - hence 035 depends on this. Add a liveness test that a spawn is impossible without a broker allow. Widen scanRoots in sole-constructor.test.ts to apps/ + evals/.

## Work Log
