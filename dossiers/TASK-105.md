# TASK-105 Dossier

## Work Log

- [2026-09-02T19:24:00Z] [CX] Started new branch `task/TASK-105-cx` from `master`. Preflight completed: `infra/postgres/migrations/**` exists (14 files); `packages/db/src/threads.ts`, `messages.ts`, `threads.test.ts`, and `messages.test.ts` are NEW territory; `packages/db/src/index.ts` exists (107 lines). Blocked before implementation: Chat spec §3 requires `threads.role_id UUID NOT NULL REFERENCES roles(id)`, while the live roles schema in migration 004 defines only `roles.role_id text PRIMARY KEY` (no `roles.id`). A UUID FK to that existing text key is impossible without a schema/spec change outside owned paths. Supervisor decision needed: amend the spec to use `role_id text REFERENCES roles(role_id)`, or provide an owned migration/plan that introduces UUID role identity.
