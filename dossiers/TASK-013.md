# TASK-013 — OIK-021 approvals issue + bind ⚑ protected

**Brief:** Issue an approval carrying digest, render, destination, nonce and expiry — persisted **before** the agent is told to wait.

**Spec pointers:** Handover §4.3 (binding contract, canonical JSON + sha256). WBS OIK-021. Synthesis §5.1 (`approvals` table). N10 — `packages/shared` owns the only canonical-JSON/digest implementation; importing it is mandatory and a second implementation is automatic rework.

**Intended approach:** Persist-then-signal ordering, with a test that proves the ordering rather than assuming it — a crash between signalling and writing would strand a run against an approval that does not exist. Nonces from a CSPRNG, never `Math.random` or a counter.

## Work Log

- [2026-08-15T14:20:00Z] [GB] Dispatcher-claimed (control.mode=strict). HEAD was detached at 4f139a0; created `task/TASK-013-gb` from current `master` (e9052f6, post TASK-020 merge). Did not re-claim. Preflight (c8b9872) before any code:

```text
[preflight] TASK-013 Owned_Paths inspected in C:/CLAUDECODE_TOOLSETS/wt-grok-oikonomos
[preflight] 3 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
  GLOB   packages/approvals/src/**  -> 1 file(s):
           packages/approvals/src/index.ts
  GLOB   packages/approvals/test/**  -> matches nothing yet (new territory)
  FILE   packages/approvals/vitest.config.ts  -> exists, 8 line(s), 166 bytes
[preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
```

  Territory as expected: existing stub `src/index.ts`, NEW `test/**`, existing `vitest.config.ts`. TASK-020 delivered `insertApproval` + `getApprovalByNonce` — this task will consume them from `@oikonomos/db` and will not open its own pool or write SQL. Digest via `@oikonomos/shared` `actionDigest` only (N10). Next: implement issue + bind, persist-then-signal, CSPRNG nonces, unit + integration tests.

- [2026-08-15T13:44:00Z] [GB] Implementation complete on `task/TASK-013-gb`. `issueApproval` binds via `@oikonomos/shared` `actionDigest`, generates a CSPRNG nonce (`crypto.randomUUID`), awaits `insertApproval`, then returns `{ reason: "approval_pending", ... }`. Persist-before-wait is proven by a gated store (signal does not resolve until insert completes) plus a real-DB assert that `getApprovalByNonce` finds the row at the moment the wait signal is in hand. No SQL and no second digest implementation. Isolated `pgvector/pgvector:pg16` on 127.0.0.1:55434 (not the shared compose volume); container removed after the run.

  Test evidence:
  - `DATABASE_URL=<isolated> pnpm --filter @oikonomos/approvals test` — 16/16 pass (9 issue unit + 3 nonce + 1 N10 source scan + 3 integration: persist-then-wait field set, DatabaseOptions path, 16-way concurrent unique nonces).
  - `pnpm --filter @oikonomos/approvals test` without DATABASE_URL — 13 passed / 3 skipped (integration suite skips cleanly).
  - `pnpm --filter @oikonomos/approvals typecheck` and `build` exit 0; `pnpm lint` exit 0; `node infra/ci/secret-scan.mjs` clean; `git diff --check` clean.

  Ready for review.