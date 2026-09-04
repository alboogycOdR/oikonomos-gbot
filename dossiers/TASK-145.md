# TASK-145 Dossier

## Work Log

- [2026-09-04T20:55:00Z] [CX] Preflight completed before code changes. The task is blocked by an ownership boundary: approvals are created by `issueApproval` inside `services/worker/src/chatRunDriver.ts` (also reachable through `packages/approvals/src/issue.ts`), neither of which is an owned path. `services/control-api/src/ports.ts` can wrap the resolving `ChatRunDriver.run()` call to notify on a successful run completion, but has no callback, event, or observable result that identifies an approval at creation time. Polling `listPendingApprovals` after a run is neither atomic nor scoped to a run and would create false/missed notifications. A narrow callback/hook in the worker/approval creation path, or an explicit territory widening to that file, is required before the approval-created acceptance criterion can be implemented honestly. Preflight output:

```text
[preflight] TASK-145 Owned_Paths inspected in E:/DELL-PROJECTS/wt-codex-GROKBOT-CLONE
[preflight] 9 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
  GLOB   infra/postgres/migrations/**  -> 18 file(s):
           infra/postgres/migrations/001_schema_v1.down.sql
           infra/postgres/migrations/001_schema_v1.up.sql
           infra/postgres/migrations/002_approval_binding.down.sql
           infra/postgres/migrations/002_approval_binding.up.sql
           infra/postgres/migrations/003_intake_nonces.down.sql
           infra/postgres/migrations/003_intake_nonces.up.sql
           infra/postgres/migrations/004_roles_routines_rules.down.sql
           infra/postgres/migrations/004_roles_routines_rules.up.sql
           infra/postgres/migrations/005_agent_memory.down.sql
           infra/postgres/migrations/005_agent_memory.up.sql
           infra/postgres/migrations/006_memory_acl_versioning.down.sql
           infra/postgres/migrations/006_memory_acl_versioning.up.sql
           ... and 6 more
  NEW    packages/db/src/deviceTokens.ts  -> does not exist; parent packages/db/src/ exists
  NEW    packages/db/src/deviceTokens.test.ts  -> does not exist; parent packages/db/src/ exists
  FILE   packages/db/src/index.ts  -> exists, 136 line(s), 2890 bytes
  FILE   services/control-api/src/app.ts  -> exists, 1035 line(s), 39647 bytes
  FILE   services/control-api/src/ports.ts  -> exists, 173 line(s), 7599 bytes
  NEW    services/control-api/src/pushTransport.ts  -> does not exist; parent services/control-api/src/ exists
  NEW    services/control-api/src/pushTransport.test.ts  -> does not exist; parent services/control-api/src/ exists
  GLOB   services/control-api/src/**/*.test.ts  -> 3 file(s):
           services/control-api/src/auth.test.ts
           services/control-api/src/chat.routes.test.ts
           services/control-api/src/sse.test.ts
[preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
```

- [2026-09-04T21:11:20Z] [CX] Resumed the dispatcher-preserved worktree, reviewed the revised composition design, and committed the complete implementation as `4473b15 feat(push): add device registry and notifications [TASK-145]`. Added migration 010 and the DB device-token module (idempotent registration, listing, permanent-failure removal), authenticated `POST /devices`, env-gated FCM HTTP transport plus collecting/disabled fakes, and post-run control-api notification derivation. Push delivery broadcasts to all registered devices with the per-user-auth limitation documented in code; provider errors log only a fixed message and are swallowed. Verified direct source search finds no logging of device tokens, FCM keys, or credentials. Tests run with Node v22.23.2: `pnpm --filter @oikonomos/db test` — 28 files, 139 passed/2 skipped; `pnpm --filter @oikonomos/control-api test` — 10 files, 140 passed; `pnpm -r test` — exit 0; `pnpm -r build` — exit 0; `pnpm lint` — exit 0. Worktree clean and ready for review.
