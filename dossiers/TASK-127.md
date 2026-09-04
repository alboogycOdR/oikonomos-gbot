# TASK-127 — Gmail connector session minter (Connectors-1a)

Unit: S5. Strict mode (control.mode=strict) — dossier is the heartbeat, PLAN.md never touched.

## Preflight (paste, verbatim)

```
[preflight] TASK-127 Owned_Paths inspected in E:/DELL-PROJECTS/GROKBOT-CLONE
[preflight] 3 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
  GLOB   packages/connectors/src/mcp/**  -> 7 file(s):
           packages/connectors/src/mcp/envSecretResolver.ts
           packages/connectors/src/mcp/errors.ts
           packages/connectors/src/mcp/fromManifest.ts
           packages/connectors/src/mcp/index.ts
           packages/connectors/src/mcp/oauthTokenProvider.test.ts
           packages/connectors/src/mcp/oauthTokenProvider.ts
           packages/connectors/src/mcp/types.ts
  GLOB   packages/connectors/src/sessions/**  -> 4 file(s):
           packages/connectors/src/sessions/index.ts
           packages/connectors/src/sessions/pool.test.ts
           packages/connectors/src/sessions/pool.ts
           packages/connectors/src/sessions/types.ts
  FILE   packages/connectors/src/index.ts  -> exists, 58 line(s), 1675 bytes
[preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
```

## Work Log

- [2026-09-04T10:10:00Z] [S5] Session start. Checkpoint file (.devteam/CHECKPOINT.md) was stale — referenced TASK-122, already merged (confirmed via PLAN.md: TASK-122 Review_Findings APPROVE, merged --no-ff). Deleted checkpoint. Confirmed via PLAN.md that TASK-127 (`Status: claimed`, `Assigned_To: S5`) is the real active task per dispatch prompt. Created branch `task/TASK-127-s5` off `mainco/master` (no prior branch existed — fresh start, not a resume). Ran preflight (above): all three Owned_Paths entries exist as expected, matching the task description's claim that the low-level primitives are already built.
- [2026-09-04T10:10:00Z] [S5] Read `fromManifest.ts`, `oauthTokenProvider.ts`, `mcp/types.ts`, `sessions/types.ts`, `sessions/pool.ts`, `mcp/index.ts`, top-level `index.ts`, `manifests/gmail.yaml`, `manifest/schema.ts`, `manifest/load.ts`, and both existing test files (`oauthTokenProvider.test.ts`, `pool.test.ts`) to match established patterns (runtime-assembled URL/secret literals so `mcp src — no secret literals` test stays green; fake resolver/fetch pattern; `Object.freeze` on returned configs).
- [2026-09-04T10:10:00Z] [S5] Implemented `packages/connectors/src/mcp/gmailSessionMinter.ts`: `createGmailConnectorSessionMinter(options)` composes `mcpConfigFromManifest` (resolves the manifest's `mcp_server.url_ref`) with `createGmailOAuthTokenProvider` (lazily built once per minter instance, then reused — the provider's own internal cache/refresh handles subsequent near-expiry refreshes) into a `ConnectorSessionMinter` (`(input) => Promise<McpServers>`) shaped for `createConnectorSessionPool({ mint })`. Returns `{ [serverName]: { transport: "http", url, headers: { authorization: "Bearer <token>" } } }`, frozen. `serverName` defaults to `manifest.mcp_server.name`, overridable.
- [2026-09-04T10:10:00Z] [S5] Exported `createGmailConnectorSessionMinter` + its options type from `packages/connectors/src/mcp/index.ts`, and re-exported it (plus `createGmailOAuthTokenProvider`, `mcpConfigFromManifest`, and the mcp type surface — none of which were previously reachable from the package barrel) from `packages/connectors/src/index.ts`, per acceptance criterion #3.
- [2026-09-04T10:10:00Z] [S5] Wrote `packages/connectors/src/mcp/gmailSessionMinter.test.ts` (5 tests, fake resolver + fake `fetch`, all secret/token literals assembled at runtime via `.join("")` to satisfy the existing "mcp src — no secret literals" sweep test): (1) produces the expected `McpHttpServerConfig` with bearer token; (2) respects a custom `serverName`; (3) reuses the token provider across mint calls — oauth secrets resolved once (3 calls), token exchange happens once (fetch called once), proving no redundant secret resolution per acquire; (4) works passed directly into `createConnectorSessionPool({ mint })` — `acquire` returns a handle whose `mcpServers.gmail` carries the auth header; (5) a mint failure (empty client secret) throws without leaking the client secret, refresh token, or access token into the error's message/JSON/stack.
- [2026-09-04T10:10:00Z] [S5] Test evidence: `pnpm --filter @oikonomos/connectors test` → 13 files, 119 passed / 4 skipped (0 failed) — includes the new file and the pre-existing "no secret literals" sweep, both green. `pnpm -r build` → 17/17 packages, tsc clean, no type errors. `pnpm lint` → clean (no output/errors). `pnpm -r test` (full recursive suite, per CLAUDE.md's DEVDEPARTMENT amendment) → every package green, zero failures, no flake this run (checked `grep -i fail` on full log — all hits were test-name substrings like "fails a run", none were an actual failure/error report).
- [2026-09-04T10:10:00Z] [S5] Manual N4 check on the diff (all 4 changed/new files): grepped `packages/connectors/src/index.ts`, `packages/connectors/src/mcp/index.ts`, `packages/connectors/src/mcp/gmailSessionMinter.ts`, `packages/connectors/src/mcp/gmailSessionMinter.test.ts` — no literal token, client secret, refresh token, or bearer header value anywhere; all test fixtures assembled via `.join("")` sentinels exactly matching the established `oauthTokenProvider.test.ts` convention. Acceptance criterion #4 verified directly, not just asserted.
- [2026-09-04T10:10:00Z] [S5] All 5 acceptance criteria met. Handing off `needs_review`. Territory: only files under Owned_Paths touched (`packages/connectors/src/mcp/gmailSessionMinter.ts` new, `packages/connectors/src/mcp/gmailSessionMinter.test.ts` new, `packages/connectors/src/mcp/index.ts` modified, `packages/connectors/src/index.ts` modified) plus this dossier.

## Acceptance criteria — self-check

- [x] `createGmailConnectorSessionMinter` produces an `McpHttpServerConfig` with a real (test-fixture) bearer token in `headers.authorization`, tested with a fake resolver/fetch
- [x] The minter's shape satisfies `ConnectorSessionMinter` and works when passed directly into `createConnectorSessionPool({ mint })` — tested (acquire returns a handle whose `mcpServers` carries the auth header)
- [x] `mcpConfigFromManifest`, `createGmailOAuthTokenProvider`, and the new minter are exported from `packages/connectors/src/index.ts`
- [x] No test, fixture, log statement, or error message anywhere in this diff contains a literal token, client secret, or resolved header value — reviewed directly, not just asserted
- [x] `pnpm -r test`, `pnpm -r build`, `pnpm lint` all exit 0

## Next step (if reworked)

None outstanding — awaiting review. If ORCH requests a different composition shape (e.g. accepting a pre-built `OAuthTokenProvider` instead of always constructing one from `oauth` options), that would be a small refactor to `CreateGmailConnectorSessionMinterOptions` and the internal `tokenProvider()` lazy-init, not a redesign.
