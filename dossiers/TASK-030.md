# TASK-030 dossier

## Brief
PreToolUse hook that POSTs the Handover §4.1 request to the broker and maps allow/deny; the primary enforcement point P1; fails closed on transport/timeout>10s/malformed. Protected.

## Spec pointers
ADR-001 L1, R3; Handover §4.1. CAN-04 is the fail-closed canary. Consume broker via DI port; no local §4.1 reimplementation.

## Intended approach
Own only src/hooks/pretooluse.ts + test. Disjoint from L3/L2/PostToolUse so all run concurrently after OIK-033.

## Work Log

- [2026-08-17T19:29:58Z] [GB] Session start on claimed TASK-030 (`task/TASK-030-gb`, no re-claim). Preflight (c8b9872 filesystem check), verbatim:

```
[preflight] TASK-030 Owned_Paths inspected in C:/CLAUDECODE_TOOLSETS/wt-grok-oikonomos
[preflight] 2 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
  NEW    packages/harness-factory/src/hooks/pretooluse.ts  -> does not exist; parent directory C:/CLAUDECODE_TOOLSETS/wt-grok-oikonomos/packages/harness-factory/src/hooks does NOT exist either
  NEW    packages/harness-factory/test/hooks/pretooluse.test.ts  -> does not exist; parent directory C:/CLAUDECODE_TOOLSETS/wt-grok-oikonomos/packages/harness-factory/test/hooks does NOT exist either
[preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
```

  TASK-029 factory ports are on this branch. Implementing `createL1PreToolUseHook` against Handover §4.1 + ADR-001 R3: inject a broker HTTP port, POST `/v1/broker/pretooluse`, map allow/both deny forms, fail closed on transport / timeout>10s / unparseable body. No local canonical JSON or digest. Next: write adapter + tests.

- [2026-08-17T19:32:48Z] [GB] L1 adapter complete. `createL1PreToolUseHook({ broker, run })` POSTs each tool call to `/v1/broker/pretooluse` via the injected fetch port; allow (with/without `updatedInput`) and both deny forms map to `PreToolUsePortDecision`; transport / 10s abort / unparseable body / HTTP 500 fail closed. No local §4.1 type export, no canonical JSON or digest.

  Test_Evidence:
  - `pnpm --filter @oikonomos/harness-factory test` — 22/22 (src ping 1, factory 10, pretooluse 10, sole-constructor 1)
  - `pnpm --filter @oikonomos/harness-factory typecheck` exit 0
  - `pnpm lint` exit 0
  - `node infra/ci/banned-modes.mjs` — clean
  - `pnpm -r test` — 14/15 workspace projects, 268 passed / 31 skipped (prior 258 + 10 new L1 tests)
  Ready for review.

