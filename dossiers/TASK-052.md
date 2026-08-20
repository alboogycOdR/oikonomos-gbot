# TASK-052 - Live MCP server mount in composeHarness (PROTECTED)

## Brief
`ComposeOptions` has **no MCP surface at all** - that is why zero connectors are live despite Gmail being "onboarded". Add `mcpServers` to `composeHarness` (and nowhere else, N9) so `mcp__*` tools exist at runtime, and prove they traverse L1 exactly like built-in tools.

## Spec pointers
- ADR-001 - L1 PreToolUse is *the* enforcement point; an MCP tool is not a special case and must not get its own path.
- OIK-033 / N9 - composeHarness is the sole harness constructor. The SDK option is set there only.
- N4 - secrets arrive pre-resolved from the caller (TASK-053 resolves them); this package never reads env, never logs config, and no error message echoes a url/header value.

## Intended approach
`src/mcp/` holds the config types; thread `mcpServers` through `composeHarness` into the SDK options object. Test with a **fake in-process MCP transport** - no network, no credentials. The decisive test is an L1 deny of an `mcp__*` call actually preventing it; the decisive mutation is bypassing L1 for `mcp__` names.

**Protected path:** GB or CX only, never S5. If the SDK's MCP surface seems to require changes in `hooks/` or the L1/L2/L3 adapters, BLOCK with SPEC_AMBIGUITY rather than widening territory.

## Work Log

- [2026-08-20T14:25:00Z] [GB] Session start. Preflight (c8b9872 filesystem check):
  ```
  [preflight] TASK-052 Owned_Paths inspected in C:/CLAUDECODE_TOOLSETS/wt-grok-oikonomos
  [preflight] 4 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    GLOB   packages/harness-factory/src/mcp/**  -> matches nothing yet (new territory)
    FILE   packages/harness-factory/src/compose.ts  -> exists, 303 line(s), 9925 bytes
    NEW    packages/harness-factory/test/mcp.test.ts  -> does not exist; parent packages/harness-factory/test/ exists
    FILE   packages/harness-factory/package.json  -> exists, 38 line(s), 818 bytes
  ```
  Branch `task/TASK-052-gb` created from detached HEAD. Implementing mcpServers on ComposeOptions, SDK option attach in composeHarness only, fake in-process MCP in tests. No L1/L2/L3/hooks edits.

- [2026-08-20T14:32:00Z] [GB] Implemented `mcpServers?: Readonly<Record<string, McpServerConfig>>` on ComposeOptions. `src/mcp/` validates stdio|http (never reads env, never echoes url/header values), maps to SDK `{type,command/url,args/headers}`, and `composeHarness` is the only caller of `attachMcpServersToQuery`. Fake in-process MCP in tests: L1 deny of `mcp__fake__list` prevents the fake handler; bypassing L1 for `mcp__*` lets it run (mutation control). Broker throw/deny matches built-in Read (N3).

- [2026-08-20T14:33:00Z] [GB] Tests: `pnpm --filter @oikonomos/harness-factory test` 79/79 (existing 66 + 13 mcp, zero assertions removed). `pnpm lint` exit 0. `pnpm -r test` exit 0. `pnpm canaries` 15 passed | 2 skipped (17). Ready for review.
