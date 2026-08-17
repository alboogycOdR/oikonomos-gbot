# TASK-029 dossier

## Brief
createHarness(deps) as the ONLY harness construction path, with L1/L2/L3 as injected DI ports so the three adapters can be built concurrently afterward. Protected; different-model review.

## Spec pointers
ADR-001 (Decision, Cost) is mandatory. Handover OIK-008. The N9 sole-constructor guard ships as a Vitest test scanning packages/**+services/** for stray SDK query().

## Intended approach
ports.ts = interfaces; config.ts = L2 allowedTools type; index.ts = pure factory taking ports as args, NO hard-import of concrete adapters. Composition root deferred to OIK-039.

## Work Log

- [2026-08-17T13:55:00Z] [GB] Session start on claimed TASK-029. Worktree was detached at dc57024 (TASK-028 merge); created `task/TASK-029-gb`. Preflight (c8b9872 filesystem check), verbatim:

```
[preflight] TASK-029 Owned_Paths inspected in C:/CLAUDECODE_TOOLSETS/wt-grok-oikonomos
[preflight] 7 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
  FILE   packages/harness-factory/src/index.ts  -> exists, 14 line(s), 363 bytes
  NEW    packages/harness-factory/src/ports.ts  -> does not exist; parent packages/harness-factory/src/ exists
  NEW    packages/harness-factory/src/config.ts  -> does not exist; parent packages/harness-factory/src/ exists
  NEW    packages/harness-factory/test/factory.test.ts  -> does not exist; parent directory C:/CLAUDECODE_TOOLSETS/wt-grok-oikonomos/packages/harness-factory/test does NOT exist either
  NEW    packages/harness-factory/test/sole-constructor.test.ts  -> does not exist; parent directory C:/CLAUDECODE_TOOLSETS/wt-grok-oikonomos/packages/harness-factory/test does NOT exist either
  FILE   packages/harness-factory/package.json  -> exists, 28 line(s), 566 bytes
  FILE   pnpm-lock.yaml  -> exists, 2387 line(s), 76854 bytes
[preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
```

  Implementing createHarness(deps) as a pure factory: ports.ts (L1/L3 + spawn gate + optional PostToolUse), config.ts (L2 dontAsk + allowedTools type only), index.ts wires injected ports onto SDK query options. No hard-import of OIK-034/035/036 adapters. Codex/Grok spawn gated through L1 as Bash. Next: add SDK dep, run package + full recursive tests.

- [2026-08-17T13:59:00Z] [GB] Implementation complete. `createHarness({ l1, l2, l3 })` is the sole constructor: L1 becomes a 10s PreToolUse hook matcher, L2 locks `dontAsk` + allowedTools onto every `query()` call, L3 is the `canUseTool` callback. Optional `postToolUse` port declared for OIK-037. Codex/Grok `gateSubprocess` presents spawn as `Bash` to L1 (fail-closed). N9 Vitest guard scans packages/** + services/** for SDK imports and stray `createHarness` definitions. Banned-mode tokens assembled at runtime; none appear as literals.

  Test_Evidence:
  - `pnpm --filter @oikonomos/harness-factory test` — 12/12 pass (src ping 1, factory 10, sole-constructor 1)
  - `pnpm --filter @oikonomos/harness-factory typecheck` exit 0
  - `pnpm --filter @oikonomos/harness-factory build` exit 0
  - `pnpm lint` exit 0
  - `node infra/ci/banned-modes.mjs` — clean
  - `pnpm -r test` — 14/15 workspace projects, 258 passed / 31 skipped (prior 247 + 11 new factory tests)
  Ready for review.

