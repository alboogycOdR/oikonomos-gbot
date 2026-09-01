# TASK-085 — packages/memory + migration 005 — three scopes, three tiers, one conflict order

**Assigned_To:** S5 · **Depends_On:** —

## Brief

Fill the `packages/memory` stub with the three-scope / three-tier memory model taken from the live Grok Bot probe: scopes `agent | project | user`, tiers `profile | log | note`, conflict order agent > project > user.

## Spec pointers

specs/OIKONOMOS_WBS_Addendum_F_v1.0.md §3.3 (F6), §9 OIK-201; docs/research/grok-bot-live-probe-2026-09-01.md Q4; CLAUDE.md non-negotiable 7 (ACL before similarity)

Read `specs/OIKONOMOS_WBS_Addendum_F_v1.0.md` §0 first — it states what this wave is and is not. `docs/decisions/ADR-010-persistent-office-computer-pivot.md` (especially its §3 'what does NOT change' and its §6 amendment) is the authority above it. `docs/research/grok-bot-live-probe-2026-09-01.md` is the empirical evidence the design is built on; where the spec cites a probe question, read that question.

## Territory

`infra/postgres/migrations/005_agent_memory.up.sql, infra/postgres/migrations/005_agent_memory.down.sql, packages/memory/src/**, packages/memory/package.json, packages/memory/vitest.config.ts`

Nothing outside this list. A file outside Owned_Paths in the diff is automatic rework, no exceptions.

## Intended approach

Migration 005 EXTENDS `profile_facts` — do not build a parallel store; the existing table already carries tenant/scope/key/value/source/confidence/expires_at. The tier split exists for context budget: only `profile` is injected every turn. Two deliberate departures from Grok Bot: memory writes are never a side effect, and one role cannot read another role's agent-scope memory at all (they can on Grok Bot's shared disk — see probe Q4).

## Work Log

- [2026-09-01T23:20:00Z] [S5] Session start. Read fresh AGENTS.md/briefing/PLAN.md. Found a stale PreCompact `.devteam/CHECKPOINT.md` pointing at TASK-084 (which was already `done`/merged by the time this session started — confirmed via PLAN.md TASK-084 block and `git log master`). Deleted the checkpoint per resume procedure and proceeded on TASK-085 (claimed, matches dispatch). Created branch `task/TASK-085-s5` from `master` (91ffdfb) — no prior branch existed, dossier had no prior work log, so this is a fresh start not a resume.
- [2026-09-01T23:55:00Z] [S5] Read house style from TASK-084's `packages/db/src/roles.ts`/`roles.test.ts` (validate-before-query, `withPool` helper, tenant-scoped reads, `import.meta.vitest` inline unit tests + colocated `.test.ts` integration suite gated on `DATABASE_URL`) and migration 004's idempotency pattern (`CREATE TABLE IF NOT EXISTS`, `DO $$ ... EXCEPTION WHEN duplicate_object`). Implemented:
  - **Migration 005** (`infra/postgres/migrations/005_agent_memory.{up,down}.sql`): extends `profile_facts` with `role_id`, `project_id`, `tier` (not a parallel table, per F6/brief). Two CHECK constraints (agent-scope requires role_id; tier ∈ profile/log/note). Widened unique key implemented as a **UNIQUE EXPRESSION INDEX** on `(tenant_id, scope, COALESCE(role_id,''), COALESCE(project_id,''), key)` rather than a plain UNIQUE constraint — standard SQL treats every NULL as distinct, so a plain constraint would silently let two `user`-scope rows (role_id AND project_id both NULL) coexist for the same key, breaking "one value per key per scope". Down migration reverses cleanly to the 001 shape.
  - **packages/memory/src**: `database.ts` (local pool helper, duplicated in miniature from packages/db since that package is out of Owned_Paths this wave), `types.ts` (scopes/tiers/DEFAULT_NOTE_TTL_MS), `facts.ts` (`writeMemoryFact` — the only write path, validates everything before any query runs; `getAgentFact`/`getProjectFact`/`getUserFact` — each hard-scoped so a caller can only ever query its own role_id, never another role's; `readProfileTier` — the every-turn injection reader, tier='profile' only), `resolve.ts` (`resolveConflict` — pure agent>project>user merge; `resolve()` — async wrapper that fetches the three candidates and applies it). `index.ts` barrel export (replaced the 13-line stub).
  - `package.json`: added `pg`/`@types/pg` deps (memory now talks to Postgres directly, mirroring packages/db's pattern since packages/db itself is out of territory).
- [2026-09-02T00:15:00Z] [S5] Verification, live against the local Postgres (`oikonomos-postgres-local` container, DATABASE_URL already set in the shell): applied 005.up, confirmed schema shape via `\d profile_facts`; ran up→up (no error, all `IF NOT EXISTS`/`duplicate_object`-guarded); ran down (schema reverted exactly to 001 shape, confirmed via `\d`); ran up→up again after the down (the down→up→up repro case) — clean, exit 0 both times.
  `pnpm --filter @oikonomos/memory typecheck` clean. `pnpm --filter @oikonomos/memory test` → 20/20 passed (5 pure resolveConflict tests, 8 input-validation tests with no DB required, 7 live-Postgres integration tests covering: CHECK constraint rejection, full agent>project>user resolve(), profile-tier-only reader excluding log/note, note TTL expiry, cross-role isolation, read/resolve/failed-write leaving the store unchanged, and upsert idempotency).
  MUTATION-PROVEN AC verified by hand, not just asserted: (1) inverted `CONFLICT_ORDER` to `["user","project","agent"]` → 3 resolve tests went RED (wrong value returned) → reverted, green again. (2) Removed the `role_id = $2` filter from `getAgentFact`'s SQL (leaving the `$2` param unused, matching the exact "removing the scope filter" wording of the AC) → the cross-role-isolation test and the "leaves store unchanged" test went RED (unrelated `pg` parameter-type error surfaced first, but the intended test still failed correctly) → restored from a pre-edit backup, green again (20/20).
  Full gate suite: `pnpm -r build` (all 16 packages/services build clean — this incidentally fixed a **pre-existing, out-of-territory** stale-dist issue in `packages/broker`'s test run: `packages/policy/dist` hadn't been rebuilt since a recent `resolveEnforcement` export landed in its source, so `pnpm -r test` before the rebuild showed 7 unrelated failures in `packages/broker/src/enforcementGate.test.ts`; not caused by anything in this diff, not in Owned_Paths, fixed itself once `packages/policy` was rebuilt — noting for the record in case ORCH sees it in history). `pnpm -r test` → all packages green including `packages/memory 20/20` and `packages/db 107/107` (unaffected). `pnpm lint` clean. `pnpm canaries` → 17/17 green.
  Committed `699fa00` on `task/TASK-085-s5`. Deliberately left `pnpm-lock.yaml` untouched even though `package.json` gained new deps — it's outside Owned_Paths and `git log --all -- pnpm-lock.yaml` shows this project's established precedent of ORCH resolving the lockfile as "merge wiring" (e.g. TASK-056/045/048/009). Handing to `needs_review`.
