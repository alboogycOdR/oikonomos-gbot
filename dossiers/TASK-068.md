# TASK-068 — packages/connectors — server-set-keyed enumeration cache with stale-while-revalidate

## Brief
Grok Bot's `tools-discovery.ts` (study §Tier 2): cache key = sorted server-name set joined on a separator; entries record requested vs resolved key (race-safe); TTL'd stale-while-revalidate; `getToolsForTurnStart()` never blocks a run start. Partial-failure: one server degrades that server only; sole-source failure is an error, not an empty success. Cache feeds enumeration/reporting only — allowedTools and TASK-066 broker re-check keep consuming the manifest map.

## Spec pointers
- docs/STUDY-grok-bot-018.md §Tier 2 (tools-discovery pattern); SWR keyed by server-set
- WBS OIK-049
- TASK-054 live `listTools` adapter (wrap, do not modify)
- TASK-066: call-time re-check stays on the manifest map, never a cached live listing

## Work Log

- [2026-09-01T13:10:00Z] [GB] Start on claimed TASK-068. control.mode=strict: no PLAN.md writes. Created `task/TASK-068-gb` from master `de785f5`. Preflight (c8b9872 filesystem check):
  ```
  [preflight] TASK-068 Owned_Paths inspected in E:/DELL-PROJECTS/wt-grok-GROKBOT-CLONE
  [preflight] 2 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    GLOB   packages/connectors/src/discovery-cache/**  -> matches nothing yet (new territory)
    NEW    packages/connectors/test/discovery-cache.test.ts  -> does not exist; parent packages/connectors/test/ exists
  ```
  New territory is expected (cache module does not exist yet). Barrel `packages/connectors/src/index.ts` is outside Owned_Paths — tests will import from `src/discovery-cache/` directly. Next: implement server-set key + SWR cache in front of TASK-054 `listTools`, with injected clock/transport.

- [2026-09-01T13:17:20Z] [GB] Implementation complete on `task/TASK-068-gb`. Territory: only `packages/connectors/src/discovery-cache/**`, `packages/connectors/test/discovery-cache.test.ts`, and this dossier. Barrel `src/index.ts` untouched.

  **Layering (ADR-001 / TASK-054 / TASK-066):** this cache feeds **enumeration/reporting only**. `allowedToolsFor` derivation and the broker call-time re-check (`recheckAgainstManifest`) keep consuming the **manifest map**, never a cached live listing. `DISCOVERY_CACHE_LAYER.feedsAllowlist` and `feedsBrokerRecheck` are pinned `false`. Snapshots have `purpose: "enumeration-reporting"` and no `allowedTools` field. Empty live listing → empty allowlist (does not fail-open to the manifest set). Sole-source failure throws `DiscoveryError` (`SOLE_SOURCE_FAILED`), not an empty success.

  **Code** (`packages/connectors/src/discovery-cache/`)
  - `key.ts` — sorted unique server-name set joined on `\0`; order-insensitive; add/remove is a distinct key.
  - `cache.ts` — `createDiscoveryCache` in front of TASK-054 `listTools` (injected per-server transport + clock + schedule). Entries record `requestedKey` vs `resolvedKey` (mid-flight config change is not misattributed). TTL SWR: expiry serves stale and kicks refresh; refresh failure serves stale (`atMs=0`) and schedules one re-fetch. `getToolsForTurnStart` never awaits `listTools` (cold start: empty + background warm). Partial failure: one server degrades that server only; sole/all-source failure throws.
  - `types.ts` / `errors.ts` / `index.ts` — public API. `enumeratorsFrom` binds TASK-054 `ToolLister` records.

  **Tests** (`packages/connectors/test/discovery-cache.test.ts`) — 19 tests covering all ACs, injected clock, fake MCP HTTP mount wrapping `createHttpMcpToolEnumerator`.

  **Test_Evidence**
  - `pnpm --filter @oikonomos/connectors test -- test/discovery-cache.test.ts` — 19/19 pass.
  - `pnpm --filter @oikonomos/connectors test` (via `pnpm -r test`) — 101 passed | 4 skipped (105), 10 files.
  - `pnpm -r test` — exit 0.
  - `pnpm lint` — exit 0.
  - `pnpm canaries` — 15 passed | 2 skipped (17).
  - `pnpm --filter @oikonomos/connectors typecheck` — exit 0.

  Ready for review.
