# TASK-053 - Manifest to MCP server config (secret refs, never literals)

## Brief
Convert a validated manifest's `mcp_server` block into the `McpServerConfig` shape TASK-052 added, resolving `url_ref: secret://...` through an injected `SecretResolver` port.

## Spec pointers
- Build Handover 4.4 - `mcp_server: { name, transport, url_ref: secret://mcp/gmail/url }`. The manifest carries a *reference*, never a value.
- N4 - no credential in prompts, logs, audit payloads, or fixtures. An unset secret throws naming the **ref**, never the value.
- N5 - refuse to build a config for a non-`basileia` manifest (defence in depth; the validator already rejects it).

## Intended approach
Default resolver maps `secret://mcp/gmail/url` to `OIK_SECRET_MCP_GMAIL_URL`. Fail closed on empty resolution. Mutation to run: make the unset-secret path return an empty config instead of throwing - a test must go red.

## Work Log

- [2026-08-23T21:05:00Z] [GB] Session start on claimed branch `task/TASK-053-gb` (created from detached HEAD a23f0bc). control.mode=strict: no PLAN.md writes. Preflight (c8b9872 filesystem check):
  ```
  [preflight] TASK-053 Owned_Paths inspected in C:/CLAUDECODE_TOOLSETS/wt-grok-oikonomos
  [preflight] 2 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    GLOB   packages/connectors/src/mcp/**  -> matches nothing yet (new territory)
    NEW    packages/connectors/test/mcp.test.ts  -> does not exist; parent packages/connectors/test/ exists
  ```
  NEW territory is expected (TASK-052 lives in harness-factory). Implementing `mcpConfigFromManifest` + injected `SecretResolver` + env default under `packages/connectors/src/mcp/**`. Will not touch `packages/connectors/src/index.ts` (outside Owned_Paths); tests import the new module directly. Handover `transport: remote` maps to TASK-052 `transport: "http"`.

- [2026-08-23T21:12:00Z] [GB] Implemented `packages/connectors/src/mcp/**`:
  - `mcpConfigFromManifest(manifest, {resolve})` → frozen `{ transport: "http", url }` (TASK-052 McpHttpServerConfig). Handover `remote` and native `http` both map; other transports throw `UNSUPPORTED_TRANSPORT`.
  - Injected `SecretResolver` port (`resolve(ref): Promise<string>`). Default `envSecretResolver` maps `secret://mcp/gmail/url` → `OIK_SECRET_MCP_GMAIL_URL` and throws `McpManifestConfigError` (`SECRET_UNSET`) naming the REF, never a value.
  - Empty resolution → `SECRET_EMPTY`. Non-`basileia` ownership refuses before resolve (N5). Generic resolver throws are wrapped without echoing the cause (N4).
  - Did not re-validate `url_ref` as `secret://` (TASK-043 already does). Did not add `@oikonomos/harness-factory` (package.json outside territory); types are structural copies of TASK-052.

- [2026-08-23T21:12:30Z] [GB] Tests (`packages/connectors/test/mcp.test.ts`, 16 tests): shape + injected port; unset names REF not value; empty fail-closed; N4 serialization/logs/source; N5 non-basileia (resolver not called); env default round-trip. Sentinel URL assembled at runtime (N4). MUTATION-PROVEN: replacing the unset throw with `return { transport: "http", url: "" }` reddens `does not return an empty config on the unset path` (`promise resolved "{ transport: 'http', url: '' }" instead of rejecting`). Mutation reverted.

- [2026-08-23T21:13:00Z] [GB] Test evidence:
  - `pnpm --filter @oikonomos/connectors test` — 7 files, 50/50 pass (16 new mcp).
  - `pnpm --filter @oikonomos/connectors typecheck` — exit 0.
  - `pnpm lint` — exit 0.
  - `pnpm canaries` — 15 passed | 2 skipped (17).
  - `pnpm -r test` — connectors 50/50; all other packages that finished were green except **pre-existing** `services/control-api` `test/decide.route.test.ts` (4 failures, 400 vs 200/409). Outside Owned_Paths; not introduced by this task (TASK-056 merge surface). Recursive run exits 1 because of that package. Flagged for ORCH.

- [2026-08-23T21:13:30Z] [GB] Ready for review. Note for ORCH merge wiring: `packages/connectors/src/index.ts` is outside territory so `mcpConfigFromManifest` is not yet re-exported from `@oikonomos/connectors`. Tests import `../src/mcp/index.js`.
