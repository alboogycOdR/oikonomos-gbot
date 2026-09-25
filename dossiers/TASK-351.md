# TASK-351 dossier

**Brief:** Connectors and tools catalog API for the per-bot Plugins page (backend).

Add GET /roles/:roleId/tools: the capability catalog grouped by connected system (Gmail, Calendar, Drive, Browser, Workspace, ...), with id, human label and description, default tier, whether the bot holds a grant (and its maxTier), and whether it is grantable from the app (T3 or not-self-grantable = shown, not toggleable). Grant and revoke reuse the existing POST /roles/:roleId/grants and DELETE /roles/:roleId/grants/:capabilityId. Include a per-system connected flag where an account link is needed (e.g. Google OAuth), read from the existing connector state. No third-party code loading.

**Assigned:** CX9. **Depends on:** TASK-350.

**Spec pointers:** specs/OIKONOMOS_GROKBOT_PARITY_DISPOSITION_v1.0.md; memory: grok-bot-mobile-reference (owner screenshots 2026-09-04/05) row 15 (third-party plugin loading REJECTED); owner decision 2026-09-24: Plugins = connectors and tools per bot, grant on/off where allowed

**Approach:** Read the Description and Acceptance_Criteria in PLAN.md, then the current code in Owned_Paths, before changing anything. Work on the pre-cut branch from master. Run tests in the FOREGROUND and wait for them to finish before emitting the control block. Review requires `pnpm build` and `pnpm typecheck` to exit 0 (Flutter tasks: `flutter test` plus `flutter analyze lib`). A failure already on master is still named and classified, never waved off as "baseline".

## Work Log

- [2026-09-25T02:20:00Z] [CX9] Preflight completed: packages/db/src/capabilities.ts (existing); packages/db/src/capabilities.test.ts (existing); services/control-api/src/app.ts (existing); services/control-api/src/openapi.ts (existing); services/control-api/src/roleTools.routes.test.ts (new). Investigated the required per-system `connected` field before implementation. The registered catalog and role grants are exposed by `Database.listCapabilities()` / `listRoleGrants()` through `ControlApiDeps`, but no connector/account-link state exists in `packages/db` schema or source. The only OAuth/session state is runtime-only in `packages/connectors` and `services/worker` (`ConnectorSessionPool` plus OAuth token providers), is not tenant-queryable from control-api, and cannot be wired without changing unowned `services/control-api/src/ports.ts` and likely connector-state persistence. Blocked rather than inventing an inaccurate connection status or leaking credential-derived state.
