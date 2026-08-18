# TASK-042 dossier

## Brief

OIK-041 HIGH-2: wire the E4 enforcement chain into a production caller (`services/worker`) plus an ADR-005 §2 liveness assertion keyed on a broker audit event.

## Work Log

- [2026-08-18T13:35:00Z] [GB] Session start. Newly claimed (dispatcher already set `Status: claimed` / `Branch: task/TASK-042-gb`). Worktree was on `task/TASK-040-gb`; created `task/TASK-042-gb` from `master` (`9c059be`). Did not re-claim. control.mode=strict: PLAN.md not touched. Preflight:

```
[preflight] TASK-042 Owned_Paths inspected in C:/CLAUDECODE_TOOLSETS/wt-grok-oikonomos
[preflight] 5 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
  GLOB   services/worker/src/**  -> 2 file(s):
           services/worker/src/index.ts
           services/worker/src/runLifecycle.ts
  GLOB   services/worker/test/**  -> 1 file(s):
           services/worker/test/runLifecycle.test.ts
  FILE   services/worker/package.json  -> exists, 33 line(s), 728 bytes
  FILE   pnpm-lock.yaml  -> exists, 3282 line(s), 102666 bytes
  GLOB   evals/harness/test/**  -> 11 file(s):
           evals/harness/test/can-01-tier3-no-approval.test.ts
           evals/harness/test/can-02-bare-name-l1-still-denies.test.ts
           evals/harness/test/can-03-banned-modes.test.ts
           evals/harness/test/can-04-broker-fail-closed.test.ts
           evals/harness/test/can-05-subagent-tier3.test.ts
           evals/harness/test/can-06-replay-consumed-nonce.test.ts
           evals/harness/test/can-07-payload-mutation.test.ts
           evals/harness/test/can-08-l1-l3-one-decision.test.ts
           evals/harness/test/can-subprocess-gate.test.ts
           evals/harness/test/helpers.ts
           evals/harness/test/workspace.test.ts
[preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
```

  Approach: `executeTaskRun` is the worker's agent-invocation path. It imports `composeHarness` from `@oikonomos/harness-factory/compose` (public entry; not a relative source path, not `createHarness`) and always binds the real `handlePreToolUse` from `@oikonomos/broker`. Codex/Grok factories live in the same package so `services/**` depends on harness-factory + broker + agent-providers. Liveness keys on a `recordDecision` event the broker writes when the composed harness's L1 hook fires — not on an import existing. Next: implement + mutation-prove the bypass case.

- [2026-08-18T13:40:00Z] [GB] Implementation complete. `executeTaskRun` composes via `@oikonomos/harness-factory/compose` and drives `harness.query`. Worker now depends on `@oikonomos/harness-factory`, `@oikonomos/broker`, and `@oikonomos/agent-providers`. `createGatedSubprocessProviders` injects the compose-bound spawn gate. Liveness test requires a broker `recordDecision` event from a worker-driven Read (T0). CAN-09 drives a worker Tier-3 call and requires `require_approval` + park.

  MUTATION-PROVEN: temporarily made `executeTaskRun` call `queryFn` without `composeHarness`. Liveness assertion went RED (`expected 0 to be greater than 0` — no audit event). Restored compose path; suite green.

  Test_Evidence:
  - `python scripts/preflight_paths.py TASK-042` — 5 entries, all FILE/GLOB exist
  - `pnpm --filter @oikonomos/worker test` — 10 passed / 3 skipped (DB-gated runLifecycle)
  - `pnpm --filter @oikonomos/harness-factory test -- test/sole-constructor.test.ts` — 2/2 pass
  - `pnpm canaries` — 11 files, 15 passed / 2 skipped (CAN-09 included)
  - `pnpm lint` — exit 0
  - `pnpm -r test` — exit 0
  - Bypass mutation: e4-liveness "keys on a broker decision audit event" FAILED as required; restored

  Ready for review.
