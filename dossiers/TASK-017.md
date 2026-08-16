# TASK-017 — OIK-028/029/030 broker idempotency, fail-closed, kill switch ⚑ protected

**Brief:** The three properties that make the broker trustworthy under failure. Sequenced behind TASK-016 in the same territory.

**Spec pointers:** WBS OIK-028/029/030. ADR-001 R2 (idempotent per `toolUseId`), R3 (fail closed), CAN-04 (broker 500/timeout ⇒ deny + park), CAN-08 (one audit event for L1+L3).

**Intended approach:** Idempotency must REPLAY the stored decision, not recompute it — recomputing means a policy change mid-call could return two different answers for one tool use. Fail-closed cases (>10s timeout, 500, malformed body) each get their own test. The kill switch must be read per request, never cached at startup, since the acceptance says no restart is required.

## Work Log

- [2026-08-16T10:48:00Z] [CX] Preflight territory check (verbatim):
  ```text
  [preflight] TASK-017 Owned_Paths inspected in C:/CLAUDECODE_TOOLSETS/wt-codex-oikonomos
  [preflight] 3 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    GLOB   packages/broker/src/**  -> 1 file(s):
             packages/broker/src/index.ts
    GLOB   packages/broker/test/**  -> 1 file(s):
             packages/broker/test/pretooluse.test.ts
    FILE   packages/broker/vitest.config.ts  -> exists, 8 line(s), 166 bytes
  [preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
  ```
- [2026-08-16T10:49:00Z] [CX] Implemented toolUseId replay caching, a per-request capability kill switch, audited fail-closed handling for typed transport faults, malformed capability data, and internal dependency exceptions. Audit-writer failure returns an explicit deny with `auditEventId: "unavailable"`; it cannot audit that denial through the failed writer.
- [2026-08-16T10:49:00Z] [CX] Added independent tests for timeout, HTTP 500, malformed body, each required dependency failure, L1/L3 replay, no-restart kill-switch change, and a real issue/consume payload-mutation rejection. Verification passed: `pnpm lint`; `pnpm typecheck`; `pnpm build`; `pnpm test` (all exit 0; broker 19/19 tests).
- [2026-08-16T13:09:00Z] [CX] Addressed the review blockers: replay decisions are now keyed by tenant, role, and tool-use ID; entries expire after the 10-second hook window and cache size is LRU-bounded at 1,024. Added cross-tenant/role isolation and expiry regressions, plus an unmutated real-approval consume control. Verification passed: `pnpm --filter @oikonomos/broker test` (21/21), `pnpm --filter @oikonomos/broker typecheck`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, and `pnpm test` (all exit 0; database-backed integration suites skipped without DATABASE_URL).
- [2026-08-16T11:26:06Z] [CX] Completed round-two cache rework against ADR-007: a named 60-second L1-to-L3 replay window replaces the unrelated response-deadline TTL; settled decisions have liveness-tested LRU eviction while in-flight decisions are never evicted. Added independent tenant and role isolation checks plus explicit post-expiry recomputation coverage. Verification passed: `pnpm --filter @oikonomos/broker test` (24/24); `pnpm --filter @oikonomos/broker typecheck`; `pnpm lint`; `pnpm typecheck`; `pnpm build`; and `pnpm test` (all exit 0; database-backed integration suites skipped without `DATABASE_URL`).
- [2026-08-16T12:00:10Z] [CX] Closed round-three's remaining replay-cache gap. The in-flight regression now advances fake time beyond ADR-007 §2.4a's 60-second L1-to-L3 window before replaying the held request; it proves one lookup, one audit, and equal responses. Removing `!replay.settled ||` made that test fail (24 tests: 23 pass, 1 fails; second computation/audit observed), then restoring it returned broker tests to 24/24 green. Updated the constant comment to cite ADR-007 §2.4a. ADR-007 records OIK-084 as the owner of future measured L1-to-L3 timing; no HTTP deadline implementation was added here. Final verification: `pnpm --filter @oikonomos/broker test` 24/24; `pnpm --filter @oikonomos/broker typecheck`; `pnpm lint`; `pnpm typecheck`; `pnpm build`; and `pnpm test` all exit 0 (database-backed suites skipped without `DATABASE_URL`).
