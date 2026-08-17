# TASK-032 dossier

## Brief
Fix permissionMode=dontAsk and validate the allowedTools allowlist; REJECT bare-name entries unless ADR-named (R1/F2). The config-layer half of CAN-02, the most important test in the project. Protected.

## Spec pointers
ADR-001 L2/R1/F2; directive §6. Scoped forms allowed, bare names rejected.

## Intended approach
Own only src/l2/allowed-tools.ts + test. Note L1 still denies regardless; L2 is defence in depth.

## Work Log

- [2026-08-17T19:42:00Z] [GB] Session start on claimed TASK-032 (`task/TASK-032-gb` created from origin/master; no re-claim). Preflight (c8b9872 filesystem check), verbatim:

```
[preflight] TASK-032 Owned_Paths inspected in C:/CLAUDECODE_TOOLSETS/wt-grok-oikonomos
[preflight] 2 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
  NEW    packages/harness-factory/src/l2/allowed-tools.ts  -> does not exist; parent directory C:/CLAUDECODE_TOOLSETS/wt-grok-oikonomos/packages/harness-factory/src/l2 does NOT exist either
  NEW    packages/harness-factory/test/l2/allowed-tools.test.ts  -> does not exist; parent directory C:/CLAUDECODE_TOOLSETS/wt-grok-oikonomos/packages/harness-factory/test/l2 does NOT exist either
[preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
```

  Spec read: ADR-001 L2/R1/F2, WBS OIK-036, directive §6. Implementing standalone L2 validator (factory must not import it — TASK-029 forbids `l2/allowed-tools`). `createL2Policy` locks `dontAsk`; rejects bare names unless ADR-named (registry empty); CAN-02 `mcp__gmail__send_message` rejected. Next: tests + typecheck/lint.

- [2026-08-17T19:45:30Z] [GB] L2 validator complete. `createL2Policy` / `validateL2Policy` lock `permissionMode: "dontAsk"` and reject bare-name `allowedTools` (`BARE_NAME`) unless an ADR-named registry entry supplies adr + justification (production `ADR_NAMED_BARE_TOOLS` is empty). Scoped forms (`Bash(ls *)`, `Read(src/**)`) accepted. CAN-02 config-layer: `mcp__gmail__send_message` rejected. Unlisted tools are off the explicit surface (dontAsk hard-deny). Factory not imported — composition root (TASK-035) will wire this.

  Test_Evidence:
  - `pnpm --filter @oikonomos/harness-factory test` — 33/33 pass (src ping 1, factory 10, pretooluse 10, allowed-tools 11, sole-constructor 1)
  - `pnpm --filter @oikonomos/harness-factory typecheck` exit 0
  - `pnpm lint` exit 0
  - `node infra/ci/banned-modes.mjs` — clean
  - `pnpm -r test` — 14/15 workspace projects, 279 passed / 31 skipped (prior 268 + 11 new L2 tests)
  Ready for review.
