# TASK-365 dossier

**Brief:** Group room end-to-end scenario tests (verifies G-04 group routing, never exercised for real).

The group routing code (groupRouting.ts, groupFanout.ts, the control-api routes) is wired but has only unit and route tests. Write deterministic end-to-end scenarios against real Postgres with FAKE model providers and a fake Tier-0 scorer (no paid calls, no network): (a) an unaddressed message reaches exactly one bot chosen by the scorer, and its reply lands in the thread; (b) an @mention routes to that bot and skips the scorer; (c) @everyone fans out to every member; (d) a bot reply that triggers other bots loops until the TASK-359 caps stop it, with exactly one visible notice and one group.cap_reached audit event; (e) the fallback reasons of TASK-335 are audited. Put shared setup in scenarioHarness.ts. Place the files where both the control-api routes and the worker fanout are importable; if that is impossible inside these Owned_Paths, stop with OWNERSHIP_CONFLICT naming the exact paths. If a scenario exposes a real wiring defect, do NOT paper over it: mark that scenario with a failing assertion kept as `it.fails` plus a dossier entry with the evidence, and stop with a blocked report naming the source file, so ORCH can file the fix.

**Assigned:** CX9. **Depends on:** —.

**Spec pointers:** specs/OIKONOMOS_GROKBOT_PARITY_REMAINING_WORK_2026-09-16.md ("Not covered by this pass": live verification of G-04 group routing is an open question); TASK-121 group threads; TASK-335 routing fallbacks; TASK-359 room caps

**Approach:** Read the Description and Acceptance_Criteria in PLAN.md, then the current code in Owned_Paths, before changing anything. Work on the pre-cut branch from master (`git branch --show-current` should be task/TASK-365-cx9). Run tests in the FOREGROUND and wait for them to finish before emitting the control block. Every review requires `pnpm build` and `pnpm typecheck` to exit 0 (Flutter tasks: `flutter test` plus `flutter analyze lib`).

## Work Log
