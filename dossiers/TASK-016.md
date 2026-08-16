# TASK-016 — OIK-027 broker PreToolUse handler ⚑ protected

**Brief:** The decision handler behind `POST /v1/broker/pretooluse`, as a library function. Composes policy + approvals + audit. Every request audited, allow or deny.

**Spec pointers:** Handover §4.1 (request and the three response shapes, verbatim — match field for field), §4.2 (tier resolution, unregistered ⇒ deny). ADR-001 (L1 is the enforcement point). **ADR-003 — the known trap.**

**Intended approach:** No web framework; the HTTP surface is OIK-084/E9. Convert `role_grants.max_tier` explicitly at the boundary: it is a CEILING and the resolver parameter is a FLOOR, and passing it straight through type-checks, runs, and fails OPEN (a T1-capped role against a T3 capability would resolve to T3). Carry the ADR-003 negative test with the ceiling below the capability default.

## Work Log
- [2026-08-16T09:39:00Z] [CX] Preflight completed before implementation: `[preflight] TASK-016 Owned_Paths inspected in C:/CLAUDECODE_TOOLSETS/wt-codex-oikonomos` / `[preflight] 3 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.` / `GLOB packages/broker/src/** -> 1 file(s): packages/broker/src/index.ts` / `GLOB packages/broker/test/** -> matches nothing yet (new territory)` / `FILE packages/broker/vitest.config.ts -> exists, 8 line(s), 166 bytes`. Read Build Directive §§3–4, Handover §§4.1–4.2, ADR-001, and ADR-003; beginning broker implementation on task/TASK-016-cx.
- [2026-08-16T09:40:03Z] [CX] Completed handler and contract tests. `pnpm --filter @oikonomos/broker test` (6/6), typecheck, and build pass; workspace `pnpm lint`, `pnpm -r typecheck`, `pnpm -r build`, and `pnpm -r test` all exit 0 (DB integration suites skip cleanly without DATABASE_URL).
