# TASK-106 Dossier — control-api thread/message/role endpoints (Chat-1b)

## Work Log

- [2026-09-02T19:20:00Z] [CX] Resumed from dispatcher claim on `task/TASK-106-cx`; no prior dossier existed. Ran the required territory preflight before modifying any code:

  ```text
  [preflight] TASK-106 Owned_Paths inspected in E:/DELL-PROJECTS/wt-codex-GROKBOT-CLONE
  [preflight] 4 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    NEW    services/control-api/src/routes/threads.ts  -> does not exist; parent directory E:/DELL-PROJECTS/wt-codex-GROKBOT-CLONE/services/control-api/src/routes does NOT exist either
    NEW    services/control-api/src/routes/roles.ts  -> does not exist; parent directory E:/DELL-PROJECTS/wt-codex-GROKBOT-CLONE/services/control-api/src/routes does NOT exist either
    NEW    services/control-api/src/index.ts (additive route registration only — do not touch existing route handlers)  -> does not exist; parent services/control-api/src/ exists
    GLOB   services/control-api/src/**/*.test.ts (new test files only)  -> matches nothing yet (new territory)
  [preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
  ```

- [2026-09-02T19:26:00Z] [CX] Blocked before implementation: the required live HTTP router is `services/control-api/src/app.ts` (`buildApp` registers every current route), but it is outside TASK-106 `Owned_Paths`. `src/index.ts` only exports/starts `buildApp`; adding route modules there cannot make routes live. The injected `ControlApiDeps` in out-of-territory `services/control-api/src/ports.ts` exposes only `createTask` and no `startRun`, role, thread, or message accessors, so the specified message endpoint cannot reuse the creation path to create a task and run without extending that port. `POST /roles` likewise needs role/grant access through that port. Please add `services/control-api/src/app.ts` and `services/control-api/src/ports.ts` to TASK-106 `Owned_Paths` (and clarify the endpoint count: specification lists six GET/POST routes while AC says five).

- [2026-09-03T10:00:00Z] [CX] Resumed after the dispatcher/ORCH corrected the intended ownership to `app.ts`, `ports.ts`, and tests (the branch's copied PLAN snapshot still has the old entries). Re-read Chat spec §4 and live implementations. The only existing control-api task creation path is `POST /tasks` → `ControlApiDeps.createTask` → `@oikonomos/db.createTask`; it inserts a `tasks` row only. No existing control-api helper/path starts a run (`startRun` occurs only in worker and test code), so implementing the chat post route's task+run requirement would require a new parallel lifecycle implementation or a new shared helper outside territory. Separately, public DB role APIs expose `createRole`/`listRoles` but no default-general-role grant operation; the only T1 grant helper (`seedInboxTriage`) is fixed to `inbox-triage`, while generic grant mutation is an instance method on `Database`, not a safe reusable role-creation function. Need ORCH to identify/authorize the canonical task+run creation helper and generic default-role grant helper (or assign their implementation) before adding endpoints. No source changes made.
