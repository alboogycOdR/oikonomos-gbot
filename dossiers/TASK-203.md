# TASK-203 — Wire real production LiveAgentPort

Unit: GB. Branch: `task/TASK-203-gb`. control.mode=strict (no PLAN.md writes; supervisor applies state from the `devteam-control` block).

## Preflight (Owned_Paths check, pasted verbatim)

```
[preflight] TASK-203 Owned_Paths inspected in E:/DELL-PROJECTS/wt-grok-GROKBOT-CLONE
[preflight] 5 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
  FILE   services/control-api/src/ports.ts  -> exists, 651 line(s), 28184 bytes
  FILE   services/control-api/src/index.ts  -> exists, 57 line(s), 2616 bytes
  FILE   services/control-api/src/liveAgent.routes.test.ts  -> exists, 460 line(s), 19115 bytes
  FILE   services/control-api/package.json  -> exists, 42 line(s), 992 bytes
  FILE   pnpm-lock.yaml  -> exists, 5126 line(s), 170638 bytes
[preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
```

Review_Findings: — (no REWORK). Prior session correctly blocked on `pnpm-lock.yaml` ownership (TASK-185); ORCH unblocked after TASK-185 merged and widened Owned_Paths to include `services/control-api/package.json` + `pnpm-lock.yaml`.

## Work Log

- [2026-09-07T00:17:01Z] [GB] Session start. Resumed claimed TASK-203 on existing `task/TASK-203-gb` (no unique commits yet; working tree clean). Dossier did not exist. Preflight output above. Next: add `@oikonomos/sandbox-client` to control-api, implement `createDatabaseBackedLiveAgent` (getRoleSandbox + getEndpoint with `use_server_proxy=true`), wire it in `index.ts` the same way TASK-193 wired `ThreadContextPort`, and prove it against real Postgres plus a fake lifecycle-proxy transport.
- [2026-09-07T00:20:00Z] [GB] Added `@oikonomos/sandbox-client` workspace dep (package.json + pnpm-lock.yaml). Implemented `createDatabaseBackedLiveAgent` in `ports.ts`: tenant-scoped `getRole` + `getRoleSandbox` for AC1; `getEndpoint(sandboxId, 44772, true)` plus a fail-closed `/proxy/{port}` URL check and `http→ws` PTY path for AC2. Wired it into `index.ts#start` next to `createDatabaseBackedThreadContext`.
- [2026-09-07T00:23:24Z] [GB] Tests and verification complete. Handing to needs_review.

## Implementation

`createDatabaseBackedLiveAgent` (ports.ts), same shape as TASK-193's `createDatabaseBackedThreadContext`:

- `getActiveSandbox(roleId, tenantId)` — `getRole` then `getRoleSandbox`. Other-tenant / missing role / missing sandbox all return `null` (empty state, never a thrown 404).
- `getPtyViewerEndpoint(sandboxId)` — real `SandboxClient.getEndpoint(sandboxId, 44772, true)`. Resulting URL must be the lifecycle proxy (`/proxy/{port}`); a directly-published 30xxx port is refused. Converts `http(s)` → `ws(s)` and appends `/pty/{id}/ws?mode=viewer&since=0`. Execd token is attached as `X-EXECD-ACCESS-TOKEN` via the existing `secret://` resolver; never logged.
- Production `start()` passes `{ threadContext, liveAgent }` into `buildApp`. Client construction is lazy so missing `SANDBOX_INTEGRATION_URL` does not prevent boot; first PTY resolve fail-closes.

## Acceptance criteria

- [x] AC1 — a real `role_sandboxes` row is resolvable through the production port against live Postgres; status route returns `{ available: true, state: "Running" }`. Other-tenant sandbox is `null`.
- [x] AC2 — `getEndpoint` is called with `(sandboxId, 44772, true)`; the real client request is `/endpoints/44772?use_server_proxy=true`; resulting URL is `ws://…/proxy/44772/pty/…`; a direct `:30017` endpoint is refused.
- [x] AC3 — `pnpm -r build` exit 0; `pnpm lint` exit 0. Targeted live-agent tests 19/19. Full recursive `pnpm -r test` hits pre-existing shared-Postgres flakes documented below (zero diff in those packages).

## Test evidence

- `pnpm --filter @oikonomos/control-api exec vitest run src/liveAgent.routes.test.ts` — **19/19 pass** (13 TASK-171 route/relay tests unchanged + 6 TASK-203 production-port tests, including two DATABASE_URL-gated Postgres cases).
- `pnpm --filter @oikonomos/control-api exec vitest run src/liveAgent.routes.test.ts test/no-raw-sql.test.ts` — **33/33 pass** (ports.ts/index.ts still have no raw SQL / no `pg` import).
- `pnpm --filter @oikonomos/control-api typecheck` — exit 0.
- `pnpm -r build` — exit 0 (18/18 packages).
- `pnpm lint` — exit 0, no output.
- `pnpm --filter @oikonomos/control-api test` — 239/240. The one failure is `chat.routes.test.ts` "creates real memberships… expected 'started' to be 'waiting_approval'". **Pre-existing:** identical failure on parent commit with TASK-203 changes stashed (`git stash` → same assertion, same file, zero diff from this task). Outside Owned_Paths; not caused by LiveAgentPort wiring (`buildApp` in that test does not pass `liveAgent`).
- `pnpm -r test` — failed first in `packages/db` `roles.test.ts` "deadlock detected" (migration-004 backfill ALTER TABLE under parallel workspace load). Package is outside Owned_Paths; same class of shared-Postgres flake already tracked (TASK-199). Recursive run stops at first package failure (`ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL`), so later packages including control-api were not reached in that invocation.

## Territory

Changed files: `services/control-api/src/ports.ts`, `services/control-api/src/index.ts`, `services/control-api/src/liveAgent.routes.test.ts`, `services/control-api/package.json`, `pnpm-lock.yaml`, `dossiers/TASK-203.md`. No PLAN.md writes.
