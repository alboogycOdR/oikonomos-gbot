# TASK-119 — Bot permissions view: list and revoke standing grants (Grants-1c)

## Work Log

- [2026-09-04T07:35:00Z] [S5] Session start. Checkpoint at `.devteam/CHECKPOINT.md` referenced a
  stale TASK-118 (already `done`, merged by ORCH per PLAN.md history) — deleted it and confirmed
  the real active claim, TASK-119, from PLAN.md fresh. Created branch `task/TASK-119-s5` off
  `mainco/master` (40fe4ba).

- [2026-09-04T08:05:00Z] [S5] Implemented all four pieces of the task:
  1. `packages/db/src/database.ts`: added `revokeRoleGrant(roleId, capabilityId)` — a plain
     `DELETE FROM role_grants WHERE role_id = $1 AND capability_id = $2`, mirroring the file's
     existing method style exactly (per spec).
  2. `services/control-api/src/ports.ts`: added `listRoleGrants`/`revokeRoleGrant` to
     `ControlApiDeps` and their `createDatabaseBackedDeps` bindings (same `withDatabase` pattern
     as `upsertRoleGrant`).
  3. `services/control-api/src/app.ts`: added `GET /roles/:roleId/grants` (200, via
     `deps.listRoleGrants`) and `DELETE /roles/:roleId/grants/:capabilityId` (204, via
     `deps.revokeRoleGrant`). Both sit under the existing global fail-closed auth `preHandler`
     (no `public: true` override) — verified via the "rejects every new route without a session"
     401 test.
  4. `apps/dashboard/src/components/chat/RightPanel.tsx`: extended the Members tab with a
     "Permissions" section — real grants (capability id + tier) for `activeRoleId`, revoke button
     per row.

- [2026-09-04T08:10:00Z] [S5] **Ownership gap, documented (mirrors TASK-118's own accepted gap):**
  `apps/dashboard/src/lib/api.ts`, `ChatShell.tsx`, `ChatPage.tsx`, `types.ts` are NOT in this
  task's `Owned_Paths`. Two consequences, both handled the same way TASK-118 handled its own
  three-file gap (kept optional, degrades safely, documented rather than silently accepted):
  - `RightPanel`'s grant list/revoke calls are made with a direct `fetch()` inside
    `RightPanel.tsx` itself (same `credentials: "same-origin"` / `VITE_CONTROL_API_BASE_URL`
    convention `api.ts` uses), rather than adding helper functions to `api.ts` — that file is
    outside this task's territory.
  - `RightPanel` takes a new optional `activeRoleId?: string` prop. The Permissions section
    doesn't render without it, and nothing in `ChatShell.tsx` (outside `Owned_Paths`) passes it
    yet — same degrade-safely pattern TASK-118 left for `ApprovalCard`'s roleId/capabilityId/
    maxTier gap. **A follow-up task threading `activeRoleId` from `ChatShell`/`ChatPage` down to
    `RightPanel` is needed to make this visible in the live app** (candidate fast-follow, same
    shape as TASK-123 was for TASK-118).

- [2026-09-04T08:15:00Z] [S5] Tests written:
  - `packages/db/src/database.test.ts` (new file): real-Postgres suite for
    `listRoleGrants`/`upsertRoleGrant`/`revokeRoleGrant`. Discovered `role_grants.role_id` FKs to
    `roles` (migration 004) — not just `capability_id` to `capabilities` — so the fixture now
    inserts both. Proves AC1 (DELETE removes exactly the targeted row, a second capability's
    grant is untouched) directly against `Database`, not only reachable through the connector
    registration path.
  - `services/control-api/src/chat.routes.test.ts`: unit tests for GET/DELETE with fake deps
    (401-without-session extended to both new routes; list returns exactly what the fake
    returns; revoke calls through with the right `(roleId, capabilityId)`), plus two real-Postgres
    integration tests — GET round-trips against `database.listRoleGrants` directly, and DELETE
    proves the row is gone via `database.getRoleGrant` (the exact read
    `packages/broker/src/capabilityRegistry.ts`'s fail-closed gate uses) while a second
    capability's grant survives untouched. AC4 ("attempted again in a real chat run") is proven
    at this mechanism level — the same read the broker's live gate depends on — rather than by
    re-driving a full live SDK chat run; this mirrors ORCH's own accepted reasoning for TASK-118's
    equivalent AC ("re-testing the same mechanism, not new risk surface"), since `packages/broker`
    itself is a protected path outside this task's territory and untouched by this diff.
  - `apps/dashboard/src/components/chat/RightPanel.test.tsx`: 3 existing tests untouched/still
    passing; 4 new tests — no permissions section without `activeRoleId`; fetches and lists real
    grants (asserts the real endpoint URL + `credentials: "same-origin"`); revoke removes the row
    after the DELETE resolves; a failed revoke shows an error and keeps the row.

- [2026-09-04T08:20:00Z] [S5] Full verification, all packages touched by this diff:
  - `pnpm --filter @oikonomos/db build/test` — 27/27 files, 125/127 (2 intentionally skipped —
    no-DATABASE_URL guard, not applicable here since DATABASE_URL was set), all green.
  - `pnpm --filter @oikonomos/control-api build/test` — 7/7 files, 121/121 green (18 in
    `chat.routes.test.ts`, incl. 4 new TASK-119 tests: 2 unit + 2 real-Postgres integration).
  - `pnpm --filter @oikonomos/dashboard build/test` — 16/16 files, 64/64 green (7 in
    `RightPanel.test.tsx`, incl. 4 new TASK-119 tests).
  - `pnpm -r build` — 17/17 workspace projects, clean.
  - `pnpm lint` — clean, zero findings.
  - `pnpm -r test` (full recursive, per CLAUDE.md's DEVDEPARTMENT amendment) — one failure,
    `packages/agent-providers`'s `test/providers.grok.test.ts` ("streams stdout chunks as
    text_delta..." timed out at 5000ms). Confirmed pre-existing and unrelated to this diff:
    `packages/agent-providers` is untouched by any file in this task's `Owned_Paths`; re-ran that
    package isolated (`pnpm --filter @oikonomos/agent-providers test`) and it passed clean, 96/96
    — a subprocess-timing flake (same shape as the pre-existing flake TASK-118's own evidence
    documented in `packages/worker`), not a regression from this change.

- Status → `needs_review`.
