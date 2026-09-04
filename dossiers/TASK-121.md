# TASK-121 — Group thread control-api endpoints

## Work Log

- [2026-09-04T05:47:41Z] [CX] Preflight completed: `services/control-api/src/app.ts` and `services/control-api/src/ports.ts` exist; the owned test glob resolves to `auth.test.ts` and `chat.routes.test.ts`. Blocked before implementation: `@oikonomos/db` exports only 1:1 `createThread`/`getOrCreateThreadForRole` APIs requiring a non-empty `roleId`; it provides `addThreadMember`/`listThreadMembers` but no public accessor to create a `threads` row with `role_id = NULL` or list nullable/group thread rows. TASK-121 may only change control-api files, while the OIK-084 port boundary forbids route/port SQL. A DB accessor expansion is required before `POST /threads/group` can create the real group thread required by the acceptance criteria.
