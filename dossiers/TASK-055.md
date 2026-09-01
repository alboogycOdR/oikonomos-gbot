# TASK-055 - End-to-end governed inbox-triage run (integration, single owner)

## Brief
`services/worker` is the **shared seam** between the runtime and surface lanes, so it has exactly one owner - you. Extend `executeTaskRun` to mount a connector's MCP server with the derived allowlist, then prove the whole chain in one run.

## Spec pointers
- Directive 5 DoD - Functional (real workflow), Governed (every action through the broker), Evidenced (what data, what actions, what was denied).
- ADR-005 - the existing liveness assertion keys on a broker decision audit event; extend it to the MCP path so the control dies if MCP calls stop reaching the broker.
- OIK-038 - run lifecycle: session_ref persisted, terminal state reached.

## Intended approach
The money test: T0 list + T1 draft succeed, T3 send is **denied and audited**, in a single run. CI-green version uses fake queryFn + fake MCP transport; record a real run too if credentials exist. Do not modify `packages/**` - if the runtime lane left a gap, BLOCK rather than patch from here.

## Work Log

- [2026-09-01T16:05:00Z] [GB] Resume/start on claimed TASK-055. control.mode=strict: no PLAN.md writes. Prior dispatch died mid-planning with no branch; created `task/TASK-055-gb` from detached HEAD (a1d2ebe). Preflight (c8b9872 filesystem check):
  ```
  [preflight] TASK-055 Owned_Paths inspected in E:/DELL-PROJECTS/wt-grok-GROKBOT-CLONE
  [preflight] 2 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    GLOB   services/worker/src/**  -> 4 file(s):
             services/worker/src/executeRun.ts
             services/worker/src/index.ts
             services/worker/src/runLifecycle.ts
             services/worker/src/subprocessProviders.ts
    GLOB   services/worker/test/**  -> 4 file(s):
             services/worker/test/e4-liveness.test.ts
             services/worker/test/executeRun.test.ts
             services/worker/test/fixtures.ts
             services/worker/test/runLifecycle.test.ts
  ```
  Existing worker already calls composeHarness (TASK-041/E4) with L1 handlePreToolUse; mcpServers is NOT passed yet. ADR-005 liveness in e4-liveness.test.ts keys on a broker decision audit event for a built-in Read. Will extend executeTaskRun with optional connector context (manifest slice + resolved mcpServers + derived allowedTools), scope derived FQ names to L2 `Tool(*)` form at this seam (TASK-054 emits bare FQ names; L2 rejects those), and prove T0 list + T1 draft allow / T3 send deny+audit in one fake-queryFn run. Live URL env is set (unauthenticated); refresh token unset — live half will mount the real URL and record tools/list, not fake a send. DATABASE_URL set so OIK-038 session_ref + terminal-state can run against Postgres. Not touching packages/**.

- [2026-09-01T16:20:00Z] [GB] Implementation complete on `task/TASK-055-gb`. Connector MCP mount is only through composeHarness (N9). No packages/** edits.

  **Code**
  - `services/worker/src/executeRun.ts` — optional `connector` on `executeTaskRun`: manifest slice + already-resolved `mcpServers` + TASK-054 derived allowlist. `mcpServers` is passed only as `mcpServers: input.connector?.mcpServers` into `composeHarness`. Derived FQ names are scoped to L2 `Tool(*)` here (`toScopedAllowedTool`) because TASK-054 emits bare `mcp__server__tool` names that L2 rejects. Result carries `connector: { connectorId, mcpServerNames }` — names only, never urls (N4).
  - `services/worker/src/index.ts` — re-exports the new types/helper.

  **Tests**
  - `test/inboxTriage.e2e.test.ts` — money test: one run, T0 `mcp__gmail__list_messages` allow + fake MCP invoke, T1 `mcp__gmail__create_draft` allow + invoke, T3 `mcp__gmail__send_message` DENY `role.tier_ceiling` and **not** invoked. Audit trail answers what data / what actions / what was denied. ADR-005 MCP liveness + mutation (queryFn without composeHarness ⇒ zero broker events). OIK-038 DATABASE_URL-gated: `startTaskRun` persists `session_ref`, execute uses it, `cancelTaskRun` reaches terminal (`completed` is enum-only; TASK-034 exported no `completeRun`). Live skipIf-gated on `OIK_SECRET_MCP_GMAIL_URL`: mounts the provisioned url through composeHarness and records unauthenticated `tools/list` (relative import of connectors enumerator from the test only; worker package.json untouched).
  - `test/e4-liveness.test.ts` — MCP-path liveness + mutation added; existing Read liveness kept.
  - `test/executeRun.test.ts` — connector mount + source assertion that `attachMcpServersToQuery` is not called from the worker.
  - `test/fixtures.ts` — fake Gmail MCP transport, inbox-triage queryFn, gmail broker deps (send registered at T3 / role max T1).

  **Live half (not faked)**
  `OIK_SECRET_MCP_GMAIL_URL` set (len=38); `OIK_SECRET_GMAIL_OAUTH_REFRESH_TOKEN` unset. Live test ran: composeHarness received `gmail` http server; `tools/list` returned a non-empty `mcp__gmail__*` surface. Authenticated send/reply/forward re-enumeration still blocked on the missing refresh token (TASK-083 non-goal); the governed T0/T1/T3 chain is proven on the fake transport + real `handlePreToolUse`.

  **Test_Evidence**
  - `pnpm --filter @oikonomos/worker test` — 7 files, 25/25 pass (incl. live mount + DATABASE_URL lifecycle).
  - `pnpm --filter @oikonomos/worker typecheck` — exit 0.
  - `pnpm lint` — exit 0.
  - `pnpm canaries` — 17/17 pass.
  - `pnpm -r test` — exit 0.

  Ready for review.
